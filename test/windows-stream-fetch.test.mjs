import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { responseFromWindowsProcess, windowsStreamFetch } from "../electron/windows-stream-fetch.mjs";

function processFixture() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", 1)); };
  return child;
}

test("Windows download transport exposes headers before the body and preserves binary bytes", async () => {
  const child = processFixture();
  const promise = responseFromWindowsProcess(child, "GET");
  const metadata = JSON.stringify({ status: 206, headers: { "Content-Range": "bytes 4-7/8", ETag: '"v1"' } });
  child.stdout.write(Buffer.from(metadata.slice(0, 12)));
  child.stdout.write(Buffer.concat([Buffer.from(`${metadata.slice(12)}\n`), Buffer.from([0, 255])]));
  const response = await promise;
  assert.equal(response.status, 206); assert.equal(response.headers.get("etag"), '"v1"');
  const reading = response.arrayBuffer();
  child.stdout.write(Buffer.from([128, 10])); child.stdout.end(); child.emit("close", 0);
  assert.deepEqual(Buffer.from(await reading), Buffer.from([0, 255, 128, 10]));
});

test("cancelling a Windows response stops its helper and interrupted output rejects the reader", async () => {
  const child = processFixture();
  const promise = responseFromWindowsProcess(child, "GET");
  child.stdout.write('{"status":200,"headers":{}}\n');
  const response = await promise;
  await response.body.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, true);
  const interrupted = processFixture();
  const next = responseFromWindowsProcess(interrupted, "GET");
  interrupted.stdout.write('{"status":200,"headers":{}}\npart');
  const reading = (await next).arrayBuffer();
  interrupted.stderr.write("connection reset"); interrupted.emit("close", 1);
  await assert.rejects(reading, /connection reset/);
});

test("Windows stream requests validate destinations, methods and ranges before spawning", async () => {
  await assert.rejects(windowsStreamFetch("https://example.org/file.pdf"), /不允许/);
  await assert.rejects(windowsStreamFetch("https://arxiv.org/pdf/1706.03762", { method: "POST" }), /不支持/);
  await assert.rejects(windowsStreamFetch("https://arxiv.org/pdf/1706.03762", { headers: { Range: "bytes=1-2,5-6" } }), /Range/);
});
