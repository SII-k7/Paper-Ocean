import assert from "node:assert/strict";
import { test } from "node:test";
import { findTextMatches, pageTextWithRanges, searchPdfPages, resolvePdfDestination, safePdfUrl } from "../src/pdf-navigation.mjs";

test("PDF search maps ligatures, whitespace and line-end hyphens back to original text", () => {
  const text = "A ﬂow through trans-\n  duction. FLOW\n through. 机器学习 😀";
  assert.deepEqual(findTextMatches(text, "flow through").map((hit) => text.slice(hit.start, hit.end)), ["ﬂow through", "FLOW\n through"]);
  assert.deepEqual(findTextMatches(text, "transduction").map((hit) => text.slice(hit.start, hit.end)), ["trans-\n  duction"]);
  assert.deepEqual(findTextMatches(text, "😀").map((hit) => text.slice(hit.start, hit.end)), ["😀"]);
  assert.equal(findTextMatches(text, "机器").length, 1);
  assert.equal(findTextMatches("multi-head", "multihead").length, 0);
  assert.deepEqual(findTextMatches(text, "   "), []);
});

test("PDF page search keeps repeated occurrences separate, with a bounded result list", () => {
  const source = pageTextWithRanges([{ str: "Multi-", hasEOL: true }, {}, { str: "head attention" }, { str: " attention", hasEOL: true }]);
  const [hit] = findTextMatches(source.text, "multihead attention");
  assert.equal(hit.start, 0);
  assert.equal(source.text.slice(hit.start, hit.end), "Multi-\nhead attention");
  assert.deepEqual(source.ranges.map(({ index }) => index), [0, 2, 3]);
  const pages = [{ page: 3, text: "attention attention" }, { page: 9, text: "attention" }];
  assert.deepEqual(searchPdfPages(pages, "ATTENTION").map(({ page, occurrence }) => [page, occurrence]), [[3, 0], [3, 1], [9, 0]]);
  assert.equal(searchPdfPages(pages, "attention", 2).length, 2);
});

test("PDF destinations resolve named references to page coordinates and reject out-of-range targets", async () => {
  const document = {
    numPages: 5,
    getDestination: async (name) => name === "section.3" ? [{ num: 42, gen: 0 }, { name: "XYZ" }, 100, 600, null] : null,
    getPageIndex: async (ref) => { assert.deepEqual(ref, { num: 42, gen: 0 }); return 2; },
    getPage: async () => ({ view: [0, 0, 600, 800], getViewport: () => ({ width: 600, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y] }) }),
  };
  assert.deepEqual(await resolvePdfDestination(document, "section.3"), { page: 3, x: 1 / 6, y: .25 });
  assert.deepEqual(await resolvePdfDestination(document, [1, { name: "FitH" }, 400]), { page: 2, x: .5, y: .5 });
  assert.deepEqual(await resolvePdfDestination(document, [0, { name: "FitR" }, 120, 0, 300, 640]), { page: 1, x: .2, y: .2 });
  await assert.rejects(resolvePdfDestination(document, [5, { name: "Fit" }]), /不存在/);
  await assert.rejects(resolvePdfDestination(document, "missing"), /无效/);
});

test("PDF external links allow only explicit HTTPS URLs without embedded credentials", () => {
  assert.equal(safePdfUrl("https://arxiv.org/abs/1706.03762"), "https://arxiv.org/abs/1706.03762");
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com/", "//example.com", "http://example.com"]) assert.equal(safePdfUrl(url), null);
});
