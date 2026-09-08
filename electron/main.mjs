import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  screen,
  safeStorage,
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
  recoverLibrary,
  flushLibraryWrites,
  prepareConversationContext,
  prepareRecommendationPreview,
  readPdfFile,
  manageOriginal,
  reopenManagedPdf,
  readPaperIndex,
  cachedPageImage,
  saveRecommendationThumbnail,
  saveLibrary,
  savePageImage,
  savePaperContext,
} from "./paper-services.mjs";
import { createRecommendationService } from "./recommendation-cache.mjs";
import { createDownloadJobs } from "./download-jobs.mjs";
import { windowsSystemFetch } from "./windows-fetch.mjs";
import { validateConversationPapers } from "./conversations.mjs";
import { createPaperSearch } from "./paper-search.mjs";
import { createPaperArchive, defaultArchiveDirectory } from "./paper-archive.mjs";
import { createPoolSync } from "./pool-sync.mjs";

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
const closeRequests = new WeakMap();
const downloadJobs = createDownloadJobs();
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  const existing = windows()[0];
  if (existing?.isMinimized()) existing.restore();
  existing?.focus();
});
const systemFetch = process.platform === "win32"
  ? windowsSystemFetch
  : (url, options) => net.fetch(url, options);
const paperSearch = createPaperSearch({ fetcher: systemFetch });
let paperArchive;

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
  const closing = { allowed: false, pending: false, timer: undefined };
  closeRequests.set(window, closing);
  window.on("close", (event) => {
    if (closing.allowed || !rendererReady) return;
    event.preventDefault();
    if (closing.pending) return;
    closing.pending = true;
    window.webContents.send("library:before-close");
    closing.timer = setTimeout(async () => {
      if (window.isDestroyed() || !closing.pending) return;
      closing.pending = false;
      const result = await dialog.showMessageBox(window, {
        type: "warning", title: "仍在等待保存", message: "阅读窗口暂时没有完成保存。",
        detail: "可以返回阅读后重试。直接关闭会丢失尚未保存的改动，已保存的资料会保留。",
        buttons: ["返回阅读", "直接关闭"], defaultId: 0, cancelId: 0,
      });
      if (result.response === 1 && !window.isDestroyed()) {
        closing.allowed = true;
        window.destroy();
      }
    }, 15_000);
  });
  window.once("closed", () => clearTimeout(closing.timer));
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
  if (image && Array.isArray(input.pageImages)) result.pageImages = input.pageImages.slice(0, 3).map((item) => {
    const filePath = assertWithin(userDataPath("papers"), item.path, "页面图片");
    const page = Number(item.page);
    const paperId = String(item.paperId || "");
    if (!Number.isInteger(page) || page < 1 || page > 10_000 || path.basename(filePath) !== `evidence-v1-page-${page}.png` || path.basename(path.dirname(filePath)) !== paperId) throw new Error("页图与论文证据不匹配");
    return { path: filePath, paperId, page };
  });
  if (typeof input.selectedText === "string" && input.selectedText.trim()) {
    result.selectedText = input.selectedText.slice(0, 20_000);
  } else {
    delete result.selectedText;
  }
  return result;
}

function registerIpc() {
  const pool = createPoolSync({
    directory: app.getPath("userData"), loadLibrary: () => loadLibrary(userDataPath("library.json")),
    fetcher: (url, options) => net.fetch(url, options),
    encodeSecret: secret => {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error("系统密钥环不可用，请启用系统密码钥匙串后保存同步密码");
      return safeStorage.encryptString(secret).toString("base64");
    },
    decodeSecret: encrypted => safeStorage.decryptString(Buffer.from(encrypted, "base64")),
  });
  ipcMain.handle("pool:status", () => pool.status());
  ipcMain.handle("pool:sync", () => pool.run());
  ipcMain.handle("pool:configure", (_event, input) => pool.configure(input));
  const poolTimer = setInterval(() => pool.schedule(), 60000); poolTimer.unref();
  pool.schedule();
  app.once("will-quit", () => { clearInterval(poolTimer); void pool.stop(); });
  paperArchive = createPaperArchive({
    directory: defaultArchiveDirectory(), metadataFile: userDataPath("paper-archive.json"),
    sourceForPaper: async (paper) => {
      const managed = userDataPath("originals", `${paper.id}.pdf`);
      return existsSync(managed) ? managed : paper.path;
    },
    textForPaper: async (paper) => ((await readPaperIndex(app.getPath("userData"), paper.id)) || []).slice(0, 3).map(page => page.text).join("\n"),
  });
  const syncArchive = async () => { await paperArchive.schedule(await loadLibrary(userDataPath("library.json")), true); return paperArchive.status(); };
  ipcMain.handle("papers:search", (_event, query) => paperSearch.search(query));
  ipcMain.handle("papers:resolve-suggestion", (_event, id) => paperSearch.resolve(id));
  ipcMain.handle("archive:status", () => paperArchive.status());
  ipcMain.handle("archive:retry", syncArchive);
  ipcMain.handle("archive:set-category", async (_event, { paperId, category }) => {
    await paperArchive.schedule(await loadLibrary(userDataPath("library.json")));
    return paperArchive.setCategory(paperId, category);
  });
  ipcMain.handle("archive:open-folder", async () => {
    const directory = defaultArchiveDirectory();
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  const withPageIndex = async (opened) => ({ ...opened, cachedPages: await readPaperIndex(app.getPath("userData"), opened.id) });
  ipcMain.handle("paper:open", async (_event, expectedId) => {
    const result = await dialog.showOpenDialog({
      title: "选择论文 PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF 论文", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const opened = await readPdfFile(result.filePaths[0]);
    if (expectedId && opened.id !== expectedId) throw new Error("所选 PDF 与原论文版本不一致。已有讨论和笔记未变更；若是新版，请使用本地 PDF 另行导入。");
    return withPageIndex(await manageOriginal(app.getPath("userData"), opened));
  });

  ipcMain.handle("paper:reopen", async (_event, filePath, expectedId) => withPageIndex(await reopenManagedPdf(app.getPath("userData"), filePath, expectedId)));
  ipcMain.handle("paper:open-url", async (_event, url, requestId) => downloadJobs.run(requestId, url, async (options) => (
    withPageIndex(await manageOriginal(app.getPath("userData"), await downloadArxivPaper(url, userDataPath("imports"), systemFetch, options)))
  )));
  ipcMain.handle("paper:download-status", (_event, id) => downloadJobs.status(id));
  ipcMain.handle("paper:download-cancel", (_event, id) => downloadJobs.cancel(id));
  ipcMain.handle("paper:save-context", (_event, input) => (
    savePaperContext(app.getPath("userData"), input)
  ));
  ipcMain.handle("paper:save-page-image", (_event, input) => (
    savePageImage(app.getPath("userData"), input)
  ));
  ipcMain.handle("paper:cached-page-image", (_event, input) => cachedPageImage(app.getPath("userData"), input.paperId, input.page));
  ipcMain.handle("paper:prepare-conversation", async (_event, input) => {
    validateConversationPapers(await loadLibrary(userDataPath("library.json")), input.scopeKey, input.papers.map((paper) => paper.id));
    return prepareConversationContext(app.getPath("userData"), input);
  });

  ipcMain.handle("app:open-external", async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接");
    await shell.openExternal(parsed.toString());
  });
  ipcMain.handle("app:set-theme", (_event, theme) => setApplicationTheme(theme));

  ipcMain.handle("library:load", async () => { const state = await loadLibrary(userDataPath("library.json")); void paperArchive.schedule(state); return state; });
  ipcMain.handle("library:save", async (_event, state) => { await saveLibrary(userDataPath("library.json"), state); pool.schedule(); void paperArchive.schedule(await loadLibrary(userDataPath("library.json"))); });
  ipcMain.handle("library:recover", async () => { const state = await recoverLibrary(userDataPath("library.json")); void paperArchive.schedule(state, true); return state; });
  ipcMain.handle("library:finish-close", async (event, result) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const closing = window && closeRequests.get(window);
    if (!window || !closing?.pending) return;
    clearTimeout(closing.timer);
    try {
      if (result?.saved !== true) throw new Error(String(result?.error || "阅读记录尚未保存"));
      await flushLibraryWrites(userDataPath("library.json"));
      closing.allowed = true;
      window.close();
    } catch (error) {
      closing.pending = false;
      await dialog.showMessageBox(window, {
        type: "error", title: "阅读记录尚未保存", message: "窗口已保留，请重试保存后关闭。",
        detail: error instanceof Error ? error.message : String(error), buttons: ["返回阅读"],
      });
    }
  });

  const recommendationService = createRecommendationService({ cacheDir: userDataPath("cache", "recommendations"), fetcher: systemFetch });
  ipcMain.handle("recommendations:fetch", (_event, input) => recommendationService.get(input));
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

if (primaryInstance) app.whenReady().then(async () => {
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

app.on("before-quit", (event) => {
  if (!downloadJobs.hasActive()) return;
  event.preventDefault();
  void downloadJobs.close().finally(() => app.quit());
});

app.on("window-all-closed", async () => {
  await Promise.allSettled([codex.stop(), downloadJobs.close(), paperArchive?.flush()]);
  if (process.platform !== "darwin") app.quit();
});
