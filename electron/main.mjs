import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
} from "electron";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./codex-client.mjs";
import {
  downloadArxivPaper,
  loadLibrary,
  prepareConversationContext,
  prepareRecommendationPreview,
  readPdfFile,
  saveRecommendationThumbnail,
  saveLibrary,
  savePageImage,
  savePaperContext,
} from "./paper-services.mjs";
import { fetchRecommendations } from "./recommendations.mjs";
import { windowsSystemFetch } from "./windows-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = "io.github.siik7.paperocean";
const WINDOW_COLORS = {
  dark: { background: "#0d1015", chrome: "#0e1218", symbols: "#d6dee8" },
  light: { background: "#f2f0ea", chrome: "#f7f5ef", symbols: "#27323c" },
};
const MIN_WINDOW_WIDTH = 1180;
const MIN_WINDOW_HEIGHT = 720;
const IDEAL_WINDOW_WIDTH = 1680;
const IDEAL_WINDOW_HEIGHT = 980;
const codex = new CodexClient();
const localMedia = new Map();
const systemFetch = process.platform === "win32"
  ? windowsSystemFetch
  : (url, options) => net.fetch(url, options);

protocol.registerSchemesAsPrivileged([{
  scheme: "paper-ocean",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

function windows() {
  return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
}

function broadcastCodexEvent(payload) {
  for (const window of windows()) window.webContents.send("codex:event", payload);
}

codex.on("event", broadcastCodexEvent);
codex.on("diagnostic", (params) => broadcastCodexEvent({ method: "paperOcean/diagnostic", params }));

function initialWindowSize() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(IDEAL_WINDOW_WIDTH, width - 40)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(IDEAL_WINDOW_HEIGHT, height - 40)),
  };
}

function platformWindowOptions(resolvedTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light") {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      titleBarOverlay: { height: 68 },
      trafficLightPosition: { x: 18, y: 26 },
    };
  }

  if (process.platform === "win32") {
    const colors = WINDOW_COLORS[resolvedTheme];
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: colors.chrome,
        symbolColor: colors.symbols,
        height: 48,
      },
    };
  }

  return {};
}

function platformWindowChromeCss() {
  const platformSafeArea = process.platform === "darwin"
    ? ".app-header { padding-left: 96px !important; }"
    : process.platform === "win32"
      ? ".app-header { padding-right: 164px !important; }"
      : "";

  return `
    html, body { background: var(--bg); }

    .app-header,
    .paper-titlebar {
      -webkit-app-region: drag;
    }

    .app-header :is(button, input, select, textarea, a, label, form),
    .paper-titlebar :is(button, input, select, textarea, a, label, form) {
      -webkit-app-region: no-drag;
    }

    ${platformSafeArea}
  `;
}

function createWindow(resolvedTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light") {
  const size = initialWindowSize();
  const initialColors = WINDOW_COLORS[resolvedTheme];
  const window = new BrowserWindow({
    ...size,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: initialColors.background,
    title: "Paper Ocean",
    autoHideMenuBar: true,
    ...platformWindowOptions(resolvedTheme),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
    },
  });

  let chromeReady = false;
  let rendererReady = false;
  const revealWindow = () => {
    if (chromeReady && rendererReady && !window.isDestroyed()) window.show();
  };

  window.once("ready-to-show", () => {
    rendererReady = true;
    revealWindow();
  });

  window.webContents.on("did-finish-load", async () => {
    try {
      await window.webContents.insertCSS(platformWindowChromeCss());
    } catch (error) {
      console.error("Failed to install native window chrome styles", error);
    } finally {
      chromeReady = true;
      revealWindow();
    }
  });

  const devUrl = process.env.PAPER_OCEAN_DEV_URL;
  if (devUrl) {
    const themedDevUrl = new URL(devUrl);
    themedDevUrl.searchParams.set("paperOceanTheme", resolvedTheme);
    window.loadURL(themedDevUrl.toString());
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
      query: { paperOceanTheme: resolvedTheme },
    });
  }
}

async function setApplicationTheme(value, { persist = true } = {}) {
  const theme = value === "light" ? "light" : "dark";
  const colors = WINDOW_COLORS[theme];
  nativeTheme.themeSource = theme;
  for (const window of windows()) {
    window.setBackgroundColor(colors.background);
    if (process.platform === "win32") {
      window.setTitleBarOverlay({
        color: colors.chrome,
        symbolColor: colors.symbols,
        height: 48,
      });
    }
  }
  if (persist) {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(userDataPath("theme.txt"), theme, "utf8");
  }
  return theme;
}

async function loadThemePreference() {
  try {
    const value = (await fs.readFile(userDataPath("theme.txt"), "utf8")).trim();
    return value === "light" || value === "dark"
      ? value
      : nativeTheme.shouldUseDarkColors ? "dark" : "light";
  } catch {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }
}

function exposeLocalMedia(filePath, rootDir) {
  const resolved = assertWithin(rootDir, filePath, "本地预览文件");
  const token = createHash("sha256").update(resolved).digest("hex");
  localMedia.set(token, resolved);
  return `paper-ocean://media/${token}`;
}

function registerLocalMediaProtocol() {
  protocol.handle("paper-ocean", async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === "media" ? url.pathname.slice(1) : "";
    const filePath = /^[a-f0-9]{64}$/.test(token) ? localMedia.get(token) : undefined;
    if (!filePath || !existsSync(filePath)) {
      return new Response("Preview not found", { status: 404 });
    }
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".pdf"
      ? "application/pdf"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
    return new Response(await fs.readFile(filePath), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": extension === ".pdf" ? "private, no-store" : "private, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });
}

function userDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

async function loadCodexPathPreference() {
  try {
    const executable = (await fs.readFile(userDataPath("codex-path.txt"), "utf8")).trim();
    if (executable && existsSync(executable)) await codex.setExecutable(executable);
  } catch {
    // Automatic discovery remains active when no manual preference exists.
  }
}

async function chooseCodexExecutable() {
  const result = await dialog.showOpenDialog({
    title: "选择 Codex 命令行程序",
    properties: ["openFile"],
    filters: process.platform === "win32"
      ? [{ name: "Codex", extensions: ["exe", "cmd"] }]
      : undefined,
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const executable = await codex.setExecutable(result.filePaths[0]);
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(userDataPath("codex-path.txt"), executable, "utf8");
  return codex.account();
}

function assertWithin(baseDir, candidate, label) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(String(candidate || ""));
  const prefix = `${base}${path.sep}`;
  if (resolved !== base && !resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error(`${label}不在 Paper Ocean 数据目录中`);
  }
  return resolved;
}

function checkedCodexInput(input, { image = false } = {}) {
  const contextRoot = userDataPath("research-contexts");
  const contextDir = assertWithin(contextRoot, input.contextDir, "研究上下文目录");
  const result = { ...input, contextDir };
  if (Array.isArray(input.entries)) {
    result.entries = input.entries.map((entry, index) => ({
      key: String(entry?.key || `context-${index}`).slice(0, 120),
      path: assertWithin(contextDir, entry?.path, "上下文文件"),
      kind: entry?.kind === "untrusted" ? "untrusted" : "application",
    }));
  }
  if (image && input.pageImagePath) {
    result.pageImagePath = assertWithin(userDataPath("papers"), input.pageImagePath, "页面图片");
  }
  if (typeof input.selectedText === "string" && input.selectedText.trim()) {
    result.selectedText = input.selectedText.slice(0, 20_000);
  } else {
    delete result.selectedText;
  }
  return result;
}

function registerIpc() {
  ipcMain.handle("paper:open", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择论文 PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF 论文", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readPdfFile(result.filePaths[0]);
  });

  ipcMain.handle("paper:reopen", (_event, filePath) => readPdfFile(filePath));
  ipcMain.handle("paper:open-url", (_event, url) => (
    downloadArxivPaper(url, userDataPath("imports"), systemFetch)
  ));
  ipcMain.handle("paper:save-context", (_event, input) => (
    savePaperContext(app.getPath("userData"), input)
  ));
  ipcMain.handle("paper:save-page-image", (_event, input) => (
    savePageImage(app.getPath("userData"), input)
  ));
  ipcMain.handle("paper:prepare-conversation", (_event, input) => (
    prepareConversationContext(app.getPath("userData"), input)
  ));

  ipcMain.handle("app:open-external", async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接");
    await shell.openExternal(parsed.toString());
  });
  ipcMain.handle("app:set-theme", (_event, theme) => setApplicationTheme(theme));

  ipcMain.handle("library:load", () => loadLibrary(userDataPath("library.json")));
  ipcMain.handle("library:save", (_event, state) => saveLibrary(userDataPath("library.json"), state));

  ipcMain.handle("recommendations:fetch", (_event, input) => fetchRecommendations(input, systemFetch));
  ipcMain.handle("recommendations:prepare-preview", async (_event, arxivId) => {
    const result = await prepareRecommendationPreview(
      arxivId,
      userDataPath("imports"),
      userDataPath("cache", "recommendation-thumbnails"),
      systemFetch,
    );
    if (result.status === "ready") {
      return {
        status: "ready",
        imageUrl: exposeLocalMedia(result.thumbnailPath, userDataPath("cache", "recommendation-thumbnails")),
      };
    }
    if (result.status === "render") {
      return {
        status: "render",
        pdfUrl: exposeLocalMedia(result.pdfPath, userDataPath("imports")),
      };
    }
    return { status: "missing", reason: result.reason };
  });
  ipcMain.handle("recommendations:save-thumbnail", async (_event, input) => {
    const saved = await saveRecommendationThumbnail(
      userDataPath("cache", "recommendation-thumbnails"),
      input,
    );
    return exposeLocalMedia(saved.thumbnailPath, userDataPath("cache", "recommendation-thumbnails"));
  });

  ipcMain.handle("codex:status", async () => {
    try {
      return await codex.account();
    } catch (error) {
      return {
        connected: false,
        accountType: null,
        planType: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle("codex:login", async () => {
    const result = await codex.login();
    if (result?.authUrl) await shell.openExternal(result.authUrl);
    return result;
  });
  ipcMain.handle("codex:models", () => codex.models({ force: true }));
  ipcMain.handle("codex:choose-executable", () => chooseCodexExecutable());
  ipcMain.handle("codex:rate-limits", () => codex.rateLimits());
  ipcMain.handle("codex:start-thread", (_event, input) => codex.startThread(checkedCodexInput(input)));
  ipcMain.handle("codex:resume-thread", (_event, input) => codex.resumeThread(checkedCodexInput(input)));
  ipcMain.handle("codex:send-turn", (_event, input) => codex.sendTurn(checkedCodexInput(input, { image: true })));
  ipcMain.handle("codex:interrupt", (_event, input) => codex.interrupt(input));
}

app.whenReady().then(async () => {
  app.setAppUserModelId(APP_ID);
  nativeTheme.themeSource = "system";
  registerLocalMediaProtocol();
  const [, resolvedTheme] = await Promise.all([
    loadCodexPathPreference(),
    loadThemePreference().then((theme) => setApplicationTheme(theme, { persist: false })),
  ]);
  registerIpc();
  createWindow(resolvedTheme);

  app.on("activate", () => {
    if (!windows().length) createWindow();
  });
});

app.on("window-all-closed", () => {
  codex.stop().catch(() => undefined);
  if (process.platform !== "darwin") app.quit();
});
