import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

function safePaperId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("论文 ID 无效");
  return id;
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
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
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

async function fetchArxivPageMetadata(arxivId, fetcher) {
  const response = await fetchWithRetry(fetcher, `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`, {
    headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
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
  const value = input.trim();
  const modern = value.match(/(?:arxiv\.org\/(?:abs|pdf)\/|^)(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i);
  if (modern) return modern[1];
  const legacy = value.match(/(?:arxiv\.org\/(?:abs|pdf)\/|^)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i);
  return legacy?.[1] ?? null;
}

export async function fetchArxivMetadata(arxivId, fetcher = globalThis.fetch) {
  try {
    const pageMetadata = await fetchArxivPageMetadata(arxivId, fetcher);
    if (pageMetadata) return pageMetadata;
  } catch {
    // The Atom endpoint below is a second official source when the abstract page is unavailable.
  }

  try {
    const response = await fetchWithRetry(fetcher, `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
      headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
    }, { attempts: 1, timeoutMs: 15_000 });
    if (!response.ok) return null;
    const xml = await response.text();
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
    if (!entry) return null;
    return {
      title: decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
      abstract: decodeXml(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]),
      authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
        .map((match) => decodeXml(match[1])),
    };
  } catch {
    return null;
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
    openedAt: Date.now(),
    dataBase64: buffer.toString("base64"),
  };
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

export async function downloadArxivPaper(input, importsDir, fetcher = globalThis.fetch) {
  const arxivId = extractArxivId(input);
  if (!arxivId) throw new Error("当前版本只支持 arXiv 论文链接或 arXiv ID");

  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  const [response, metadata] = await Promise.all([
    fetchWithRetry(fetcher, pdfUrl, {
      headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
    }, { attempts: 3, timeoutMs: 45_000 }),
    fetchArxivMetadata(arxivId, fetcher),
  ]);
  if (!response.ok) throw new Error(`arXiv 下载失败（HTTP ${response.status}）`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_PDF_BYTES) throw new Error("PDF 超过 100 MB，当前版本暂不支持");
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.subarray(0, 4).toString() !== "%PDF") throw new Error("arXiv 返回的内容不是 PDF");

  await fs.mkdir(importsDir, { recursive: true });
  const filePath = path.join(importsDir, `${arxivId.replaceAll("/", "_")}.pdf`);
  await fs.writeFile(filePath, buffer);

  return openedPaperFromBuffer(buffer, {
    name: `${arxivId}.pdf`,
    path: filePath,
    sourceUrl: `https://arxiv.org/abs/${arxivId}`,
    arxivId,
    title: metadata?.title,
    abstract: metadata?.abstract,
  });
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
  await fs.writeFile(contextPath, [...header, ...body].join("\n"), "utf8");
  return { paperDir, contextPath };
}

export async function prepareConversationContext(rootDir, { scopeKey, papers }) {
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
  const papersDir = path.join(contextDir, "papers");
  await fs.mkdir(papersDir, { recursive: true });

  const entries = [];
  const manifest = [
    "# Paper Ocean 研究上下文",
    "",
    `- 对话范围：${scopeKey === "all" ? "全部已打开论文" : "单篇论文"}`,
    `- 论文数量：${uniquePapers.length}`,
    "- 每篇论文均以页码标题保存完整提取文本。",
    "",
    "## 论文清单",
    "",
  ];
  let characterCount = 0;

  for (let index = 0; index < uniquePapers.length; index += 1) {
    const paper = uniquePapers[index];
    const sourcePath = path.join(rootDir, "papers", paper.id, "PAPER_CONTEXT.md");
    let content;
    try {
      content = await fs.readFile(sourcePath, "utf8");
    } catch {
      throw new Error(`《${paper.title}》的全文索引尚未完成，请先在左侧打开并等待索引完成`);
    }

    const fileName = `${String(index + 1).padStart(2, "0")}-${paper.id}.md`;
    const targetPath = path.join(papersDir, fileName);
    await fs.writeFile(targetPath, content, "utf8");
    characterCount += content.length;
    entries.push({
      key: `paper-${paper.id}`,
      path: targetPath,
      kind: "untrusted",
    });
    manifest.push(
      `### ${index + 1}. ${paper.title}`,
      "",
      `- 全文文件：papers/${fileName}`,
      paper.pageCount ? `- 页数：${paper.pageCount}` : null,
      paper.arxivId ? `- arXiv：${paper.arxivId}` : null,
      `- 提取文本字符数：${content.length}`,
      "",
    );
  }

  const manifestPath = path.join(contextDir, "CONTEXT_MANIFEST.md");
  await fs.writeFile(manifestPath, manifest.filter(Boolean).join("\n"), "utf8");
  entries.unshift({ key: "paper-ocean-manifest", path: manifestPath, kind: "application" });

  return {
    contextDir,
    entries,
    paperCount: uniquePapers.length,
    characterCount,
  };
}

export async function savePageImage(rootDir, { paperId, page, dataUrl }) {
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error("页面图片格式无效");
  const paperDir = path.join(rootDir, "papers", safePaperId(paperId));
  await fs.mkdir(paperDir, { recursive: true });
  const imagePath = path.join(paperDir, `page-${page}.png`);
  await fs.writeFile(imagePath, Buffer.from(match[1], "base64"));
  return imagePath;
}

export async function loadLibrary(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    const papers = Array.isArray(value.papers) ? value.papers : [];
    const validPaperIds = new Set(papers.map((paper) => paper.id));
    const legacyMessages = value.messagesByPaper && typeof value.messagesByPaper === "object"
      ? Object.fromEntries(Object.entries(value.messagesByPaper).map(([paperId, messages]) => [
        `paper:${paperId}`,
        messages,
      ]))
      : {};
    const messagesByScope = value.messagesByScope && typeof value.messagesByScope === "object"
      ? value.messagesByScope
      : legacyMessages;
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
    };
  } catch {
    return { papers: [], messagesByScope: {}, threadsByScope: {}, aiSettingsByScope: {}, openPaperIds: [] };
  }
}

export async function saveLibrary(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}
