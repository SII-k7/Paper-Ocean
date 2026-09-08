import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url);
const {load}=require("js-yaml");
const version=JSON.parse(await fs.readFile("package.json","utf8")).version;
const platform=process.argv[2];
const manifest=load(await fs.readFile(`release/latest${platform==="linux"?"-linux":""}.yml`,"utf8"));
assert.equal(manifest.version,version);
const expected=platform==="linux" ? [".deb",".AppImage"] : ["-Setup.exe"];
for(const suffix of expected) assert.ok(manifest.files.some(file=>file.url.endsWith(suffix)),`Missing update target ${suffix}`);
for(const file of manifest.files) {
  assert.equal(path.basename(file.url),file.url);
  const target=path.join("release",file.url);
  assert.equal((await fs.stat(target)).size,file.size);
  const hash=createHash("sha512");for await(const bytes of createReadStream(target)) hash.update(bytes);
  assert.equal(hash.digest("base64"),file.sha512);
}
console.log(`${platform}: update manifest targets, versions, sizes and SHA-512 verified`);
