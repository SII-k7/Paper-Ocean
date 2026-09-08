import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createDownloadJobs } from "../electron/download-jobs.mjs";

test("download jobs cancel a running operation, preserve progress, and deduplicate an active request", async () => {
  const jobs = createDownloadJobs(), id = randomUUID(); let calls = 0;
  const operation = ({ signal, onProgress }) => new Promise((_resolve, reject) => {
    calls++; onProgress({ phase: "downloading", received: 50, total: 100, reference: "1706.03762v7" });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const first = jobs.run(id, "1706.03762", operation), second = jobs.run(id, "1706.03762", operation);
  const outcomes = Promise.allSettled([first, second]);
  await Promise.resolve(); assert.equal(jobs.status(id).received, 50);
  assert.equal(jobs.hasActive(), true); jobs.cancel(id);
  assert.deepEqual((await outcomes).map((value) => value.status), ["rejected", "rejected"]);
  assert.equal(calls, 1); assert.equal(jobs.status(id).phase, "paused"); assert.equal(jobs.hasActive(), false);
  assert.equal(jobs.status(id).controller, undefined);
});

test("early cancellation prevents a racing start, and shutdown waits for resource cleanup", async () => {
  const jobs = createDownloadJobs(), early = randomUUID(); jobs.cancel(early);
  await assert.rejects(jobs.run(early, "1706.03762", () => assert.fail("cancelled job started")), /暂停/);
  let cleaned = false;
  const operation = jobs.run(randomUUID(), "1706.03762", ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; reject(signal.reason); }, 10), { once: true });
  }));
  const rejected = assert.rejects(operation, /暂停/);
  await Promise.resolve(); await jobs.close(); await rejected;
  assert.equal(cleaned, true); assert.equal(jobs.hasActive(), false);
});
