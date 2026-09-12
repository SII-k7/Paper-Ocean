import test from "node:test";
import assert from "node:assert/strict";
import { createComposerDraftBuffer } from "../src/composer-draft.mjs";

function clock() {
  let id = 0;
  const tasks = new Map();
  return { schedule(fn, delay) { assert.equal(delay, 300); tasks.set(++id, fn); return id; }, cancel(id) { tasks.delete(id); }, tick() { const pending = [...tasks.values()]; tasks.clear(); pending.forEach(fn => fn()); }, get size() { return tasks.size; } };
}

test("typing stays local and coalesces to one latest draft", () => {
  const timer = clock(), writes = [];
  const buffer = createComposerDraftBuffer("paper:a", "", value => writes.push(value), timer);
  buffer.edit("请"); buffer.edit("请解释"); buffer.edit("请解释公式");
  assert.equal(buffer.value, "请解释公式"); assert.deepEqual(writes, []); assert.equal(timer.size, 1);
  timer.tick(); assert.deepEqual(writes, ["请解释公式"]);
});

test("scope change flushes through the original owner and cancels its timer", () => {
  const timer = clock(), writes = [];
  const buffer = createComposerDraftBuffer("paper:a", "", value => writes.push(["a", value]), timer);
  buffer.edit("A 的草稿");
  assert.equal(buffer.receive("paper:b", "B 已存草稿", value => writes.push(["b", value])), "B 已存草稿");
  assert.deepEqual(writes, [["a", "A 的草稿"]]); assert.equal(timer.size, 0);
  buffer.edit("B 的新问题"); timer.tick();
  assert.deepEqual(writes, [["a", "A 的草稿"], ["b", "B 的新问题"]]);
});

test("acknowledgement or restored props never replaces active typing", () => {
  const timer = clock(), writes = [];
  const commit = value => writes.push(value);
  const buffer = createComposerDraftBuffer("paper:a", "", commit, timer);
  buffer.edit("first"); buffer.flush(); buffer.edit("first and more");
  assert.equal(buffer.receive("paper:a", "first", commit), "first and more");
  assert.equal(buffer.receive("paper:a", "restored older draft", commit), "first and more");
  timer.tick(); assert.deepEqual(writes, ["first", "first and more"]);
});

test("flush precedes send and accepts a batched clear even without intermediate props", () => {
  const timer = clock(), events = [];
  const commit = value => events.push(["draft", value]);
  const buffer = createComposerDraftBuffer("paper:a", "", commit, timer);
  buffer.edit("question"); buffer.flush(); events.push(["send", buffer.value]);
  assert.deepEqual(events, [["draft", "question"], ["send", "question"]]);
  assert.equal(buffer.receive("paper:a", "", commit), "");
  timer.tick(); assert.equal(events.length, 2);
});

test("save, close, and unmount flushes are synchronous and idempotent", () => {
  const timer = clock(), writes = [];
  const buffer = createComposerDraftBuffer("aux:a", "", value => writes.push(value), timer);
  buffer.edit("尚未到 300ms 的草稿"); buffer.flush(); buffer.flush(); buffer.flush(); timer.tick();
  assert.deepEqual(writes, ["尚未到 300ms 的草稿"]);
});
