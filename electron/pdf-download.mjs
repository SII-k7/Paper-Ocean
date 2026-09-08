import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function sizeError(maximumBytes) {
  return Object.assign(new Error(`PDF 超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB，当前操作暂不支持`), { code: "PDF_SIZE_LIMIT" });
}
async function metadata(file, value) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try { await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx" }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
const validValidator = (value) => typeof value === "string" && value.length <= 500 && !/[\r\n]/.test(value) && value.length > 0;
const strongEtag = (value) => validValidator(value) && /^"[^"\r\n]*"$/.test(value);

export async function downloadPdf({ url, filePath, fetcher = globalThis.fetch, signal, onProgress = () => {}, maximumBytes = 100 * 1024 * 1024 }) {
  const partial = `${filePath}.part`, sidecar = `${partial}.json`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let saved;
  try { saved = (await fs.stat(sidecar)).size <= 16384 ? JSON.parse(await fs.readFile(sidecar, "utf8")) : null; } catch { saved = null; }
  let received = (await fs.stat(partial).catch(() => null))?.size ?? 0;
  if (received > maximumBytes) throw sizeError(maximumBytes);
  const validator = saved?.url === url && (strongEtag(saved.etag) ? saved.etag : validValidator(saved.lastModified) ? saved.lastModified : null);
  if (!validator || received >= maximumBytes) received = 0;
  signal?.throwIfAborted();

  // One restart is allowed when an origin ignores Range or changes validators.
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { "User-Agent": "PaperOcean/0.4 local-reader", "Accept-Encoding": "identity" };
    if (received) { headers.Range = `bytes=${received}-`; headers["If-Range"] = validator; }
    onProgress({ phase: "downloading", received, resumed: received > 0 });
    const response = await fetcher(url, { headers, signal, paperOceanStream: true });
    if (response.status === 416 && received) { await response.body?.cancel(); received = 0; continue; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`arXiv 下载失败（HTTP ${response.status}）`); }
    let total;
    const advertised = response.headers.get("content-length");
    const length = advertised !== null && /^\d+$/.test(advertised) ? Number(advertised) : undefined;
    const etag = response.headers.get("etag"), lastModified = response.headers.get("last-modified");
    if (response.status === 206) {
      const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const sameVersion = strongEtag(saved?.etag) ? saved.etag === etag : saved?.lastModified === lastModified;
      if (!range || !received || Number(range[1]) !== received || Number(range[2]) < received || Number(range[3]) <= Number(range[2]) || (length !== undefined && length !== Number(range[2]) - received + 1) || !sameVersion) {
        await response.body?.cancel(); received = 0;
        if (attempt) throw new Error("服务器返回了不匹配的续传数据，请重新下载。");
        continue;
      }
      total = Number(range[3]);
    } else {
      received = 0; total = length;
    }
    if (total !== undefined && (!Number.isSafeInteger(total) || total > maximumBytes)) { await response.body?.cancel(); throw sizeError(maximumBytes); }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") { await response.body?.cancel(); throw new Error("服务器返回了无法安全续传的压缩内容。"); }
    const resumed = received > 0;
    const file = await fs.open(partial, resumed ? "a" : "w");
    let complete = false, discard = false;
    try {
      await metadata(sidecar, { url, etag: strongEtag(etag) ? etag : undefined, lastModified: validValidator(lastModified) ? lastModified : undefined, total });
      const chunks = response.body ?? [Buffer.from(await response.arrayBuffer())];
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        const buffer = Buffer.from(chunk);
        if (received + buffer.length > maximumBytes) throw sizeError(maximumBytes);
        if (total !== undefined && received + buffer.length > total) throw new Error("下载内容超过服务器声明的长度，未替换原文件。");
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
          if (!bytesWritten) throw new Error("无法写入 PDF 下载文件。");
          offset += bytesWritten;
        }
        received += buffer.length;
        onProgress({ phase: "downloading", received, total, resumed });
      }
      signal?.throwIfAborted();
      if (total !== undefined && received !== total) throw new Error("PDF 下载中断，已保留可续传的部分。");
      await file.sync();
      complete = true;
    } catch (error) {
      discard = error?.code === "PDF_SIZE_LIMIT";
      throw error;
    } finally {
      if (!complete) { await file.sync().catch(() => undefined); await response.body?.cancel().catch(() => undefined); }
      await file.close();
      if (discard) { await fs.rm(partial, { force: true }); await fs.rm(sidecar, { force: true }); }
    }
    onProgress({ phase: "verifying", received, total: total ?? received, resumed });
    const handle = await fs.open(partial, "r");
    let valid;
    try {
      const prefix = Buffer.alloc(5), tail = Buffer.alloc(Math.min(received, 65536));
      await handle.read(prefix, 0, prefix.length, 0);
      await handle.read(tail, 0, tail.length, Math.max(0, received - tail.length));
      valid = prefix.toString() === "%PDF-" && tail.includes(Buffer.from("%%EOF"));
    } finally { await handle.close(); }
    if (!valid) {
      // Derived partial data must not be reused as a finished original.
      await fs.rm(sidecar, { force: true });
      throw new Error("下载内容不是完整 PDF，未替换原文件。");
    }
    await fs.rename(partial, filePath);
    await fs.rm(sidecar, { force: true });
    onProgress({ phase: "complete", received, total: received, resumed });
    return filePath;
  }
  throw new Error("服务器不支持这次续传，请重试完整下载。");
}
