import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAnchor } from "../electron/notes.mjs";
import { loadLibrary, saveLibrary, savePageImage, cachedPageImage } from "../electron/paper-services.mjs";
import { noteMarkdown } from "../src/note-export.mjs";
import { pdfAssetsPlugin } from "../scripts/pdf-assets.mjs";

const first = "a".repeat(24), second = "b".repeat(24);
const anchor = { id: "evidence-1", paperId: first, page: 3, quote: "中文原文：α + β", rects: [{ x: .1, y: .2, width: .3, height: .04 }] };

test("notes survive reopening with cross-paper evidence, archived highlights and original message identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-notes-"));
  try {
    const file = path.join(root, "library.json");
    const note = { id: "note-1", title: "比较", body: "$$A=BC$$\n\n自己的理解", anchors: [anchor, { ...anchor, id: "evidence-2", paperId: second, page: 7 }], sourceMessage: { scopeKey: `paper:${first}`, messageId: "answer-1" }, createdAt: 1, updatedAt: 2 };
    await saveLibrary(file, { papers: [{ id: first }], notes: [note], highlights: [{ ...anchor, color: "pink", createdAt: 1, archivedAt: 3 }] });
    const result = await loadLibrary(file);
    assert.equal(result.notes[0].body, note.body);
    assert.equal(result.notes[0].anchors[1].paperId, second, "missing paper does not erase the note's historical evidence");
    assert.deepEqual(result.notes[0].sourceMessage, note.sourceMessage);
    assert.equal(result.highlights[0].archivedAt, 3);
    assert.equal(result.notes[0].anchors[0].quote, anchor.quote);
    await fs.writeFile(file, JSON.stringify({ papers: [], notes: { lost: true } }));
    await assert.rejects(loadLibrary(file), /损坏|不完整/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("evidence geometry clips to the page and rejects invalid identity, pages and non-finite rectangles", () => {
  assert.equal(normalizeAnchor({ ...anchor, paperId: "../outside" }), undefined);
  assert.equal(normalizeAnchor({ ...anchor, page: 0 }), undefined);
  const result = normalizeAnchor({ ...anchor, rects: [{ x: -.2, y: .9, width: .5, height: .5 }, { x: NaN, y: 0, width: 1, height: 1 }] });
  assert.equal(result.rects.length, 1);
  assert.equal(result.rects[0].x, 0);
  assert.ok(Math.abs(result.rects[0].width - .3) < 1e-9);
  assert.ok(Math.abs(result.rects[0].height - .1) < 1e-9);
});

test("Markdown export retains quotes and AI provenance and points to bundled local page images", () => {
  const note = { title: "*比较*", body: `我的结论 [证据](#paper=${first}&page=3)\n\n$$x^2$$`, anchors: [anchor], sourceMessage: { scopeKey: `paper:${first}`, messageId: "answer-1" } };
  const markdown = noteMarkdown(note, [{ id: first, title: "注意力", sourceUrl: "https://arxiv.org/abs/1706.03762" }], true);
  assert.ok(markdown.includes(`[证据](images/${first}-p3.png)`));
  assert.ok(markdown.includes(`![PDF 第 3 页](images/${first}-p3.png)`));
  assert.ok(markdown.includes(anchor.quote));
  assert.ok(markdown.includes("$$x^2$$"));
  assert.ok(markdown.includes("answer-1"));
  assert.ok(markdown.includes("由 AI 回答转存"));
  assert.ok(!noteMarkdown(note, [], false).includes("images/"));
});

test("page evidence caches only complete PNG files and never reuses the earlier unbound canvas cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-evidence-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD9sAAAAASUVORK5CYII=", "base64");
  try {
    await assert.rejects(savePageImage(root, { paperId: first, page: 1, dataUrl: `data:image/png;base64,${png.subarray(0, 40).toString("base64")}` }), /无效/);
    const saved = await savePageImage(root, { paperId: first, page: 1, dataUrl: `data:image/png;base64,${png.toString("base64")}` });
    assert.equal(await cachedPageImage(root, first, 1), saved);
    assert.equal(await cachedPageImage(root, second, 1), undefined);
    await fs.writeFile(path.join(root, "papers", first, "page-2.png"), png);
    assert.equal(await cachedPageImage(root, first, 2), undefined);
    await fs.truncate(saved, 45);
    assert.equal(await cachedPageImage(root, first, 1), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("offline PDF development assets serve executable fallback modules with JavaScript MIME", async () => {
  let middleware;
  await pdfAssetsPlugin().configureServer({ middlewares: { use(value) { middleware = value; } } });
  for (const [name, type] of [["openjpeg_nowasm_fallback.js", "text/javascript"], ["openjpeg.wasm", "application/wasm"]]) {
    const headers = {};
    let data;
    await middleware({ url: `/pdfjs/wasm/${name}` }, { setHeader(key, value) { headers[key] = value; }, end(value) { data = value; } }, () => assert.fail("asset should be available offline"));
    assert.equal(headers["Content-Type"], type);
    assert.ok(data.length > 1000);
  }
});
