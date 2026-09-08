import { promises as fs, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { normalizeConversations } from "./conversations.mjs";
import { classifyPaper, PAPER_CATEGORIES } from "./paper-classification.mjs";

export const defaultArchiveDirectory = () => process.env.PAPER_OCEAN_ARCHIVE_DIR || (process.platform === "win32" ? "D:\\paper" : path.join(os.homedir(), "paper"));
export function discussedPaperIds(library) {
  const ids = new Set(), conversations = normalizeConversations(library);
  for (const [scope, messages] of Object.entries(library.messagesByScope || {})) {
    if (!messages.some(message => message.role === "user" && String(message.text || "").trim())) continue;
    for (const id of conversations[scope]?.paperIds || []) ids.add(id);
    if (/^paper:[a-f0-9]{24}$/.test(scope)) ids.add(scope.slice(6));
    for (const message of messages) if (/^[a-f0-9]{24}$/.test(message.paperId || "")) ids.add(message.paperId);
  }
  for (const [id, messages] of Object.entries(library.messagesByPaper || {})) if (messages.some(message => message.role === "user" && String(message.text || "").trim())) ids.add(id);
  return ids;
}
export function archiveFilename(paper) {
  const title = String(paper.title || paper.name || "paper").normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 100) || "paper";
  return `${title} -- ${paper.id}.pdf`;
}
function within(root, relative) {
  const target = path.resolve(root, relative), relation = path.relative(root, target);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("归档路径超出目标目录");
  return target;
}
async function matchingPdf(filename, id) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error("PDF 文件大小无效");
  const bytes = await fs.readFile(filename);
  if (bytes.subarray(0, 4).toString() !== "%PDF" || createHash("sha256").update(bytes).digest("hex").slice(0, 24) !== id) throw new Error("PDF 内容与对话记录不匹配，原文件未被覆盖");
  return bytes;
}

export function createPaperArchive({ directory = defaultArchiveDirectory(), metadataFile, sourceForPaper, textForPaper = async () => "" }) {
  const root = path.resolve(directory);
  let manifest, latest, running, queued = false, globalError, fingerprint;
  const failures = new Map(), verified = new Map();
  async function load() {
    if (manifest) return;
    try {
      const data = JSON.parse(await fs.readFile(metadataFile, "utf8"));
      if (data.version !== 1 || !data.entries || !data.overrides || typeof data.entries !== "object" || typeof data.overrides !== "object") throw new Error("归档记录格式无效");
      manifest = data;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("归档记录无法读取，已有 PDF 保留，请检查归档记录文件");
      manifest = { version: 1, entries: {}, overrides: {} };
    }
  }
  async function persist() {
    const temp = `${metadataFile}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(metadataFile), { recursive: true });
    try { await fs.writeFile(temp, JSON.stringify(manifest, null, 2), { flag: "wx" }); await fs.rename(temp, metadataFile); }
    finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  }
  async function ensureCategory(category) {
    await fs.mkdir(root, { recursive: true });
    const folder = within(root, category);
    await fs.mkdir(folder, { recursive: true });
    const [realRoot, realFolder] = await Promise.all([fs.realpath(root), fs.realpath(folder)]);
    within(realRoot, path.relative(realRoot, realFolder));
    return folder;
  }
  async function archive(paper) {
    if (!/^[a-f0-9]{24}$/.test(paper.id)) throw new Error("论文标识无效");
    const previous = manifest.entries[paper.id];
    const manual = manifest.overrides[paper.id];
    const classification = PAPER_CATEGORIES.includes(manual) ? { category: manual, reason: "手动分类" } : classifyPaper(paper, await textForPaper(paper).catch(() => ""));
    const category = classification.category;
    await ensureCategory(category);
    const relative = previous?.category === category && typeof previous.relativePath === "string" && previous.relativePath.split(/[\\/]/)[0] === category ? previous.relativePath : path.join(category, archiveFilename(paper));
    const target = within(root, relative);
    let exists = false;
    try {
      const stat = await fs.stat(target), stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (verified.get(target) !== stamp) { await matchingPdf(target, paper.id); verified.set(target, stamp); }
      exists = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!exists) {
      let bytes;
      try { bytes = await matchingPdf(await sourceForPaper(paper), paper.id); }
      catch (error) {
        if (!previous?.relativePath) throw error;
        bytes = await matchingPdf(within(root, previous.relativePath), paper.id);
      }
      const temp = within(root, path.join(category, `.paper-ocean-${randomUUID()}.tmp`));
      try {
        const handle = await fs.open(temp, "wx");
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        // An exclusive link publishes a complete file and never replaces a user's file.
        try { await fs.link(temp, target); }
        catch (error) {
          if (error.code === "EEXIST") await matchingPdf(target, paper.id);
          else if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"].includes(error.code)) {
            // exFAT and some mounted volumes cannot create hard links.
            try { await fs.copyFile(temp, target, constants.COPYFILE_EXCL); }
            catch (copyError) { if (copyError.code !== "EEXIST") throw copyError; await matchingPdf(target, paper.id); }
          } else throw error;
        }
      } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
    }
    manifest.entries[paper.id] = { paperId: paper.id, title: paper.title, category, reason: classification.reason, manual: Boolean(manual), relativePath: relative, savedAt: previous?.savedAt || Date.now() };
    await persist();
    if (previous?.relativePath && previous.relativePath !== relative) {
      const old = within(root, previous.relativePath);
      // Only remove our prior copy after checking both its location and content.
      const realRoot = await fs.realpath(root), realOld = await fs.realpath(old).catch(() => null);
      if (realOld) { within(realRoot, path.relative(realRoot, realOld)); await matchingPdf(old, paper.id); await fs.unlink(old); }
    }
  }
  async function reconcile() {
    await load();
    const state = latest, ids = discussedPaperIds(state);
    if (ids.size) for (const category of PAPER_CATEGORIES) await ensureCategory(category);
    for (const paper of state.papers.filter(paper => ids.has(paper.id))) {
      try { await archive(paper); failures.delete(paper.id); }
      catch (error) { failures.set(paper.id, { paperId: paper.id, title: paper.title, error: `归档失败：${error.message}` }); }
    }
  }
  const api = {
    schedule(state, force = false) {
      latest = state;
      const ids = discussedPaperIds(state);
      const key = JSON.stringify(state.papers.filter(p => ids.has(p.id)).map(p => [p.id, p.title, p.abstract, p.path, p.pageCount]));
      if (!force && key === fingerprint) return running || Promise.resolve();
      fingerprint = key; queued = true;
      if (!running) running = (async () => {
        while (queued) { queued = false; try { await reconcile(); globalError = undefined; } catch (error) { globalError = error.message; } }
      })().finally(() => { running = undefined; });
      return running;
    },
    async status() {
      try { await load(); } catch (error) { globalError = error.message; }
      return { directory: root, busy: Boolean(running), error: globalError, overrides: { ...manifest?.overrides }, entries: Object.values(manifest?.entries || {}).map(entry => ({ ...entry, path: within(root, entry.relativePath) })), failures: [...failures.values()] };
    },
    async setCategory(paperId, category) {
      if (!/^[a-f0-9]{24}$/.test(paperId) || (category !== "auto" && !PAPER_CATEGORIES.includes(category))) throw new Error("分类参数无效");
      await running; await load();
      if (!latest?.papers.some(paper => paper.id === paperId)) throw new Error("论文不在当前资料库中");
      if (category === "auto") delete manifest.overrides[paperId]; else manifest.overrides[paperId] = category;
      await persist(); await api.schedule(latest, true); return api.status();
    },
    async flush() { await running; },
  };
  return api;
}
