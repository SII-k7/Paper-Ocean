import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { CodexClient } from "../electron/codex-client.mjs";
import {
  downloadArxivPaper,
  importPdfBuffer,
  loadLibrary,
  prepareConversationContext,
  prepareRecommendationPreview,
  saveLibrary,
  savePageImage,
  savePaperContext,
  saveRecommendationThumbnail,
} from "../electron/paper-services.mjs";
import { fetchRecommendations } from "../electron/recommendations.mjs";
import { windowsSystemFetch } from "../electron/windows-fetch.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5173;
const MAX_JSON_BYTES = 24 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 10_000;
const EVENT_BUFFER_SIZE = 500;
const PAPER_HANDLE_PATTERN = /^paper:([a-f0-9]{24})$/;
const CONTEXT_HANDLE_PATTERN = /^context:([a-f0-9]{24})$/;
const THREAD_HANDLE_PATTERN = /^thread:[A-Za-z0-9_-]{32}$/;
const ALLOWED_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const OUTBOUND_HOSTS = new Set([
  "arxiv.org",
  "export.arxiv.org",
  "api.openalex.org",
  "api.crossref.org",
  "api.semanticscholar.org",
]);
const OUTBOUND_REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_OUTBOUND_REDIRECTS = 6;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanPaperId(value, label = "论文 ID") {
  const id = String(value || "");
  if (!/^[a-f0-9]{24}$/.test(id)) throw httpError(400, `${label}无效`);
  return id;
}

function cleanCodexId(value, label = "Codex ID") {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(id)) throw httpError(400, `${label}无效`);
  return id;
}

function cleanModel(value) {
  const model = String(value || "");
  if (!ALLOWED_MODELS.has(model)) throw httpError(400, "模型无效");
  return model;
}

function cleanEffort(value) {
  const effort = String(value || "");
  if (!ALLOWED_EFFORTS.has(effort)) throw httpError(400, "思考强度无效");
  return effort;
}

function paperHandle(id) {
  return `paper:${cleanPaperId(id)}`;
}

function paperIdFromHandle(value) {
  const match = String(value || "").match(PAPER_HANDLE_PATTERN);
  if (!match) throw httpError(400, "论文句柄无效");
  return match[1];
}

function contextHandle(id) {
  return `context:${cleanPaperId(id)}`;
}

function contextIdFromHandle(value) {
  const match = String(value || "").match(CONTEXT_HANDLE_PATTERN);
  if (!match) throw httpError(400, "论文上下文无效");
  return match[1];
}

function cleanScopeKey(value) {
  const scopeKey = String(value || "");
  if (scopeKey === "all") return scopeKey;
  const match = scopeKey.match(/^paper:([a-f0-9]{24})$/);
  if (!match) throw httpError(400, "对话范围无效");
  return `paper:${match[1]}`;
}

function cleanText(value, maximum, fallback = "") {
  return typeof value === "string" ? value.slice(0, maximum) : fallback;
}

function validateOutboundUrl(value) {
  let url;
  try {
    url = value instanceof URL
      ? new URL(value.href)
      : new URL(typeof value === "string" ? value : value?.url);
  } catch {
    throw new Error("论文服务地址无效");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !OUTBOUND_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error(`不允许访问该论文服务地址：${url.hostname || "未知主机"}`);
  }
  return url;
}

export async function fetchWithOutboundAllowlist(fetchImplementation, input, options = {}) {
  if (typeof fetchImplementation !== "function") throw new TypeError("网络请求实现无效");
  const method = String(options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new Error(`不支持的论文服务请求：${method}`);
  let current = validateOutboundUrl(input);

  for (let redirects = 0; redirects <= MAX_OUTBOUND_REDIRECTS; redirects += 1) {
    const response = await fetchImplementation(current, {
      ...options,
      method,
      redirect: "manual",
    });
    if (!OUTBOUND_REDIRECTS.has(response.status)) return response;
    if (redirects === MAX_OUTBOUND_REDIRECTS) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new Error(`论文服务重定向超过 ${MAX_OUTBOUND_REDIRECTS} 次`);
    }
    const location = response.headers?.get?.("location");
    if (!location) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new Error("论文服务重定向缺少 Location 地址");
    }
    let redirected;
    try {
      redirected = new URL(location, current);
    } catch {
      await response.body?.cancel?.().catch(() => undefined);
      throw new Error("论文服务重定向地址无效");
    }
    await response.body?.cancel?.().catch(() => undefined);
    current = validateOutboundUrl(redirected);
  }
  throw new Error("论文服务重定向失败");
}

function sameString(left, right) {
  return typeof left === "string" && typeof right === "string" && left === right;
}

function mediaContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".webp": return "image/webp";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function assertRealFileWithin(root, candidate) {
  const resolvedRoot = await fs.realpath(root);
  const resolvedFile = await fs.realpath(candidate);
  if (!inside(resolvedRoot, resolvedFile)) throw httpError(403, "媒体路径不在本地数据目录内");
  const stat = await fs.stat(resolvedFile);
  if (!stat.isFile()) throw httpError(404, "媒体不存在");
  return { filePath: resolvedFile, stat };
}

function publicAccount(account) {
  return {
    connected: Boolean(account?.connected),
    accountType: typeof account?.accountType === "string" ? account.accountType : null,
    planType: typeof account?.planType === "string" ? account.planType : null,
    ...(typeof account?.error === "string" ? { error: account.error.slice(0, 500) } : {}),
  };
}

function normalizeLibrary(state, knownThreadHandles = new Set()) {
  const value = state && typeof state === "object" ? state : {};
  const rawPapers = Array.isArray(value.papers) ? value.papers : [];
  const papers = rawPapers.slice(0, 300).flatMap((paper) => {
    try {
      const id = cleanPaperId(paper?.id);
      if (paper?.path !== paperHandle(id)) return [];
      const paperDir = paper?.paperDir === contextHandle(id) ? contextHandle(id) : undefined;
      return [{
        id,
        name: cleanText(paper?.name, 300, `${id}.pdf`),
        path: paperHandle(id),
        sourceUrl: cleanText(paper?.sourceUrl, 2_000) || undefined,
        arxivId: cleanText(paper?.arxivId, 80) || undefined,
        title: cleanText(paper?.title, 2_000, paper?.name || id),
        abstract: cleanText(paper?.abstract, 50_000) || undefined,
        pageCount: Number.isInteger(paper?.pageCount) && paper.pageCount > 0
          ? Math.min(paper.pageCount, MAX_PAGES)
          : undefined,
        paperDir,
        lastPage: Number.isInteger(paper?.lastPage) && paper.lastPage > 0
          ? Math.min(paper.lastPage, MAX_PAGES)
          : undefined,
        openedAt: Number.isFinite(paper?.openedAt) ? Number(paper.openedAt) : Date.now(),
      }];
    } catch {
      return [];
    }
  });
  const validPaperIds = new Set(papers.map((paper) => paper.id));
  const openPaperIds = (Array.isArray(value.openPaperIds) ? value.openPaperIds : [])
    .filter((id, index, values) => validPaperIds.has(id) && values.indexOf(id) === index)
    .slice(0, 100);
  const messagesByScope = value.messagesByScope && typeof value.messagesByScope === "object"
    ? Object.fromEntries(Object.entries(value.messagesByScope).filter(([key, messages]) => (
      (key === "all" || /^paper:[a-f0-9]{24}$/.test(key)) && Array.isArray(messages)
    )))
    : {};
  const threadsByScope = value.threadsByScope && typeof value.threadsByScope === "object"
    ? Object.fromEntries(Object.entries(value.threadsByScope).filter(([key, handle]) => (
      (key === "all" || /^paper:[a-f0-9]{24}$/.test(key))
      && typeof handle === "string"
      && knownThreadHandles.has(handle)
    )))
    : {};
  const aiSettingsByScope = value.aiSettingsByScope && typeof value.aiSettingsByScope === "object"
    ? Object.fromEntries(Object.entries(value.aiSettingsByScope).filter(([key, selection]) => (
      (key === "all" || /^paper:[a-f0-9]{24}$/.test(key))
      && selection
      && typeof selection === "object"
      && ALLOWED_MODELS.has(selection.model)
      && ALLOWED_EFFORTS.has(selection.effort)
    )))
    : {};
  return {
    papers,
    messagesByScope,
    threadsByScope,
    aiSettingsByScope,
    openPaperIds,
    lastPaperId: validPaperIds.has(value.lastPaperId) ? value.lastPaperId : openPaperIds[0],
  };
}

async function loadThreadMappings(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).flatMap(([handle, threadId]) => (
      THREAD_HANDLE_PATTERN.test(handle)
      && typeof threadId === "string"
      && /^[a-zA-Z0-9_-]{1,180}$/.test(threadId)
        ? [[handle, threadId]]
        : []
    )));
  } catch {
    return new Map();
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function persistPdf(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${randomBytes(8).toString("hex")}.part`;
  try {
    await fs.copyFile(sourcePath, temporary);
    const stat = await fs.stat(temporary);
    if (!stat.isFile() || stat.size <= 4 || stat.size > MAX_PDF_BYTES) throw httpError(400, "PDF 文件大小无效");
    const descriptor = await fs.open(temporary, "r");
    try {
      const magic = Buffer.alloc(4);
      await descriptor.read(magic, 0, 4, 0);
      if (magic.toString() !== "%PDF") throw httpError(400, "所选文件不是有效 PDF");
    } finally {
      await descriptor.close();
    }
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
    await fs.rename(temporary, targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function persistPdfBuffer(buffer, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${randomBytes(8).toString("hex")}.part`;
  try {
    await fs.writeFile(temporary, buffer);
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
    await fs.rename(temporary, targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function createPaperOceanWebServer({
  port = Number(process.env.PAPER_OCEAN_WEB_PORT || DEFAULT_PORT),
  rootDir = fileURLToPath(new URL("..", import.meta.url)),
  dataDir,
  fetcher = globalThis.fetch,
  codex = new CodexClient(),
  viteFactory = createViteServer,
  recommendationsFetcher = fetchRecommendations,
} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("Web 端口无效");
  const safeFetch = (implementation, input, options) => (
    fetchWithOutboundAllowlist(implementation, input, options)
  );
  const networkFetch = process.platform === "win32" && fetcher === globalThis.fetch
    ? async (input, options) => {
      try {
        return await safeFetch(fetcher, input, options);
      } catch (directError) {
        try {
          return await safeFetch(windowsSystemFetch, input, options);
        } catch {
          throw directError;
        }
      }
    }
    : (input, options) => safeFetch(fetcher, input, options);
  if (typeof networkFetch !== "function") throw new Error("当前 Node.js 运行时不支持网络请求");

  const configuredDataDir = dataDir
    ?? process.env.PAPER_OCEAN_WEB_DATA_DIR
    ?? path.join(rootDir, ".paper-ocean-dev");
  const resolvedDataDir = path.resolve(configuredDataDir);
  const importsDir = path.join(resolvedDataDir, "imports");
  const libraryPdfsDir = path.join(resolvedDataDir, "library-pdfs");
  const thumbnailsDir = path.join(resolvedDataDir, "cache", "recommendation-thumbnails");
  const libraryPath = path.join(resolvedDataDir, "library.json");
  const threadMappingsPath = path.join(resolvedDataDir, "thread-handles.json");
  await Promise.all([
    fs.mkdir(importsDir, { recursive: true }),
    fs.mkdir(libraryPdfsDir, { recursive: true }),
    fs.mkdir(thumbnailsDir, { recursive: true }),
  ]);

  const allowedHost = `${HOST}:${port}`;
  const localHostAlias = `localhost:${port}`;
  const allowedHosts = new Set([allowedHost, localHostAlias]);
  const allowedOrigin = `http://${allowedHost}`;
  const allowedOrigins = new Set([allowedOrigin, `http://${localHostAlias}`]);
  const csrfToken = randomBytes(24).toString("base64url");
  const sessionToken = randomBytes(24).toString("base64url");
  const mediaTokens = new Map();
  const conversationContexts = new Map();
  const pageImageHandles = new Map();
  const threadHandles = await loadThreadMappings(threadMappingsPath);
  const realThreadToHandle = new Map([...threadHandles].map(([handle, threadId]) => [threadId, handle]));
  const turnHandles = new Map();
  const realTurnToHandle = new Map();
  const completedTurnHandles = new Set();
  const sseClients = new Set();
  const recentEvents = [];
  let nextEventId = 1;
  let librarySave = Promise.resolve();
  let threadMappingsSave = Promise.resolve();
  let turnStarting = false;
  let activeTurnHandle;
  let vite;

  const issueRandomHandle = (prefix = "") => `${prefix}${randomBytes(24).toString("base64url")}`;
  const requireMapValue = (map, handle, label) => {
    const value = map.get(String(handle || ""));
    if (!value) throw httpError(409, `${label}已失效，请刷新后重试`);
    return value;
  };
  const pdfPathForId = (id) => path.join(libraryPdfsDir, `${cleanPaperId(id)}.pdf`);
  const saveThreadMappings = () => {
    threadMappingsSave = threadMappingsSave
      .catch(() => undefined)
      .then(() => writeJsonAtomic(threadMappingsPath, Object.fromEntries(threadHandles)));
    return threadMappingsSave;
  };
  const registerThread = async (realThreadId, existingHandle) => {
    const cleanRealId = cleanCodexId(realThreadId, "Codex 对话 ID");
    let handle = existingHandle || realThreadToHandle.get(cleanRealId);
    if (!handle) handle = issueRandomHandle("thread:");
    threadHandles.set(handle, cleanRealId);
    realThreadToHandle.set(cleanRealId, handle);
    await saveThreadMappings();
    return handle;
  };
  const requireThread = (handle) => {
    if (!THREAD_HANDLE_PATTERN.test(String(handle || ""))) throw httpError(400, "对话句柄无效");
    return requireMapValue(threadHandles, handle, "对话");
  };
  const turnLookupKey = (threadHandle, realTurnId) => `${threadHandle}\u0000${realTurnId}`;
  const registerTurn = (threadHandle, realTurnId) => {
    const cleanRealId = cleanCodexId(realTurnId, "Codex 回答 ID");
    const key = turnLookupKey(threadHandle, cleanRealId);
    let handle = realTurnToHandle.get(key);
    if (!handle) {
      handle = issueRandomHandle("turn:");
      realTurnToHandle.set(key, handle);
      turnHandles.set(handle, { threadHandle, realTurnId: cleanRealId });
    }
    return handle;
  };
  const exposeMedia = async (candidate) => {
    const { filePath } = await assertRealFileWithin(resolvedDataDir, candidate);
    const token = issueRandomHandle();
    mediaTokens.set(token, filePath);
    return `/api/media/${token}`;
  };
  const browserPaper = async (opened, buffer) => {
    const id = cleanPaperId(opened?.id);
    const targetPath = pdfPathForId(id);
    if (buffer) await persistPdfBuffer(buffer, targetPath);
    else if (path.resolve(opened.path) !== path.resolve(targetPath)) await persistPdf(opened.path, targetPath);
    return { ...opened, path: paperHandle(id) };
  };

  const translateEvent = (event) => {
    if (!event || typeof event !== "object" || typeof event.method !== "string") return null;
    const params = event.params && typeof event.params === "object" ? event.params : {};
    const realThreadId = typeof params.threadId === "string"
      ? params.threadId
      : typeof params.turn?.threadId === "string"
        ? params.turn.threadId
        : typeof params.thread?.id === "string"
          ? params.thread.id
          : undefined;
    const threadHandle = realThreadId ? realThreadToHandle.get(realThreadId) : undefined;
    const realTurnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined;
    if (realThreadId && !threadHandle) return null;
    const turnHandle = threadHandle && realTurnId ? registerTurn(threadHandle, realTurnId) : undefined;
    if (realTurnId && threadHandle && !turnHandle) return null;
    const nextParams = { ...params };
    if (threadHandle && typeof params.threadId === "string") nextParams.threadId = threadHandle;
    if (turnHandle && typeof params.turnId === "string") nextParams.turnId = turnHandle;
    if (params.thread && typeof params.thread === "object") {
      nextParams.thread = { ...params.thread, ...(threadHandle ? { id: threadHandle } : {}) };
    }
    if (params.turn && typeof params.turn === "object") {
      nextParams.turn = {
        ...params.turn,
        ...(threadHandle && typeof params.turn.threadId === "string" ? { threadId: threadHandle } : {}),
        ...(turnHandle ? { id: turnHandle } : {}),
      };
    }
    if (event.method === "turn/completed" && turnHandle) {
      completedTurnHandles.add(turnHandle);
      if (activeTurnHandle === turnHandle) activeTurnHandle = undefined;
    }
    if (event.method === "error" && (!turnHandle || activeTurnHandle === turnHandle)) {
      activeTurnHandle = undefined;
    }
    if (event.method === "paperOcean/serverExited") {
      turnStarting = false;
      activeTurnHandle = undefined;
    }
    return { method: event.method, params: nextParams };
  };
  const broadcastEvent = (payload) => {
    const translated = translateEvent(payload);
    if (!translated) return;
    const entry = { id: nextEventId++, payload: translated };
    recentEvents.push(entry);
    if (recentEvents.length > EVENT_BUFFER_SIZE) recentEvents.shift();
    const chunk = `id: ${entry.id}\ndata: ${JSON.stringify(entry.payload)}\n\n`;
    for (const response of sseClients) response.write(chunk);
  };
  const codexEventListener = (event) => broadcastEvent(event);
  codex.on("event", codexEventListener);

  const secureHeaders = (response, { html = false } = {}) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (html) {
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ws://${allowedHost} ws://${localHostAlias}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      );
    }
  };
  const reject = (response, status, message) => {
    secureHeaders(response);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: { message } }));
  };
  const sendJson = (response, value, status = 200) => {
    secureHeaders(response);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  const readBody = async (request, maximum = MAX_JSON_BYTES) => {
    const advertised = Number(request.headers["content-length"]);
    if (Number.isFinite(advertised) && advertised > maximum) throw httpError(413, "请求内容过大");
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > maximum) throw httpError(413, "请求内容过大");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const readJson = async (request, maximum = MAX_JSON_BYTES) => {
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      throw httpError(415, "只接受 JSON 请求");
    }
    const body = await readBody(request, maximum);
    try {
      return body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      throw httpError(400, "JSON 请求格式无效");
    }
  };
  const validateRequest = (request, { mutate = false } = {}) => {
    if (!allowedHosts.has(String(request.headers.host || ""))) throw httpError(421, "Host 无效");
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw httpError(403, "Origin 无效");
    if (request.headers["sec-fetch-site"] === "cross-site") throw httpError(403, "拒绝跨站请求");
    if (!mutate) return;
    if (!origin || !allowedOrigins.has(origin)) throw httpError(403, "缺少同源 Origin");
    if (!sameString(request.headers["x-paper-ocean-csrf"], csrfToken)) {
      throw httpError(403, "本地会话校验失败");
    }
    if (!String(request.headers.cookie || "").split(/;\s*/).includes(`paper_ocean_session=${sessionToken}`)) {
      throw httpError(403, "本地会话已失效");
    }
  };
  const saveUploadedPdf = async (buffer, filename) => {
    const temporary = await importPdfBuffer(buffer, { name: filename, path: "browser-upload" });
    const targetPath = pdfPathForId(temporary.id);
    await persistPdfBuffer(buffer, targetPath);
    return importPdfBuffer(buffer, { name: filename, path: targetPath });
  };

  const serveMedia = async (request, response, pathname) => {
    const token = pathname.slice("/api/media/".length);
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw httpError(404, "媒体链接无效");
    const candidate = requireMapValue(mediaTokens, token, "媒体链接");
    const { filePath, stat } = await assertRealFileWithin(resolvedDataDir, candidate);
    const rangeHeader = request.headers.range;
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (rangeHeader) {
      const match = String(rangeHeader).match(/^bytes=(\d+)-(\d*)$/);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return response.end();
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= stat.size) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return response.end();
      }
      status = 206;
    }
    const headers = {
      "Content-Type": mediaContentType(filePath),
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": path.extname(filePath).toLowerCase() === ".pdf"
        ? "private, no-store"
        : "private, max-age=86400",
    };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    secureHeaders(response);
    response.writeHead(status, headers);
    if (request.method === "HEAD") return response.end();
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };

  const handleApi = async (request, response, pathname) => {
    const method = String(request.method || "GET").toUpperCase();
    if (method === "OPTIONS") throw httpError(403, "不支持跨域预检");
    const mutate = method !== "GET" && method !== "HEAD";
    validateRequest(request, { mutate });

    if (method === "GET" && pathname === "/api/session") {
      response.setHeader(
        "Set-Cookie",
        `paper_ocean_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
      );
      return sendJson(response, { ready: true });
    }
    if (method === "GET" && pathname === "/api/events") {
      if (!String(request.headers.cookie || "").split(/;\s*/).includes(`paper_ocean_session=${sessionToken}`)) {
        throw httpError(403, "本地会话已失效");
      }
      secureHeaders(response);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(": Paper Ocean event stream\n\n");
      const lastId = Number(request.headers["last-event-id"] || 0);
      for (const event of recentEvents) {
        if (event.id > lastId) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      }
      sseClients.add(response);
      request.on("close", () => sseClients.delete(response));
      return;
    }
    if ((method === "GET" || method === "HEAD") && pathname.startsWith("/api/media/")) {
      return serveMedia(request, response, pathname);
    }

    if (method === "GET" && pathname === "/api/library") {
      const loaded = await loadLibrary(libraryPath);
      return sendJson(response, normalizeLibrary(loaded, new Set(threadHandles.keys())));
    }
    if (method === "PUT" && pathname === "/api/library") {
      const state = normalizeLibrary(await readJson(request, 8 * 1024 * 1024), new Set(threadHandles.keys()));
      librarySave = librarySave.catch(() => undefined).then(() => saveLibrary(libraryPath, state));
      await librarySave;
      return sendJson(response, { saved: true });
    }
    if (method === "POST" && pathname === "/api/papers/import") {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/pdf")) {
        throw httpError(415, "只接受 PDF 文件");
      }
      let filename;
      try {
        filename = decodeURIComponent(String(request.headers["x-paper-ocean-filename"] || "local-paper.pdf"));
      } catch {
        throw httpError(400, "PDF 文件名无效");
      }
      filename = filename.replace(/[\\/\r\n\0]/g, "_").slice(0, 160) || "local-paper.pdf";
      const body = await readBody(request, MAX_PDF_BYTES);
      const opened = await saveUploadedPdf(body, filename);
      return sendJson(response, { ...opened, path: paperHandle(opened.id) });
    }
    if (method === "POST" && pathname === "/api/papers/reopen") {
      const { handle } = await readJson(request, 10_000);
      const id = paperIdFromHandle(handle);
      const filePath = pdfPathForId(id);
      const buffer = await fs.readFile(filePath).catch(() => { throw httpError(404, "论文文件不存在"); });
      const opened = await importPdfBuffer(buffer, { name: `${id}.pdf`, path: filePath });
      if (opened.id !== id) throw httpError(409, "论文文件校验失败，请重新导入");
      return sendJson(response, { ...opened, path: paperHandle(id) });
    }
    if (method === "POST" && pathname === "/api/papers/open-url") {
      const { value } = await readJson(request, 20_000);
      const opened = await downloadArxivPaper(cleanText(value, 2_000), importsDir, networkFetch);
      return sendJson(response, await browserPaper(opened));
    }
    if (method === "POST" && pathname === "/api/papers/context") {
      const { paper, pages } = await readJson(request, 20 * 1024 * 1024);
      const id = cleanPaperId(paper?.id);
      if (paperIdFromHandle(paper?.path) !== id) throw httpError(400, "论文句柄与论文不匹配");
      await assertRealFileWithin(resolvedDataDir, pdfPathForId(id));
      const safePages = (Array.isArray(pages) ? pages : []).slice(0, MAX_PAGES).map((page, index) => {
        const pageNumber = Number(page?.page);
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGES) {
          throw httpError(400, `第 ${index + 1} 个页面索引无效`);
        }
        return { page: pageNumber, text: cleanText(page?.text, 2_000_000) };
      });
      if (!safePages.length) throw httpError(400, "论文全文索引为空");
      const safePaper = {
        id,
        name: cleanText(paper?.name, 300, `${id}.pdf`),
        path: paperHandle(id),
        sourceUrl: cleanText(paper?.sourceUrl, 2_000) || undefined,
        arxivId: cleanText(paper?.arxivId, 80) || undefined,
        title: cleanText(paper?.title, 2_000, paper?.name || id),
        abstract: cleanText(paper?.abstract, 50_000) || undefined,
      };
      const result = await savePaperContext(resolvedDataDir, { paper: safePaper, pages: safePages });
      return sendJson(response, {
        paperDir: contextHandle(id),
        contextPath: contextHandle(id),
        pageCount: safePages.length,
        saved: Boolean(result.contextPath),
      });
    }
    if (method === "POST" && pathname === "/api/papers/page-image") {
      const input = await readJson(request, 8 * 1024 * 1024);
      const id = cleanPaperId(input.paperId);
      const page = Number(input.page);
      if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) throw httpError(400, "页码无效");
      const imagePath = await savePageImage(resolvedDataDir, {
        paperId: id,
        page,
        dataUrl: cleanText(input.dataUrl, 8 * 1024 * 1024),
      });
      const handle = issueRandomHandle("image:");
      pageImageHandles.set(handle, imagePath);
      return sendJson(response, { handle });
    }
    if (method === "POST" && pathname === "/api/conversations/prepare") {
      const { scopeKey, papers } = await readJson(request, 2 * 1024 * 1024);
      const safeScope = cleanScopeKey(scopeKey);
      const safePapers = [];
      for (const paper of (Array.isArray(papers) ? papers : []).slice(0, 30)) {
        const id = cleanPaperId(paper?.id);
        if (contextIdFromHandle(paper?.paperDir) !== id) throw httpError(400, "论文上下文与论文不匹配");
        await assertRealFileWithin(resolvedDataDir, path.join(resolvedDataDir, "papers", id, "PAPER_CONTEXT.md"));
        safePapers.push({
          id,
          name: cleanText(paper?.name, 300, `${id}.pdf`),
          title: cleanText(paper?.title, 2_000, paper?.name || id),
          arxivId: cleanText(paper?.arxivId, 80) || undefined,
          pageCount: Number.isInteger(paper?.pageCount) ? Math.min(paper.pageCount, MAX_PAGES) : undefined,
        });
      }
      if (!safePapers.length) throw httpError(400, "对话范围中没有论文");
      if (safeScope !== "all" && !safePapers.some((paper) => `paper:${paper.id}` === safeScope)) {
        throw httpError(400, "对话范围与论文不匹配");
      }
      const prepared = await prepareConversationContext(resolvedDataDir, {
        scopeKey: safeScope,
        papers: safePapers,
      });
      const handle = issueRandomHandle("conversation:");
      conversationContexts.set(handle, {
        contextDir: prepared.contextDir,
        entries: prepared.entries,
        paperIds: safePapers.map((paper) => paper.id),
      });
      return sendJson(response, {
        contextDir: handle,
        entries: prepared.entries.map((entry, index) => ({
          key: `entry-${String(index + 1).padStart(6, "0")}`,
          path: handle,
          kind: entry.kind,
        })),
        paperCount: prepared.paperCount,
        characterCount: prepared.characterCount,
      });
    }
    if (method === "GET" && pathname === "/api/codex/status") {
      try {
        return sendJson(response, publicAccount(await codex.account()));
      } catch (error) {
        return sendJson(response, publicAccount({
          connected: false,
          accountType: null,
          planType: null,
          error: error instanceof Error ? error.message : "Codex 状态读取失败",
        }));
      }
    }
    if (method === "POST" && pathname === "/api/codex/login") {
      const result = await codex.login();
      const authUrl = typeof result?.authUrl === "string"
        ? result.authUrl
        : typeof result?.auth_url === "string"
          ? result.auth_url
          : undefined;
      if (authUrl) {
        const parsed = new URL(authUrl);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
          throw httpError(502, "Codex 返回了不安全的登录地址");
        }
      }
      return sendJson(response, {
        alreadyConnected: Boolean(result?.alreadyConnected),
        ...(authUrl ? { authUrl } : {}),
      });
    }
    if (method === "GET" && pathname === "/api/codex/models") {
      return sendJson(response, await codex.models({ force: true }));
    }
    if (method === "GET" && pathname === "/api/codex/rate-limits") {
      return sendJson(response, await codex.rateLimits());
    }
    if (method === "POST" && pathname === "/api/codex/threads/start") {
      const input = await readJson(request, 100_000);
      const context = requireMapValue(conversationContexts, input.contextDir, "对话上下文");
      const realThreadId = await codex.startThread({
        contextDir: context.contextDir,
        title: cleanText(input.title, 300, "Paper Ocean"),
        model: cleanModel(input.model),
      });
      const handle = await registerThread(realThreadId);
      return sendJson(response, { threadId: handle });
    }
    if (method === "POST" && pathname === "/api/codex/threads/resume") {
      const input = await readJson(request, 100_000);
      const realThreadId = requireThread(input.threadId);
      const context = requireMapValue(conversationContexts, input.contextDir, "对话上下文");
      const resumedId = await codex.resumeThread({
        threadId: cleanCodexId(realThreadId, "Codex 对话 ID"),
        contextDir: context.contextDir,
      });
      await registerThread(resumedId, input.threadId);
      return sendJson(response, { threadId: input.threadId });
    }
    if (method === "POST" && pathname === "/api/codex/turns/start") {
      if (turnStarting || activeTurnHandle) throw httpError(409, "已有回答正在生成，请先停止或等待完成");
      const input = await readJson(request, 2 * 1024 * 1024);
      const realThreadId = requireThread(input.threadId);
      const context = requireMapValue(conversationContexts, input.contextDir, "对话上下文");
      const pageImagePath = input.pageImagePath
        ? requireMapValue(pageImageHandles, input.pageImagePath, "页面图片")
        : undefined;
      turnStarting = true;
      try {
        const result = await codex.sendTurn({
          threadId: cleanCodexId(realThreadId, "Codex 对话 ID"),
          contextDir: context.contextDir,
          entries: context.entries,
          prompt: cleanText(input.prompt, 100_000),
          selectedText: cleanText(input.selectedText, 20_000) || undefined,
          pageImagePath,
          model: cleanModel(input.model),
          effort: cleanEffort(input.effort),
        });
        const turnHandle = registerTurn(input.threadId, result.turnId);
        if (!completedTurnHandles.has(turnHandle)) activeTurnHandle = turnHandle;
        return sendJson(response, { turnId: turnHandle });
      } finally {
        turnStarting = false;
      }
    }
    if (method === "POST" && pathname === "/api/codex/turns/interrupt") {
      const input = await readJson(request, 100_000);
      const realThreadId = requireThread(input.threadId);
      const turn = requireMapValue(turnHandles, input.turnId, "回答");
      if (turn.threadHandle !== input.threadId) throw httpError(400, "回答与对话不匹配");
      await codex.interrupt({
        threadId: cleanCodexId(realThreadId, "Codex 对话 ID"),
        turnId: cleanCodexId(turn.realTurnId, "Codex 回答 ID"),
      });
      return sendJson(response, { interrupted: true });
    }
    if (method === "POST" && pathname === "/api/recommendations") {
      const input = await readJson(request, 100_000);
      return sendJson(response, await recommendationsFetcher({
        title: cleanText(input.title, 500),
        abstract: cleanText(input.abstract, 8_000) || undefined,
        arxivId: cleanText(input.arxivId, 80) || undefined,
      }, networkFetch));
    }
    if (method === "POST" && pathname === "/api/recommendations/preview") {
      const { arxivId } = await readJson(request, 20_000);
      const result = await prepareRecommendationPreview(arxivId, importsDir, thumbnailsDir, networkFetch);
      if (result.status === "ready") {
        return sendJson(response, { status: "ready", imageUrl: await exposeMedia(result.thumbnailPath) });
      }
      if (result.status === "render") {
        return sendJson(response, { status: "render", pdfUrl: await exposeMedia(result.pdfPath) });
      }
      return sendJson(response, { status: "missing", reason: cleanText(result.reason, 500) || undefined });
    }
    if (method === "POST" && pathname === "/api/recommendations/thumbnail") {
      const input = await readJson(request, 2 * 1024 * 1024);
      const saved = await saveRecommendationThumbnail(thumbnailsDir, {
        arxivId: cleanText(input.arxivId, 80),
        dataUrl: cleanText(input.dataUrl, 2 * 1024 * 1024),
      });
      return sendJson(response, { imageUrl: await exposeMedia(saved.thumbnailPath) });
    }
    throw httpError(404, "API 不存在");
  };

  const server = createHttpServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", allowedOrigin);
      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(request, response, requestUrl.pathname);
        return;
      }
      validateRequest(request);
      secureHeaders(response, { html: true });
      vite.middlewares(request, response, (error) => {
        if (error && !response.headersSent) reject(response, 500, "页面服务失败");
      });
    } catch (error) {
      const status = Number(error?.statusCode) || (error?.code === "ENOENT" ? 404 : 400);
      const message = error instanceof Error ? error.message : "请求失败";
      if (!response.headersSent) reject(response, status, message.slice(0, 800));
      else response.end();
    }
  });

  vite = await viteFactory({
    root: rootDir,
    appType: "spa",
    server: {
      middlewareMode: true,
      ws: { server },
    },
    define: {
      "import.meta.env.VITE_PAPER_OCEAN_MODE": JSON.stringify("web"),
      "import.meta.env.VITE_PAPER_OCEAN_CSRF": JSON.stringify(csrfToken),
    },
  });

  const heartbeat = setInterval(() => {
    for (const response of sseClients) response.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref?.();

  const listen = () => new Promise((resolve, rejectListen) => {
    if (server.listening) return resolve();
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
  const close = async () => {
    clearInterval(heartbeat);
    for (const response of sseClients) response.end();
    sseClients.clear();
    codex.off?.("event", codexEventListener);
    await codex.stop().catch(() => undefined);
    await vite.close();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  return {
    host: HOST,
    port,
    url: allowedOrigin,
    listen,
    close,
    csrfToken,
  };
}
