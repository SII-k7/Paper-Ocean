import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibrarySaver } from "../src/library-saver.mjs";

test("close-time flush saves the newest pending edit without waiting for debounce", async () => {
  const written = [];
  const saver = createLibrarySaver(async (state) => written.push(state), () => {}, 60_000);
  saver.schedule({ page: 1 });
  saver.schedule({ page: 7 });
  assert.equal(saver.isDirty(), true);
  await saver.flush();
  assert.deepEqual(written, [{ page: 7 }]);
  assert.equal(saver.isDirty(), false);
});

test("simultaneous flush callers wait for edits arriving during an in-flight write", async () => {
  let release;
  let begin;
  const started = new Promise((resolve) => { begin = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const written = [];
  const saver = createLibrarySaver(async (state) => {
    if (!written.length) { begin(); await gate; }
    written.push(state);
  }, () => {}, 60_000);
  saver.schedule({ page: 1 });
  const first = saver.flush();
  await started;
  saver.schedule({ page: 9 });
  const second = saver.flush();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(written, [{ page: 1 }, { page: 9 }]);
  assert.equal(saver.isDirty(), false);
});

test("save rejection remains dirty and explicit retry preserves the newest edit", async () => {
  let fail = true;
  const statuses = [];
  const written = [];
  const saver = createLibrarySaver(async (state) => {
    if (fail) throw new Error("disk full");
    written.push(state);
  }, (state) => statuses.push(state), 60_000);
  saver.schedule({ page: 4 });
  await assert.rejects(saver.flush(), /disk full/);
  assert.equal(saver.isDirty(), true);
  assert.equal(statuses.at(-1).status, "error");
  saver.schedule({ page: 8 });
  fail = false;
  await saver.flush();
  assert.deepEqual(written, [{ page: 8 }]);
  assert.equal(saver.isDirty(), false);
  assert.equal(statuses.at(-1).status, "saved");
});
