import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRecommendationService } from "../electron/recommendation-cache.mjs";
import { rankRecommendations, fetchRecommendations, normalizeRecommendation } from "../electron/recommendations.mjs";

const card = { paperId: "reference", title: "Long short-term memory", year: 1997, publishedAt: "1997", authors: ["Sepp Hochreiter"], url: "https://example.org/lstm", source: "Semantic Scholar", relation: "reference", _sourceRelevance: .9, citationCount: 50000 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } assert.fail("operation did not settle"); }

test("foundations retain older references without arXiv but never relabel similar papers as references", () => {
  const ranked = rankRecommendations({ title: "Attention Is All You Need", mode: "foundations" }, [card, { ...card, paperId: "similar", relation: "similar" }], 2026);
  assert.equal(ranked.length, 1); assert.equal(ranked[0].year, 1997); assert.equal(ranked[0].arxivId, undefined);
  assert.match(ranked[0].reason, /数据库中的引用关系/);
  assert.equal(rankRecommendations({ title: "Attention Is All You Need" }, [card], 2026).length, 0);
  assert.equal(normalizeRecommendation({ title: "X", year: 2024, externalIds: { ArXiv: "https://evil.example/arxiv.org/abs/2401.00001" } }).arxivId, undefined);
  assert.equal(rankRecommendations({ title: "Attention", mode: "foundations" }, [{ ...card, title: "Untitled paper" }], 2026).length, 0);
  const deduped = rankRecommendations({ title: "Attention", mode: "foundations" }, [card, { ...card, paperId: "other-provider", arxivId: "1706.03762" }], 2026);
  assert.equal(deduped.length, 1); assert.equal(deduped[0].arxivId, "1706.03762");
});

test("foundations resolve the exact seed and use outgoing citation endpoints", async () => {
  const calls = [];
  const fetcher = async (value) => {
    const url = new URL(value); calls.push(url);
    if (url.hostname === "api.openalex.org") {
      if (url.searchParams.has("search")) return Response.json({ results: [{ id: "https://openalex.org/W100", display_name: "Attention Is All You Need" }] });
      assert.equal(url.searchParams.get("filter"), "cited_by:W100");
      return Response.json({ results: [{ id: "https://openalex.org/W200", display_name: "Earlier method", publication_year: 1990, publication_date: "1990", cited_by_count: 400, authorships: [] }] });
    }
    if (url.pathname.endsWith("/references")) return Response.json({ data: [{ citedPaper: { ...card, publicationDate: null, externalIds: {} } }] });
    return Response.json({ paperId: "seed", title: "Attention Is All You Need" });
  };
  const items = await fetchRecommendations({ title: "Attention Is All You Need", arxivId: "1706.03762", mode: "foundations" }, fetcher);
  assert.equal(items.length, 2); assert.ok(items.every((item) => item.relation === "reference"));
  assert.equal(items.find((item) => item.paperId === "reference").publishedAt, "1997");
  assert.ok(calls.some((url) => url.pathname.endsWith("/references")));
  assert.ok(!calls.some((url) => url.pathname.includes("forpaper")));
});

test("recommendation cache survives restart, serves stale results immediately and retains them after a failed refresh", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-recommendation-cache-"));
  let clock = Date.UTC(2026, 8, 7), calls = 0, fail = false, release;
  const load = async () => { calls++; if (release) await new Promise((resolve) => { release = resolve; }); if (fail) throw new Error("offline"); return [card]; };
  const input = { title: "Attention", mode: "foundations" };
  try {
    let service = createRecommendationService({ cacheDir: root, load, now: () => clock, ttlMs: 100 });
    assert.equal((await service.get(input)).cache, "fresh");
    service = createRecommendationService({ cacheDir: root, load, now: () => clock, ttlMs: 100 });
    assert.equal((await service.get(input)).cache, "cached"); assert.equal(calls, 1);
    clock += 101; fail = true; release = true;
    const stale = await service.get(input);
    assert.equal(stale.cache, "stale"); assert.equal(stale.pending, true); assert.equal(stale.items[0].paperId, card.paperId);
    await until(() => typeof release === "function"); release(); release = undefined;
    await tick();
    const failed = await service.get(input);
    assert.equal(failed.pending, false); assert.match(failed.error, /offline/); assert.equal(calls, 2);
    fail = false;
    assert.equal((await service.get({ ...input, refresh: true })).cache, "fresh"); assert.equal(calls, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("recommendation queue coalesces identical requests and limits background concurrency", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-recommendation-queue-"));
  let active = 0, maxActive = 0, calls = 0;
  const releases = [];
  const service = createRecommendationService({ cacheDir: root, load: async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.push(resolve)); active--; return [card];
  } });
  try {
    const requests = [service.get({ title: "A" }), service.get({ title: "A" }), service.get({ title: "B" }), service.get({ title: "C" })];
    await until(() => releases.length === 2);
    assert.equal(calls, 2); releases[0](); releases[1]();
    await until(() => releases.length === 3); releases[2]();
    await Promise.all(requests);
    assert.equal(calls, 3); assert.equal(maxActive, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
