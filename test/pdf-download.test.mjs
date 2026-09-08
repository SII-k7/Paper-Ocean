import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadPdf } from "../electron/pdf-download.mjs";

const PDF = Buffer.from(`%PDF-1.7\n${"x".repeat(200)}\n%%EOF\n`);
const URL = "https://arxiv.org/pdf/1706.03762v7";
async function workspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-stream-"));
  try { await run(path.join(root, "paper.pdf")); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function stream(chunks) {
  let index = 0;
  return new ReadableStream({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); } });
}

test("PDF download reports incremental bytes and resumes a cancelled transfer using Range and If-Range", async () => workspace(async (filePath) => {
  const controller = new AbortController(), progress = [];
  await assert.rejects(downloadPdf({ url: URL, filePath, signal: controller.signal, onProgress: (value) => { progress.push(value); if (value.received === 50) controller.abort(); }, fetcher: async () => new Response(stream([PDF.subarray(0, 50), PDF.subarray(50)]), { headers: { etag: '"version-seven"', "content-length": String(PDF.length) } }) }), /abort/i);
  assert.equal((await fs.stat(`${filePath}.part`)).size, 50);
  assert.equal(progress.at(-1).received, 50);
  await downloadPdf({ url: URL, filePath, fetcher: async (_url, options) => {
    assert.equal(options.headers.Range, "bytes=50-"); assert.equal(options.headers["If-Range"], '"version-seven"');
    return new Response(PDF.subarray(50), { status: 206, headers: { etag: '"version-seven"', "content-range": `bytes 50-${PDF.length - 1}/${PDF.length}`, "content-length": String(PDF.length - 50) } });
  } });
  assert.deepEqual(await fs.readFile(filePath), PDF);
  await assert.rejects(fs.stat(`${filePath}.part`), { code: "ENOENT" });
}));

test("a changed validator or ignored Range restarts without concatenating different versions", async () => workspace(async (filePath) => {
  await fs.writeFile(`${filePath}.part`, PDF.subarray(0, 50));
  await fs.writeFile(`${filePath}.part.json`, JSON.stringify({ url: URL, etag: '"old"' }));
  let calls = 0;
  await downloadPdf({ url: URL, filePath, fetcher: async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(PDF.subarray(50), { status: 206, headers: { etag: '"new"', "content-range": `bytes 50-${PDF.length - 1}/${PDF.length}` } });
    assert.equal(options.headers.Range, undefined);
    return new Response(PDF, { headers: { etag: '"new"', "content-length": String(PDF.length) } });
  } });
  assert.equal(calls, 2); assert.deepEqual(await fs.readFile(filePath), PDF);
  await fs.writeFile(`${filePath}.part`, PDF.subarray(0, 50));
  await fs.writeFile(`${filePath}.part.json`, JSON.stringify({ url: URL, etag: '"old"' }));
  await downloadPdf({ url: URL, filePath, fetcher: async () => new Response(PDF, { headers: { etag: '"new"' } }) });
  assert.deepEqual(await fs.readFile(filePath), PDF);
}));

test("oversized, truncated and non-PDF responses never replace a usable downloaded file", async () => workspace(async (filePath) => {
  await fs.writeFile(filePath, PDF);
  let cancelled = false;
  await assert.rejects(downloadPdf({ url: URL, filePath, maximumBytes: 100, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(200)); }, cancel() { cancelled = true; } })) }), { code: "PDF_SIZE_LIMIT" });
  assert.equal(cancelled, true);
  await assert.rejects(downloadPdf({ url: URL, filePath, fetcher: async () => new Response(PDF.subarray(0, 50), { headers: { "content-length": String(PDF.length) } }) }), /中断/);
  await assert.rejects(downloadPdf({ url: URL, filePath, fetcher: async () => new Response("%PDF-1.7\ntruncated") }), /不是完整 PDF/);
  assert.deepEqual(await fs.readFile(filePath), PDF);
}));
