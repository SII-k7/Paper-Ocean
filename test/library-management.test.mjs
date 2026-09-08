import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPdfFile, manageOriginal, reopenManagedPdf, downloadArxivPaper, fetchArxivMetadata, arxivPdfCachePath, saveLibrary, loadLibrary } from "../electron/paper-services.mjs";
import { parseArxivReference, publicationDate } from "../electron/paper-metadata.mjs";

test("managed originals remain readable after the imported file moves and preserve distinct versions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-originals-"));
  try {
    const source = path.join(root, "paper.pdf");
    await fs.writeFile(source, "%PDF-1.4\nversion one\n%%EOF");
    const first = await manageOriginal(root, await readPdfFile(source));
    const stat = await fs.stat(first.path);
    await fs.rename(source, path.join(root, "moved.pdf"));
    const reopened = await reopenManagedPdf(root, source, first.id);
    assert.equal(reopened.id, first.id);
    assert.equal(reopened.path, first.path);
    assert.equal((await fs.stat(first.path)).mtimeMs, stat.mtimeMs, "reading must not rewrite an unchanged original");
    await fs.writeFile(source, "%PDF-1.4\nversion two\n%%EOF");
    const second = await manageOriginal(root, await readPdfFile(source));
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.path, first.path);
    assert.equal((await reopenManagedPdf(root, source, first.id)).id, first.id);
    assert.match(await fs.readFile(first.path, "utf8"), /version one/);
    assert.equal(first.originalPath, source);
    const libraryPath = path.join(root, "library.json");
    const position = { page: 1, y: .45, x: .5, zoom: .3, fitWidth: false };
    await saveLibrary(libraryPath, { papers: [{ ...first, dataBase64: undefined, readingPosition: position }], messagesByScope: {}, openPaperIds: [first.id] });
    assert.deepEqual((await loadLibrary(libraryPath)).papers[0].readingPosition, position, "manual zoom below 65% must survive persistence");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a missing original rejects a changed source and an exact replacement repairs with an archive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-relink-"));
  try {
    const source = path.join(root, "paper.pdf");
    const bytes = "%PDF-1.4\noriginal version\n%%EOF";
    await fs.writeFile(source, bytes);
    const first = await manageOriginal(root, await readPdfFile(source));
    await fs.writeFile(first.path, "broken managed copy");
    await fs.writeFile(source, "%PDF-1.4\nanother version\n%%EOF");
    await assert.rejects(reopenManagedPdf(root, source, first.id), /已变化|重新定位/);
    assert.equal(await fs.readFile(first.path, "utf8"), "broken managed copy");
    await fs.writeFile(source, bytes);
    const repaired = await reopenManagedPdf(root, source, first.id);
    assert.equal(repaired.id, first.id);
    const archived = (await fs.readdir(path.dirname(first.path))).find((name) => name.includes(".before-repair-"));
    assert.ok(archived);
    assert.equal(await fs.readFile(path.join(path.dirname(first.path), archived), "utf8"), "broken managed copy");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("arXiv references preserve requested versions and date precision never invents a month or day", () => {
  assert.deepEqual(parseArxivReference("https://arxiv.org/pdf/1706.03762v1.pdf"), { id: "1706.03762", version: 1, reference: "1706.03762v1" });
  assert.equal(parseArxivReference("https://evil.example/arxiv.org/pdf/1706.03762"), null);
  assert.equal(parseArxivReference("https://arxiv.org.evil.example/pdf/1706.03762"), null);
  assert.equal(parseArxivReference("hep-th/9901001v3").reference, "hep-th/9901001v3");
  assert.equal(publicationDate("2026"), "2026");
  assert.equal(publicationDate("2026/09"), "2026-09");
  assert.equal(publicationDate("2026-09-07T12:00:00Z"), "2026-09-07");
  assert.equal(publicationDate("2025-02-29"), undefined);
  assert.equal(publicationDate("2024-02-29"), "2024-02-29");
  assert.equal(publicationDate("2026-13-01"), undefined);
});

test("versioned metadata pins the downloaded PDF and separates first submission from the current revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-arxiv-versions-"));
  const urls = [];
  const fetcher = async (url) => {
    urls.push(String(url));
    if (String(url).includes("/pdf/")) return new Response(`%PDF-1.4\n${url}\n%%EOF`);
    return new Response('<feed><entry xmlns="http://www.w3.org/2005/Atom"><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention</title><summary>Evidence</summary><author><name>Ada</name></author><published>2017-06-12T17:57:34Z</published><updated>2023-08-02T00:41:18Z</updated></entry></feed>');
  };
  try {
    const opened = await downloadArxivPaper("1706.03762", root, fetcher);
    assert.ok(urls.includes("https://arxiv.org/pdf/1706.03762v7"));
    assert.equal(opened.arxivVersion, 7);
    assert.equal(opened.publishedAt, "2017-06-12");
    assert.equal(opened.revisedAt, "2023-08-02");
    assert.deepEqual(opened.authors, ["Ada"]);
    assert.equal(opened.sourceUrl, "https://arxiv.org/abs/1706.03762v7");
    assert.notEqual(arxivPdfCachePath(root, "1706.03762v1"), arxivPdfCachePath(root, "1706.03762v7"));
    const mismatched = await fetchArxivMetadata("1706.03762v1", fetcher);
    assert.equal(mismatched, null, "metadata for another revision is not attached to the requested version");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
