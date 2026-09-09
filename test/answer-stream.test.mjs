import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnswerStream } from "../src/answer-stream.mjs";
import { normalizeReadingState } from "../electron/reading-state.mjs";

test("stream keeps earlier items when a later answer completes, and does not duplicate completion", () => {
  const stream = createAnswerStream();
  const delta = (itemId, text) => stream.consume("item/agentMessage/delta", { itemId, delta: text });
  const complete = (id, text) => stream.consume("item/completed", { item: { id, type: "agentMessage", text } });
  assert.equal(delta("a", "先给结论。"), "先给结论。");
  assert.equal(complete("a", "先给结论。"), "先给结论。");
  assert.equal(delta("b", "依据"), "先给结论。\n\n依据");
  assert.equal(complete("b", "依据原文第 2 页。"), "先给结论。\n\n依据原文第 2 页。");
  assert.equal(delta("b", "late"), "先给结论。\n\n依据原文第 2 页。");
  assert.equal(complete("a", "先给结论。"), "先给结论。\n\n依据原文第 2 页。");
  assert.equal(stream.consume("item/reasoning/textDelta", { delta: "private reasoning" }), undefined);
});

test("stream handles completion-only, object deltas and empty completion without losing text", () => {
  const stream = createAnswerStream();
  assert.equal(stream.consume("item/completed", { item: { id: "a", type: "agentMessage", text: "完整段落" } }), "完整段落");
  assert.equal(stream.consume("item/agentMessage/delta", { itemId: "b", delta: { text: "中断前的内容" } }), "完整段落\n\n中断前的内容");
  assert.equal(stream.consume("item/completed", { item: { id: "b", type: "agentMessage", text: "" } }), "完整段落\n\n中断前的内容");
});

test("reading speed survives save/load independently of answer depth", () => {
  const result = normalizeReadingState({ readingPreferencesByScope: { a: { depth: "deep", speed: "standard" }, b: { depth: "brief" } } });
  assert.equal(result.readingPreferencesByScope.a.speed, "standard");
  assert.equal(result.readingPreferencesByScope.a.depth, "deep");
  assert.equal(result.readingPreferencesByScope.b.speed, "fast");
});
