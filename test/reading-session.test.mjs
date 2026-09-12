import assert from "node:assert/strict";
import { test } from "node:test";
import { readingSessionConfig } from "../electron/reading-session.mjs";
import { CodexClient } from "../electron/codex-client.mjs";

test("reading sessions exclude unrelated extensions without mutating user configuration or permissions", () => {
  const config = {
    mcp_servers: { "literal.server": { enabled: true, command: "private-tool", env: { SECRET: "private" } }, disabled: { enabled: false } },
    skills: { config: [{ path: "/skills/old", enabled: false }] },
    hooks: { enabled: true }, approval_policy: "on-request", sandbox_mode: "read-only",
  };
  const original = structuredClone(config);
  const result = readingSessionConfig(config, [{ skills: [{ path: "/skills/a" }, { path: "/skills/old" }] }]);
  assert.deepEqual(config, original);
  assert.deepEqual(result.mcp_servers, { "literal.server": { enabled: false }, disabled: { enabled: false } });
  assert.deepEqual(result["skills.config"], [{ path: "/skills/old", enabled: false }, { path: "/skills/a", enabled: false }]);
  assert.equal(result["memories.use_memories"], false);
  assert.equal(result["memories.generate_memories"], false);
  assert.equal(result["features.plugins"], false);
  assert.equal(result["features.apps"], false);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!Object.keys(result).some(key => /hooks|approval|sandbox|auth/.test(key)));
});

test("discovery runs in the paper directory and degrades safely on an older app-server", async () => {
  const client = new CodexClient(), calls = [], diagnostics = [];
  client.on("diagnostic", item => diagnostics.push(item));
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "skills/list") throw new Error("unsupported");
    return { config: { mcp_servers: { docs: { command: "example" } } } };
  };
  const config = await client.readingConfig("/paper/context");
  assert.deepEqual(calls, [
    { method: "config/read", params: { includeLayers: false, cwd: "/paper/context" } },
    { method: "skills/list", params: { cwds: ["/paper/context"], forceReload: false } },
  ]);
  assert.deepEqual(config.mcp_servers, { docs: { enabled: false } });
  assert.equal(config["memories.use_memories"], false);
  assert.deepEqual(config["skills.config"], []);
  assert.equal(diagnostics.length, 1);
});
