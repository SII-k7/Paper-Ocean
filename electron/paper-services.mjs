import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeReadingState, normalizeReadingPosition } from "./reading-state.mjs";
import { normalizeConversations } from "./conversations.mjs";
import { paperMetadata, parseArxivReference, publicationDate } from "./paper-metadata.mjs";
import { selectContextDocuments } from "./context-selection.mjs";
import { readLibrarySnapshot, writeLibrarySnapshot, recoverLibrarySnapshot } from "./library-store.mjs";
import { downloadPdf } from "./pdf-download.mjs";
export { flushLibraryWrites } from "./library-store.mjs";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_RECOMMENDATION_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
// Codex app-server truncates each additionalContext value at 1,000 tokens.
// A byte-level tokenizer cannot produce more tokens than UTF-8 bytes, so this
// limit leaves headroom without depending on a model-specific tokenizer.
export const MAX_ADDITIONAL_CONTEXT_CHUNK_BYTES = 800;
const arxivDownloadTasks = new Map();

function safePaperId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("论文 ID 无效");
  return id;
}

function splitByUtf8ByteLimit(value, maxBytes = MAX_ADDITIONAL_CONTEXT_CHUNK_BYTES) {
  const text = String(value || "");
  if (!text) return [];

  const chunks = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const characterBytes = Buffer.byteLength(text.slice(index, index + width), "utf8");
    if (chunkBytes && chunkBytes + characterBytes > maxBytes) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    index += width;
  }
  if (chunkStart < text.length) chunks.push(text.slice(chunkStart));
  return chunks;
}

function splitPaperIntoSections(content) {
  const boundaries = [...content.matchAll(/^## 第 \d+ 页(?:\r?\n|$)/gm)].map((match) => match.index);
  if (!boundaries.length) return [content];

  const sections = [];
  if (boundaries[0] > 0) sections.push(content.slice(0, boundaries[0]));
  for (let index = 0; index < boundaries.length; index += 1) {
    sections.push(content.slice(boundaries[index], boundaries[index + 1] ?? content.length));
  }
  return sections.filter(Boolean);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(fetcher, url, options, { attempts = 3, timeoutMs = 20_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      options?.signal?.throwIfAborted();
      lastError = error;
    }
    if (attempt + 1 < attempts) await delay(600 * (attempt + 1));
  }
  throw lastError;
}

function decodeXml(value = "") {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

function readMetaValues(html, expectedName) {
  const values = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (name?.toLowerCase() !== expectedName.toLowerCase()) continue;
    const content = tag.match(/\bcontent=["']([\s\S]*?)["']/i)?.[1];
    if (content) values.push(decodeXml(content));
  }
  return values;
}

async function fetchArxivPageMetadata(arxivId, fetcher, signal) {
  const response = await fetchWithRetry(fetcher, `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`, {
    headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
    signal,
  }, { attempts: 2, timeoutMs: 15_000 });
  if (!response.ok) return null;
  const html = await response.text();
  const title = readMetaValues(html, "citation_title")[0];
  if (!title) return null;
  return {
    title,
    abstract: readMetaValues(html, "citation_abstract")[0] || "",
    authors: readMetaValues(html, "citation_author"),
  };
}

export function extractArxivId(input) {
  return parseArxivReference(input)?.id ?? null;
}

export async function fetchArxivMetadata(arxivId, fetcher = globalThis.fetch, { signal } = {}) {
  try {
    const response = await fetchWithRetry(fetcher, `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
      headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
      signal,
    }, { attempts: 1, timeoutMs: 15_000 });
    if (!response.ok) throw new Error("arXiv 元数据暂不可用");
    const xml = await response.text();
    const entry = xml.match(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/)?.[1];
    if (!entry) throw new Error("arXiv 元数据为空");
    const reference = parseArxivReference(decodeXml(entry.match(/<id(?:\s[^>]*)?>([\s\S]*?)<\/id>/)?.[1]));
    const requested = parseArxivReference(arxivId);
    if (!reference || reference.id !== requested?.id || (requested.version && reference.version !== requested.version)) throw new Error("arXiv 元数据版本不匹配");
    return {
      title: decodeXml(entry.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/)?.[1]),
      abstract: decodeXml(entry.match(/<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/)?.[1]),
      authors: [...entry.matchAll(/<author(?:\s[^>]*)?>[\s\S]*?<name(?:\s[^>]*)?>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
        .map((match) => decodeXml(match[1])),
      arxivVersion: reference?.version ?? requested?.version,
      publishedAt: publicationDate(entry.match(/<published(?:\s[^>]*)?>([\s\S]*?)<\/published>/)?.[1]),
      revisedAt: publicationDate(entry.match(/<updated(?:\s[^>]*)?>([\s\S]*?)<\/updated>/)?.[1]),
    };
  } catch {
    signal?.throwIfAborted();
    try { return await fetchArxivPageMetadata(arxivId, fetcher, signal); } catch { signal?.throwIfAborted(); return null; }
  }
}

async function openedPaperFromBuffer(buffer, source) {
  if (buffer.byteLength > MAX_PDF_BYTES) throw new Error("PDF 超过 100 MB，当前版本暂不支持");
  const id = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  return {
    id,
    name: source.name,
    path: source.path,
    sourceUrl: source.sourceUrl,
    arxivId: source.arxivId,
    title: source.title || path.basename(source.name, path.extname(source.name)),
    abstract: source.abstract || "",
    ...paperMetadata(source),
    openedAt: Date.now(),
    dataBase64: buffer.toString("base64"),
  };
}

export async function importPdfBuffer(buffer, source = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF 超过 100 MB，当前版本暂不支持");
  if (bytes.subarray(0, 4).toString() !== "%PDF") throw new Error("所选文件不是有效 PDF");
  return openedPaperFromBuffer(bytes, {
    name: String(source.name || "local-paper.pdf"),
    path: String(source.path || "browser-upload"),
    sourceUrl: source.sourceUrl,
    arxivId: source.arxivId,
    title: source.title,
    abstract: source.abstract,
    ...paperMetadata(source),
  });
}

export async function readPdfFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("所选路径不是文件");
  if (stat.size > MAX_PDF_BYTES) throw new Error("PDF 超过 100 MB，当前版本暂不支持");
  const buffer = await fs.readFile(filePath);
  if (buffer.subarray(0, 4).toString() !== "%PDF") throw new Error("所选文件不是有效 PDF");
  return openedPaperFromBuffer(buffer, {
    name: path.basename(filePath),
    path: filePath,
  });
}

export async function manageOriginal(rootDir, opened) {
  const buffer = Buffer.from(opened.dataBase64, "base64");
  const id = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  if (id !== opened.id || buffer.subarray(0, 4).toString() !== "%PDF" || buffer.length > MAX_PDF_BYTES) throw new Error("原件校验失败，未保存不匹配的 PDF");
  const directory = path.join(rootDir, "originals");
  const target = path.join(directory, `${id}.pdf`);
  await fs.mkdir(directory, { recursive: true });
  let existing;
  try { existing = await fs.readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!existing?.equals(buffer)) {
    if (existing) await fs.copyFile(target, `${target}.before-repair-${randomUUID()}`);
    const temporary = `${target}.part-${randomUUID()}`;
    try { await fs.writeFile(temporary, buffer, { flag: "wx" }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
  return { ...opened, path: target, originalPath: opened.originalPath || (path.resolve(opened.path) !== path.resolve(target) ? opened.path : undefined), managedOriginal: true };
}

export async function reopenManagedPdf(rootDir, filePath, expectedId) {
  if (expectedId && !/^[a-f0-9]{24}$/.test(expectedId)) throw new Error("论文内容 ID 无效");
  const managed = expectedId ? path.join(rootDir, "originals", `${expectedId}.pdf`) : undefined;
  let lastError;
  for (const candidate of [...new Set([managed, filePath].filter(Boolean))]) {
    try {
      const opened = await readPdfFile(candidate);
      if (expectedId && opened.id !== expectedId) throw new Error("原文件内容已变化，请重新定位相同版本的 PDF；已有引用与讨论仍保留。");
      return manageOriginal(rootDir, opened);
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("原件不存在，请重新定位 PDF");
}

function normalizedArxivId(value) {
  const arxivId = parseArxivReference(String(value || ""))?.reference;
  if (!arxivId) throw new Error("arXiv ID 无效");
  return arxivId;
}

export function arxivPdfCachePath(importsDir, value) {
  const arxivId = normalizedArxivId(value);
  return path.join(importsDir, `${arxivId.replaceAll("/", "_")}.pdf`);
}

function recommendationThumbnailBase(cacheDir, value) {
  const arxivId = normalizedArxivId(value);
  const key = createHash("sha256").update(`thumb-v2:${arxivId}`).digest("hex");
  return path.join(cacheDir, key);
}

function validThumbnailSignature(buffer, extension) {
  if (extension === "png") {
    return buffer.byteLength >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buffer.byteLength >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

async function validThumbnailFile(filePath, extension) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_THUMBNAIL_BYTES) return false;
    const handle = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, 12, 0);
      return validThumbnailSignature(header.subarray(0, bytesRead), extension);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function validPdfFile(filePath, maximumBytes = MAX_PDF_BYTES) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maximumBytes || stat.size < 4) return false;
    const handle = await fs.open(filePath, "r");
    try {
      const signature = Buffer.alloc(4);
      await handle.read(signature, 0, 4, 0);
      return signature.toString() === "%PDF";
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function pdfSizeLimitError(maximumBytes) {
  const maximumMegabytes = Math.floor(maximumBytes / (1024 * 1024));
  const error = new Error(`PDF 超过 ${maximumMegabytes} MB，当前操作暂不支持`);
  error.code = "PDF_SIZE_LIMIT";
  return error;
}

async function assertPdfWithinSize(filePath, maximumBytes) {
  const stat = await fs.stat(filePath);
  if (stat.size > maximumBytes) throw pdfSizeLimitError(maximumBytes);
  return filePath;
}

async function ensureArxivPdfCached(
  arxivId,
  importsDir,
  fetcher,
  maximumBytes = MAX_PDF_BYTES,
  options = {},
) {
  options.signal?.throwIfAborted();
  const filePath = arxivPdfCachePath(importsDir, arxivId);
  if (await validPdfFile(filePath)) {
    const { size } = await fs.stat(filePath);
    options.onProgress?.({ phase: "complete", received: size, total: size, resumed: false });
    return assertPdfWithinSize(filePath, maximumBytes);
  }

  const taskKey = `${path.resolve(importsDir)}\n${arxivId}`;
  let task = arxivDownloadTasks.get(taskKey);
  if (task?.controller.signal.aborted) {
    // The last subscriber can leave before the writer has closed its handle.
    // Wait for that cleanup before a new request reuses the partial file.
    await task.promise.catch(() => undefined);
    return ensureArxivPdfCached(arxivId, importsDir, fetcher, maximumBytes, options);
  }
  if (!task) {
    task = { controller: new AbortController(), subscribers: new Set(), maximumBytes, complete: false };
    const running = task;
    running.promise = downloadPdf({ url: `https://arxiv.org/pdf/${arxivId}`, filePath, fetcher, maximumBytes,
      signal: AbortSignal.any([running.controller.signal, AbortSignal.timeout(10 * 60 * 1000)]),
      onProgress: (progress) => { running.progress = progress; for (const subscriber of running.subscribers) subscriber.onProgress?.(progress); },
    }).finally(() => { running.complete = true; if (arxivDownloadTasks.get(taskKey) === running) arxivDownloadTasks.delete(taskKey); });
    arxivDownloadTasks.set(taskKey, running);
  }
  const running = task;
  try {
    const result = await new Promise((resolve, reject) => {
      const subscriber = { onProgress: options.onProgress };
      const cleanup = () => { running.subscribers.delete(subscriber); options.signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); if (!running.complete && !running.subscribers.size) running.controller.abort(); reject(options.signal.reason); };
      running.subscribers.add(subscriber);
      if (running.progress) options.onProgress?.(running.progress);
      options.signal?.addEventListener("abort", abort, { once: true });
      running.promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
      if (options.signal?.aborted) abort();
    });
    return await assertPdfWithinSize(result, maximumBytes);
  } catch (error) {
    if (error?.code === "PDF_SIZE_LIMIT" && running.maximumBytes < maximumBytes) return ensureArxivPdfCached(arxivId, importsDir, fetcher, maximumBytes, options);
    throw error;
  }
}

export async function downloadArxivPaper(input, importsDir, fetcher = globalThis.fetch, options = {}) {
  const requested = parseArxivReference(input);
  if (!requested) throw new Error("当前版本只支持 arXiv 论文链接或 arXiv ID");
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: "metadata", received: 0, resumed: false });
  const metadataFile = `${arxivPdfCachePath(importsDir, requested.reference)}.metadata.json`;
  let cached;
  try { if ((await fs.stat(metadataFile)).size <= 100000) cached = JSON.parse(await fs.readFile(metadataFile, "utf8")); } catch { /* Derived cache is optional. */ }
  const validCache = cached?.reference === requested.reference && cached.metadata && typeof cached.metadata.title === "string" && (!requested.version || cached.metadata.arxivVersion === requested.version);
  // Explicit versions are immutable; an unversioned lookup is refreshed daily.
  let metadata = validCache && (requested.version || Date.now() - cached.at < 86400000) ? cached.metadata : null;
  if (!metadata) {
    metadata = await fetchArxivMetadata(requested.reference, fetcher, options);
    if (!metadata && validCache) metadata = cached.metadata;
    if (metadata) {
      await fs.mkdir(importsDir, { recursive: true });
      await writeTextIfChanged(metadataFile, JSON.stringify({ reference: requested.reference, at: Date.now(), metadata })).catch(() => undefined);
    }
  }
  const arxivVersion = requested.version ?? metadata?.arxivVersion;
  const reference = `${requested.id}${arxivVersion ? `v${arxivVersion}` : ""}`;
  const filePath = await ensureArxivPdfCached(reference, importsDir, fetcher, MAX_PDF_BYTES, { ...options, onProgress: (progress) => options.onProgress?.({ ...progress, reference }) });
  options.signal?.throwIfAborted();
  const buffer = await fs.readFile(filePath);

  return openedPaperFromBuffer(buffer, {
    name: `${reference}.pdf`,
    path: filePath,
    sourceUrl: `https://arxiv.org/abs/${reference}`,
    arxivId: requested.id,
    arxivVersion,
    authors: metadata?.authors,
    publishedAt: metadata?.publishedAt,
    revisedAt: metadata?.revisedAt,
    title: metadata?.title,
    abstract: metadata?.abstract,
  });
}

export async function prepareRecommendationPreview(
  value,
  importsDir,
  thumbnailCacheDir,
  fetcher = globalThis.fetch,
) {
  const arxivId = normalizedArxivId(value);
  const thumbnailBase = recommendationThumbnailBase(thumbnailCacheDir, arxivId);
  for (const extension of ["webp", "png"]) {
    const thumbnailPath = `${thumbnailBase}.${extension}`;
    if (await validThumbnailFile(thumbnailPath, extension)) {
      return { status: "ready", arxivId, thumbnailPath };
    }
    await fs.rm(thumbnailPath, { force: true }).catch(() => undefined);
  }

  const cachedPdfPath = arxivPdfCachePath(importsDir, arxivId);
  const hasCachedPdf = await validPdfFile(cachedPdfPath);
  if (hasCachedPdf) {
    const cachedStat = await fs.stat(cachedPdfPath);
    if (cachedStat.size > MAX_RECOMMENDATION_PREVIEW_BYTES) {
      return { status: "missing", arxivId, reason: "PDF 较大，打开后再生成预览" };
    }
  } else {
    try {
      const head = await fetchWithRetry(fetcher, `https://arxiv.org/pdf/${arxivId}`, {
        method: "HEAD",
        headers: { "User-Agent": "PaperOcean/0.3 local-reader" },
      }, { attempts: 1, timeoutMs: 15_000 });
      const advertisedBytes = Number(head.headers.get("content-length"));
      if (Number.isFinite(advertisedBytes) && advertisedBytes > MAX_RECOMMENDATION_PREVIEW_BYTES) {
        return { status: "missing", arxivId, reason: "PDF 较大，打开后再生成预览" };
      }
    } catch {
      // Some mirrors reject HEAD; the guarded PDF download remains the fallback.
    }
  }

  try {
    const pdfPath = await ensureArxivPdfCached(
      arxivId,
      importsDir,
      fetcher,
      MAX_RECOMMENDATION_PREVIEW_BYTES,
    );
    return { status: "render", arxivId, pdfPath };
  } catch (error) {
    return {
      status: "missing",
      arxivId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function saveRecommendationThumbnail(thumbnailCacheDir, { arxivId: value, dataUrl }) {
  const arxivId = normalizedArxivId(value);
  const match = String(dataUrl || "").match(/^data:image\/(webp|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("论文缩略图格式无效");
  const extension = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new Error("论文缩略图超过 1 MB");
  }
  if (!validThumbnailSignature(buffer, extension)) throw new Error("论文缩略图内容无效");

  await fs.mkdir(thumbnailCacheDir, { recursive: true });
  const thumbnailBase = recommendationThumbnailBase(thumbnailCacheDir, arxivId);
  const thumbnailPath = `${thumbnailBase}.${extension}`;
  const tempPath = `${thumbnailPath}.part-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, buffer);
    await fs.rm(thumbnailPath, { force: true }).catch(() => undefined);
    await fs.rename(tempPath, thumbnailPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  const staleExtension = extension === "webp" ? "png" : "webp";
  await fs.rm(`${thumbnailBase}.${staleExtension}`, { force: true }).catch(() => undefined);
  return { arxivId, thumbnailPath };
}

async function writeTextIfChanged(filePath, text) {
  if (await fs.readFile(filePath, "utf8").catch(() => null) === text) return;
  const temporary = `${filePath}.part-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readPaperIndex(rootDir, paperId) {
  const id = safePaperId(paperId);
  try {
    const file = path.join(rootDir, "papers", id, "pages-index.json");
    if ((await fs.stat(file)).size > 64 * 1024 * 1024) return undefined;
    const index = JSON.parse(await fs.readFile(file, "utf8"));
    if (index.version !== 1 || index.paperId !== id || !Array.isArray(index.pages) || !index.pages.length || index.pages.length > 10_000
      || index.pages.some((page, offset) => page.page !== offset + 1 || typeof page.text !== "string")) return undefined;
    return index.pages;
  } catch { return undefined; } // Derived caches may be safely regenerated from the PDF.
}

export async function savePaperContext(rootDir, { paper, pages }) {
  const paperDir = path.join(rootDir, "papers", safePaperId(paper.id));
  await fs.mkdir(paperDir, { recursive: true });

  const header = [
    "# Paper Ocean 阅读上下文",
    "",
    `- 标题：${paper.title}`,
    `- 本地文件：${paper.path}`,
    paper.arxivId ? `- arXiv：${paper.arxivId}` : null,
    paper.abstract ? `- 摘要：${paper.abstract}` : null,
    "",
    "回答时请使用下面的页码标题作为引用依据。",
    "",
  ].filter(Boolean);
  const body = pages.flatMap(({ page: pageNumber, text }) => [
    `## 第 ${pageNumber} 页`,
    "",
    text.trim() || "[本页未提取到文本，请结合页面图片判断]",
    "",
  ]);
  const contextPath = path.join(paperDir, "PAPER_CONTEXT.md");
  await writeTextIfChanged(contextPath, [...header, ...body].join("\n"));
  await writeTextIfChanged(path.join(paperDir, "pages-index.json"), JSON.stringify({ version: 1, paperId: paper.id, pages }));
  return { paperDir, contextPath };
}

export async function prepareConversationContext(rootDir, { scopeKey, papers, question, currentPaperId, currentPage, budgetBytes }) {
  if (!Array.isArray(papers) || !papers.length) throw new Error("对话范围中没有论文");

  const uniquePapers = [];
  const seen = new Set();
  for (const paper of papers) {
    const id = safePaperId(paper?.id);
    if (seen.has(id)) continue;
    seen.add(id);
    uniquePapers.push({
      id,
      title: String(paper?.title || paper?.name || id).replace(/[\r\n]+/g, " ").trim(),
      pageCount: Number.isInteger(paper?.pageCount) ? paper.pageCount : undefined,
      arxivId: paper?.arxivId ? String(paper.arxivId) : undefined,
    });
  }

  const contextId = createHash("sha256")
    .update(`${String(scopeKey || "paper")}\n${uniquePapers.map((paper) => paper.id).sort().join("\n")}`)
    .digest("hex")
    .slice(0, 24);
  const contextDir = path.join(rootDir, "research-contexts", contextId);
  const sourceDocuments = await Promise.all(uniquePapers.map(async (paper) => {
    try { return { id: paper.id, content: await fs.readFile(path.join(rootDir, "papers", paper.id, "PAPER_CONTEXT.md"), "utf8") }; }
    catch { throw new Error(`《${paper.title}》的全文索引尚未完成，请先打开并等待索引完成`); }
  }));
  const selection = selectContextDocuments(sourceDocuments, { question, currentPaperId, currentPage, budgetBytes });
  const snapshotId = createHash("sha256").update(JSON.stringify(selection.documents)).digest("hex").slice(0, 24);
  const snapshotDir = path.join(contextDir, "snapshots", snapshotId);
  const papersDir = path.join(snapshotDir, "papers");
  await fs.mkdir(papersDir, { recursive: true });

  const paperEntries = [];
  const manifest = [
    "# Paper Ocean 研究上下文",
    "",
    `- 对话范围：${uniquePapers.length > 1 ? "固定论文集合" : "单篇论文"}`,
    `- 论文数量：${uniquePapers.length}`,
    "- 论文正文均位于 untrusted 上下文；本清单只描述应用生成的标识与顺序。",
    "- 同一论文的分片按键中的 chunk 编号升序连续阅读。",
    "",
    "## 应用生成的论文映射",
    "",
  ];
  let characterCount = 0;

  for (let index = 0; index < uniquePapers.length; index += 1) {
    const paper = uniquePapers[index];
    const provided = selection.documents[index];
    const content = provided.content;

    characterCount += content.length;
    const paperKey = `paper-${createHash("sha256").update(paper.id).digest("hex").slice(0, 24)}`;
    const sections = splitPaperIntoSections(content);
    let chunkNumber = 0;
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const sectionChunks = splitByUtf8ByteLimit(sections[sectionIndex]);
      for (let partIndex = 0; partIndex < sectionChunks.length; partIndex += 1) {
        chunkNumber += 1;
        const sequence = String(chunkNumber).padStart(6, "0");
        const section = String(sectionIndex + 1).padStart(5, "0");
        const part = String(partIndex + 1).padStart(5, "0");
        const key = `${paperKey}-chunk-${sequence}-section-${section}-part-${part}`;
        const fileName = `${key}.md`;
        const targetPath = path.join(papersDir, fileName);
        await writeTextIfChanged(targetPath, sectionChunks[partIndex]);
        paperEntries.push({ key, path: targetPath, kind: "untrusted" });
      }
    }
    manifest.push(
      `### 论文 ${index + 1}`,
      "",
      `- opaque paper ID：${paper.id}`,
      `- untrusted 分片键前缀：${paperKey}-chunk-`,
      `- untrusted 分片数量：${chunkNumber}`,
      `- 提取文本字符数：${content.length}`,
      `- 本轮提供 ${provided.pages.length}/${provided.totalPages} 页；页面节选数量：${provided.excerptPages.length}`,
      "",
    );
  }

  const applicationEntries = [];
  const manifestChunks = splitByUtf8ByteLimit(manifest.filter(Boolean).join("\n"));
  for (let index = 0; index < manifestChunks.length; index += 1) {
    const sequence = String(index + 1).padStart(4, "0");
    const manifestPath = path.join(snapshotDir, `CONTEXT_MANIFEST.part-${sequence}.md`);
    await writeTextIfChanged(manifestPath, manifestChunks[index]);
    applicationEntries.push({
      key: `paper-ocean-manifest-part-${sequence}`,
      path: manifestPath,
      kind: "application",
    });
  }

  return {
    contextDir,
    entries: [...applicationEntries, ...paperEntries],
    paperCount: uniquePapers.length,
    characterCount,
    coverage: {
      complete: selection.complete,
      providedPages: selection.documents.reduce((sum, paper) => sum + paper.pages.length, 0),
      totalPages: selection.documents.reduce((sum, paper) => sum + paper.totalPages, 0),
      textBytes: selection.textBytes,
      papers: selection.documents.map(({ id, pages, totalPages, excerptPages }) => ({ paperId: id, pages, totalPages, excerptPages })),
    },
  };
}

export async function savePageImage(rootDir, { paperId, page, dataUrl }) {
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new Error("取证页码无效");
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error("页面图片格式无效");
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length < 45 || buffer.length > 8 * 1024 * 1024 || !validThumbnailSignature(buffer, "png") || !buffer.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]))) throw new Error("页面图片内容无效或超过 8 MB");
  const paperDir = path.join(rootDir, "papers", safePaperId(paperId));
  await fs.mkdir(paperDir, { recursive: true });
  const imagePath = path.join(paperDir, `evidence-v1-page-${page}.png`);
  const temporary = `${imagePath}.part-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, buffer, { flag: "wx" });
    await fs.rename(temporary, imagePath);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  return imagePath;
}

export async function cachedPageImage(rootDir, paperId, page) {
  if (!Number.isInteger(page) || page < 1 || page > 10_000) return undefined;
  const candidate = path.join(rootDir, "papers", safePaperId(paperId), `evidence-v1-page-${page}.png`);
  try {
    const stat = await fs.stat(candidate);
    if (stat.size < 45 || stat.size > 8 * 1024 * 1024) return undefined;
    const file = await fs.open(candidate,"r");
    try {
      const signature = Buffer.alloc(8);
      await file.read(signature,0,8,0);
      const trailer = Buffer.alloc(12);
      await file.read(trailer,0,12,stat.size-12);
      return signature.equals(Buffer.from([137,80,78,71,13,10,26,10])) && trailer.equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])) ? candidate : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}

export async function loadLibrary(filePath, { withRevision = false } = {}) {
    const value = await readLibrarySnapshot(filePath);
    const papers = Array.isArray(value.papers) ? value.papers.map((paper) => ({ ...paper, ...paperMetadata(paper), readingPosition: normalizeReadingPosition(paper.readingPosition) })) : [];
    const validPaperIds = new Set(papers.map((paper) => paper.id));
    const legacyMessages = value.messagesByPaper && typeof value.messagesByPaper === "object"
      ? Object.fromEntries(Object.entries(value.messagesByPaper).map(([paperId, messages]) => [
        `paper:${paperId}`,
        messages,
      ]))
      : {};
    const rawMessagesByScope = value.messagesByScope && typeof value.messagesByScope === "object"
      ? value.messagesByScope
      : legacyMessages;
    const messagesByScope = Object.fromEntries(Object.entries(rawMessagesByScope).map(([scope, messages]) => [
      scope,
      Array.isArray(messages)
        ? messages.map((message) => {
            const retryNotice = message?.role === "assistant"
              && /^Reconnecting(?:\.\.\.)?\s+\d+\/\d+$/i.test(String(message?.text || "").trim());
            return retryNotice
              ? {
                  ...message,
                  text: "上一次回答因网络中断未完成，请重新发送这个问题。",
                  pending: false,
                  error: true,
                }
              : message?.pending
                ? { ...message, pending: false, error: true, text: message.text || "上一次回答未完成，已保留现有内容。请重新发送问题。" }
                : message;
          })
        : [],
    ]));
    const legacyThreads = Object.fromEntries(
      papers
        .filter((paper) => typeof paper.threadId === "string" && paper.threadId)
        .map((paper) => [`paper:${paper.id}`, paper.threadId]),
    );
    const requestedOpenIds = Array.isArray(value.openPaperIds)
      ? value.openPaperIds
      : [value.lastPaperId].filter(Boolean);
    const openPaperIds = requestedOpenIds.filter((id, index) => (
      validPaperIds.has(id) && requestedOpenIds.indexOf(id) === index
    ));
    return {
      ...(withRevision ? { _revision: createHash("sha256").update(JSON.stringify(value)).digest("hex") } : {}),
      ...normalizeReadingState(value),
      conversations: normalizeConversations({ ...value, papers, messagesByScope }),
      papers,
      messagesByScope,
      threadsByScope: value.threadsByScope && typeof value.threadsByScope === "object"
        ? value.threadsByScope
        : legacyThreads,
      aiSettingsByScope: value.aiSettingsByScope && typeof value.aiSettingsByScope === "object"
        ? value.aiSettingsByScope
        : {},
      openPaperIds,
      lastPaperId: value.lastPaperId,
      lastScopeKey: typeof value.lastScopeKey === "string" ? value.lastScopeKey : undefined,
    };
}

export async function saveLibrary(filePath, state) {
  return writeLibrarySnapshot(filePath, state);
}

export async function recoverLibrary(filePath) {
  await recoverLibrarySnapshot(filePath);
  return loadLibrary(filePath);
}
