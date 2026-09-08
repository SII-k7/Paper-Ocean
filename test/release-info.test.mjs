import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRelease, newerRelease } from "../src/release-info.mjs";
test("release comparisons respect numeric versions and never interpret preview tags as stable upgrades", async () => {
  assert.equal(newerRelease("v0.10.0", "0.9.9"), true);
  assert.equal(newerRelease("v0.4.0", "0.4.0"), false);
  assert.equal(newerRelease("v0.3.9", "0.4.0"), false);
  assert.equal(newerRelease("v0.5.0-beta.1", "0.4.0"), null);
  const result = await checkRelease("0.4.0", async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/SII-k7/Paper-Ocean/releases/latest"); assert.equal(options.credentials, "omit");
    return Response.json({ tag_name: "v0.5.0", html_url: "https://malicious.example/installer" });
  });
  assert.equal(result.url, "https://github.com/SII-k7/Paper-Ocean/releases/tag/v0.5.0"); assert.equal(result.newer, true);
  await assert.rejects(checkRelease("0.4.0", async () => new Response(null, { status: 403 })), /限制/);
  await assert.rejects(checkRelease("0.4.0", async () => new Response(null, { status: 404 })), /尚未找到公开正式版本/);
  await assert.rejects(checkRelease("0.4.0", async () => { throw new TypeError("Failed to fetch"); }), /暂时无法连接 GitHub/);
  await assert.rejects(checkRelease("0.4.0", async () => Response.json({ tag_name: "v0.5.0", prerelease: true })), /无法比较/);
});
