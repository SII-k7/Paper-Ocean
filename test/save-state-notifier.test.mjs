import assert from "node:assert/strict";
import { test } from "node:test";
import { createSaveStateNotifier } from "../src/save-state-notifier.mjs";
import { createLibrarySaver } from "../src/library-saver.mjs";

test("coalesced library writes notify React once per actual saving/saved transition", async () => {
  const notifications = [];
  const written = [];
  const notify = createSaveStateNotifier(state => notifications.push(state));
  const saver = createLibrarySaver(async state => { written.push(state); }, notify, 60_000);
  notify({ status: "saved" });
  for (let revision = 1; revision <= 28; revision++) saver.schedule({ revision });
  await saver.flush();
  await saver.flush();
  assert.deepEqual(written, [{ revision: 28 }]);
  assert.deepEqual(notifications, [{ status: "saving" }, { status: "saved" }]);
});

test("different save errors and recovery remain visible; repeated identical errors are suppressed", async () => {
  const notifications = [];
  const notify = createSaveStateNotifier(state => notifications.push(state));
  notify({ status: "error", error: "disk full" });
  notify({ status: "error", error: "disk full" });
  notify({ status: "error", error: "permission denied" });
  notify({ status: "saving" });
  notify({ status: "saving" });
  notify({ status: "saved" });
  notify({ status: "saved" });
  assert.deepEqual(notifications, [
    { status: "error", error: "disk full" }, { status: "error", error: "permission denied" },
    { status: "saving" }, { status: "saved" },
  ]);
});
