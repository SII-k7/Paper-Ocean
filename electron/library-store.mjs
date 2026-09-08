import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const writes = new Map();
const emptyLibrary = () => ({ papers: [], messagesByScope: {}, threadsByScope: {}, aiSettingsByScope: {}, openPaperIds: [] });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validate(value) {
  if (!object(value) || !Array.isArray(value.papers)
    || value.papers.some((paper) => !object(paper) || typeof paper.id !== "string")) {
    throw new Error("论文清单格式不完整");
  }
  for (const key of ["messagesByScope", "messagesByPaper", "threadsByScope", "aiSettingsByScope"]) {
    if (value[key] !== undefined && !object(value[key])) throw new Error(`${key} 格式不完整`);
  }
  for (const key of ["messagesByScope", "messagesByPaper"]) {
    if (Object.values(value[key] || {}).some((messages) => !Array.isArray(messages)
      || messages.some((message) => !object(message)))) throw new Error("对话记录格式不完整");
  }
  if (value.openPaperIds !== undefined && !Array.isArray(value.openPaperIds)) throw new Error("阅读标签格式不完整");
  for (const key of ["notes", "highlights"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item) => !object(item) || typeof item.id !== "string"))) throw new Error("笔记或高亮格式不完整");
  }
  return value;
}

function storeError(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: "LIBRARY_UNAVAILABLE" });
}

async function readSnapshot(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw storeError("无法读取资料库。请检查文件访问权限；原文件未被修改。", error);
  }
  try {
    return { text, value: validate(JSON.parse(text.replace(/^\uFEFF/, ""))) };
  } catch (error) {
    throw storeError("资料库内容损坏或格式不完整。原文件已保留，可尝试恢复最近备份。", error);
  }
}

function queueKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function enqueue(filePath, operation) {
  const key = queueKey(filePath);
  const result = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(operation);
  writes.set(key, result);
  const clear = () => { if (writes.get(key) === result) writes.delete(key); };
  result.then(clear, clear);
  return result;
}

export async function flushLibraryWrites(filePath) {
  if (filePath) return writes.get(queueKey(filePath));
  await Promise.all([...writes.values()]);
}

async function readExisting(filePath) {
  const snapshot = await readSnapshot(filePath);
  if (!snapshot && await readSnapshot(`${filePath}.bak`)) {
    throw storeError("资料库主文件缺失，但发现最近备份。请恢复备份后继续。");
  }
  return snapshot;
}

export async function readLibrarySnapshot(filePath) {
  await flushLibraryWrites(filePath);
  return (await readExisting(filePath))?.value ?? emptyLibrary();
}

async function atomicWrite(filePath, text) {
  const temporary = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, filePath);
    // The new file is durable before replacement. Persist the directory entry
    // where the platform supports directory fsync (Windows does not).
    if (process.platform !== "win32") {
      const dir = await fs.open(path.dirname(filePath), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function writeLibrarySnapshot(filePath, state) {
  // Capture the caller's snapshot now, not when earlier queued writes finish.
  let serialized;
  try { serialized = JSON.stringify(validate(state), null, 2); }
  catch (error) { return Promise.reject(storeError("资料库状态无效，未覆盖已保存内容。", error)); }
  return enqueue(filePath, async () => {
    const previous = await readExisting(filePath);
    if (previous?.text === serialized) return;
    // Refuse to replace unreadable/corrupt data even if a renderer sends an
    // empty state. Keep the previous committed snapshot, never a failed write.
    await atomicWrite(`${filePath}.bak`, previous?.text ?? serialized);
    await atomicWrite(filePath, serialized);
  });
}

export function recoverLibrarySnapshot(filePath) {
  return enqueue(filePath, async () => {
    const backup = await readSnapshot(`${filePath}.bak`);
    if (!backup) throw storeError("没有可用的资料库备份。原文件未被修改；请从手动备份恢复后重试。");
    // Archive even a valid current file: recovery must remain reversible.
    const archive = `${filePath}.before-recovery-${Date.now()}-${randomUUID()}`;
    try { await fs.copyFile(filePath, archive, 1); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await atomicWrite(filePath, backup.text);
  });
}
