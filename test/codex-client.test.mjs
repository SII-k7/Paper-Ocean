import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  codexAppServerArgs,
  normalizeModelCatalog,
  resolveCodexExecutable,
  splitAdditionalContextValue,
  codexSpawnEnvironment,
} from "../electron/codex-client.mjs";

test("Linux desktop discovers user-local Codex and adds its directory to the child PATH", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-linux-"));
  try {
    const executable = path.join(home,".local","bin","codex");
    await fs.mkdir(path.dirname(executable),{recursive:true}); await fs.writeFile(executable,"fixture");
    assert.equal(resolveCodexExecutable({}, {platform:"linux",homeDir:home}),executable);
    assert.ok(codexSpawnEnvironment(executable,{PATH:"/usr/bin"},"linux").PATH.includes(path.dirname(executable)));
    assert.deepEqual(codexSpawnEnvironment(executable,{PATH:"original"},"win32"),{PATH:"original"});
  } finally {await fs.rm(home,{recursive:true,force:true});}
});

test("Paper Ocean starts Codex app-server on the stable HTTP streaming transport", () => {
  assert.deepEqual(codexAppServerArgs(), [
    "--disable",
    "responses_websockets",
    "--disable",
    "responses_websockets_v2",
    "app-server",
  ]);
});

test("selected paper excerpts are losslessly split below the Codex context limit", () => {
  const source = `selected ${"A".repeat(1_700)} ${"海".repeat(400)} end`;
  const chunks = splitAdditionalContextValue(source);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 800));
});

test("model catalog keeps Luna and does not fall back to older models", () => {
  const models = normalizeModelCatalog({data: [
    {id: "gpt-5.6-luna", supportedReasoningEfforts: [{reasoningEffort:"max"}], defaultReasoningEffort:"max"},
    {id: "gpt-5.6-sol", supportedReasoningEfforts: ["max"]},
    {id: "gpt-5.6-luna", hidden:true, supportedReasoningEfforts:["max"]},
  ]});
  assert.deepEqual(models.map(model => model.id), ["gpt-5.6-luna"]);
  assert.deepEqual(models[0].supportedEfforts, ["max"]);
});

test("reading requests override legacy settings with Luna max", async () => {
  const {CodexClient} = await import("../electron/codex-client.mjs");
  const client = new CodexClient(), calls=[];
  client.start = async () => {};
  client.models = async () => [{id:"gpt-5.6-luna",supportedEfforts:["max","high"],defaultEffort:"high"}];
  client.request = async (method,params) => { calls.push({method,params}); return {thread:{id:"test-thread"},turn:{id:"test-turn"}}; };
  await client.startThread({contextDir:".",title:"Fixture",model:"gpt-6-astra"});
  await client.sendTurn({contextDir:".",threadId:"test-thread",prompt:"Read",model:"gpt-6-astra",effort:"medium"});
  assert.equal(calls[0].params.model,"gpt-5.6-luna");
  assert.equal(calls[1].params.model,"gpt-5.6-luna");
  assert.equal(calls[1].params.effort,"max");
  client.models = async () => [{id:"gpt-5.6-luna",supportedEfforts:["high"]}];
  await assert.rejects(client.sendTurn({prompt:"Read"}), /Luna max/);
  assert.equal(calls.length,2);
});

test("manual Codex executable path wins on macOS", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-codex-path-"));
  const executable = path.join(tempRoot, "codex");
  try {
    await fs.writeFile(executable, "placeholder", "utf8");
    assert.equal(resolveCodexExecutable(
      { PAPER_OCEAN_CODEX_PATH: executable },
      { platform: "darwin", homeDir: tempRoot },
    ), executable);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("account status does not proactively refresh a token", async () => {
  const client = new (await import("../electron/codex-client.mjs")).CodexClient();
  let request;
  client.start = async () => undefined;
  client.request = async (method, params) => {
    request = { method, params };
    return { account: null, requiresOpenaiAuth: true };
  };

  assert.deepEqual(await client.account(), {
    connected: false,
    accountType: null,
    planType: null,
    codexPath: client.executable,
  });
  assert.deepEqual(request, {
    method: "account/read",
    params: { refreshToken: false },
  });
});

test("ChatGPT login starts directly without waiting for account/read", async () => {
  const client = new (await import("../electron/codex-client.mjs")).CodexClient();
  const calls = [];
  client.start = async () => calls.push("start");
  client.account = async () => {
    throw new Error("login must not wait for account/read");
  };
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return { type: "chatgpt", authUrl: "https://auth.openai.com/example", loginId: "login-1" };
  };

  const result = await client.login();
  assert.equal(result.authUrl, "https://auth.openai.com/example");
  assert.deepEqual(calls, [
    "start",
    {
      method: "account/login/start",
      params: {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt",
      },
      timeoutMs: 10_000,
    },
  ]);
});

test("ChatGPT login restarts a wedged app-server once", async () => {
  const client = new (await import("../electron/codex-client.mjs")).CodexClient();
  let attempts = 0;
  let stops = 0;
  client.start = async () => undefined;
  client.stop = async () => { stops += 1; };
  client.request = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("account/login/start 请求超时");
      error.code = "CODEX_REQUEST_TIMEOUT";
      throw error;
    }
    return { type: "chatgpt", authUrl: "https://auth.openai.com/retry", loginId: "login-2" };
  };

  const result = await client.login();
  assert.equal(result.authUrl, "https://auth.openai.com/retry");
  assert.equal(attempts, 2);
  assert.equal(stops, 1);
});
