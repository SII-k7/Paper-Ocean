import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  extractArxivId,
  loadLibrary,
  prepareConversationContext,
  saveLibrary,
  savePaperContext,
} from "../electron/paper-services.mjs";
import { normalizeRecommendation, rankRecommendations } from "../electron/recommendations.mjs";
import { windowsSystemFetch } from "../electron/windows-fetch.mjs";

test("extractArxivId accepts modern ids and arXiv links", () => {
  assert.equal(extractArxivId("1706.03762"), "1706.03762");
  assert.equal(extractArxivId("https://arxiv.org/abs/1706.03762v7"), "1706.03762");
  assert.equal(extractArxivId("https://arxiv.org/pdf/2501.12345.pdf"), "2501.12345");
});

test("extractArxivId accepts legacy ids and rejects unrelated urls", () => {
  assert.equal(extractArxivId("hep-th/9901001"), "hep-th/9901001");
  assert.equal(extractArxivId("https://example.com/paper.pdf"), null);
});

test("normalizeRecommendation creates an arXiv-openable card", () => {
  const result = normalizeRecommendation({
    paperId: "s2-id",
    title: "Example paper",
    authors: [{ name: "Ada" }, { name: "Lin" }],
    year: new Date().getFullYear(),
    abstract: "A compact abstract.",
    externalIds: { ArXiv: "2501.12345" },
    citationCount: 42,
  });

  assert.equal(result.arxivId, "2501.12345");
  assert.equal(result.url, "https://arxiv.org/abs/2501.12345");
  assert.deepEqual(result.authors, ["Ada", "Lin"]);
  assert.ok(result.score > 0.5);
  assert.match(result.reason, /相关|代表作/);
});

test("recommendations are limited to the latest three years and ranked by relevance plus fame", () => {
  const currentYear = 2026;
  const ranked = rankRecommendations({ title: "Efficient attention models" }, [
    {
      paperId: "old-famous",
      title: "Efficient attention models from the past",
      year: 2023,
      arxivId: "2301.00001",
      citationCount: 50_000,
      _sourceRelevance: 1,
    },
    {
      paperId: "recent-relevant",
      title: "Efficient attention for long context models",
      year: 2025,
      arxivId: "2501.00001",
      citationCount: 140,
      _sourceRelevance: 0.95,
    },
    {
      paperId: "recent-weaker",
      title: "Attention in modern systems",
      year: 2024,
      arxivId: "2401.00001",
      citationCount: 12,
      _sourceRelevance: 0.62,
    },
    {
      paperId: "not-openable",
      title: "Efficient attention without arXiv",
      year: 2026,
      citationCount: 900,
      _sourceRelevance: 1,
    },
  ], currentYear);

  assert.deepEqual(ranked.map((paper) => paper.paperId), ["recent-relevant", "recent-weaker"]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked.every((paper) => paper.year >= 2024 && paper.arxivId));
});

test("library state can be atomically replaced", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-library-test-"));
  const filePath = path.join(tempRoot, "library.json");
  try {
    const base = { papers: [], messagesByScope: {}, threadsByScope: {}, aiSettingsByScope: {}, openPaperIds: [] };
    await saveLibrary(filePath, { ...base, lastPaperId: "first" });
    await saveLibrary(filePath, { ...base, lastPaperId: "second" });
    assert.equal((await loadLibrary(filePath)).lastPaperId, "second");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("legacy single-paper conversations migrate into scoped conversations", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-migration-test-"));
  const filePath = path.join(tempRoot, "library.json");
  try {
    await saveLibrary(filePath, {
      papers: [{
        id: "legacy-paper",
        title: "Legacy paper",
        name: "legacy.pdf",
        path: "legacy.pdf",
        threadId: "legacy-thread",
        openedAt: 1,
      }],
      messagesByPaper: {
        "legacy-paper": [{ id: "m1", role: "user", text: "hello", createdAt: 1 }],
      },
      lastPaperId: "legacy-paper",
    });
    const migrated = await loadLibrary(filePath);
    assert.equal(migrated.messagesByScope["paper:legacy-paper"][0].text, "hello");
    assert.equal(migrated.threadsByScope["paper:legacy-paper"], "legacy-thread");
    assert.deepEqual(migrated.aiSettingsByScope, {});
    assert.deepEqual(migrated.openPaperIds, ["legacy-paper"]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("conversation context contains the complete page-indexed text of every selected paper", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-context-test-"));
  const papers = [
    { id: "paper-a", title: "Paper A", name: "a.pdf", path: "a.pdf", openedAt: 1 },
    { id: "paper-b", title: "Paper B", name: "b.pdf", path: "b.pdf", openedAt: 2 },
  ];
  try {
    await savePaperContext(tempRoot, {
      paper: papers[0],
      pages: [{ page: 1, text: "alpha page one" }, { page: 2, text: "alpha conclusion" }],
    });
    await savePaperContext(tempRoot, {
      paper: papers[1],
      pages: [{ page: 1, text: "beta page one" }, { page: 2, text: "beta conclusion" }],
    });
    const context = await prepareConversationContext(tempRoot, { scopeKey: "all", papers });
    assert.equal(context.paperCount, 2);
    assert.equal(context.entries.length, 3);
    const combined = (await Promise.all(
      context.entries.filter((entry) => entry.kind === "untrusted").map((entry) => fs.readFile(entry.path, "utf8")),
    )).join("\n");
    assert.match(combined, /alpha conclusion/);
    assert.match(combined, /beta conclusion/);
    assert.match(combined, /第 2 页/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Windows system fetch rejects hosts outside the paper-service allowlist", async () => {
  await assert.rejects(() => windowsSystemFetch("https://example.com/paper"), /不允许访问/);
});
