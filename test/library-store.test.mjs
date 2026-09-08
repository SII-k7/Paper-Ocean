import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLibrary, saveLibrary, recoverLibrary, flushLibraryWrites } from "../electron/paper-services.mjs";

const state = (title) => ({ papers: [{ id: "paper-one", title }], openPaperIds: ["paper-one"], messagesByScope: {}, threadsByScope: {}, aiSettingsByScope: {} });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "library.json");
}

test("first launch is empty but corrupt, incomplete and inaccessible libraries never become empty", async (t) => {
  const file = await fixture(t);
  assert.deepEqual((await loadLibrary(file)).papers, []);
  for (const raw of ['{"papers":[', '{}', '{"papers":[null]}', '{"papers":[],"messagesByScope":{"all":null}}']) {
    await fs.writeFile(file, raw);
    await assert.rejects(loadLibrary(file), /损坏|不完整/);
    await assert.rejects(saveLibrary(file, state("new")), /损坏|不完整/);
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }
  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(loadLibrary(file), /无法读取|损坏|不完整/);
});

test("concurrent saves keep invocation order, snapshot isolation and the previous committed backup", async (t) => {
  const file = await fixture(t);
  const snapshots = Array.from({ length: 20 }, (_, i) => state(`revision ${i}`));
  const promises = snapshots.map((snapshot) => saveLibrary(file, snapshot));
  snapshots[19].papers[0].title = "mutated after save";
  await Promise.all(promises);
  await flushLibraryWrites(file);
  assert.equal((await loadLibrary(file)).papers[0].title, "revision 19");
  assert.equal(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")).papers[0].title, "revision 18");
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["library.json", "library.json.bak"]);
});

test("recovery archives the damaged original and does not overwrite a usable backup", async (t) => {
  const file = await fixture(t);
  await saveLibrary(file, state("first"));
  await saveLibrary(file, state("second"));
  const broken = '{"papers": [broken';
  await fs.writeFile(file, broken);
  await assert.rejects(loadLibrary(file));
  assert.equal((await recoverLibrary(file)).papers[0].title, "first");
  const archived = (await fs.readdir(path.dirname(file))).find((name) => name.includes("before-recovery"));
  assert.equal(await fs.readFile(path.join(path.dirname(file), archived), "utf8"), broken);
  assert.equal(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")).papers[0].title, "first");
  await saveLibrary(file, state("after recovery"));
  assert.equal((await loadLibrary(file)).papers[0].title, "after recovery");
});

test("a missing primary with a backup requires recovery, not first-run initialization", async (t) => {
  const file = await fixture(t);
  await saveLibrary(file, state("first"));
  await fs.rm(file);
  await assert.rejects(loadLibrary(file), /主文件缺失/);
  await assert.rejects(saveLibrary(file, state("empty replacement")), /主文件缺失/);
  assert.equal((await recoverLibrary(file)).papers[0].title, "first");
});

test("failed recovery leaves both originals untouched and a failed write does not poison the queue", async (t) => {
  const file = await fixture(t);
  await fs.writeFile(file, "broken");
  await fs.writeFile(`${file}.bak`, "also broken");
  await assert.rejects(recoverLibrary(file));
  assert.equal(await fs.readFile(file, "utf8"), "broken");
  assert.equal(await fs.readFile(`${file}.bak`, "utf8"), "also broken");
  await assert.rejects(saveLibrary(file, state("rejected")));
  await fs.writeFile(file, JSON.stringify(state("repaired manually")));
  await saveLibrary(file, state("saved afterwards"));
  assert.equal((await loadLibrary(file)).papers[0].title, "saved afterwards");
});

test("interrupted assistant output is preserved without a permanent pending spinner", async (t) => {
  const file = await fixture(t);
  const snapshot = state("paper");
  snapshot.messagesByScope.all = [{ id: "reply", role: "assistant", text: "Partial answer", pending: true }];
  await saveLibrary(file, snapshot);
  const reply = (await loadLibrary(file)).messagesByScope.all[0];
  assert.equal(reply.text, "Partial answer");
  assert.equal(reply.pending, false);
  assert.equal(reply.error, true);
});
