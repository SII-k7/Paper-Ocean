import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  codexAppServerArgs,
  PAPER_OCEAN_PROVIDER,
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
    "-c",
    'model_provider="paper_ocean_http"',
    "-c",
    'model_providers.paper_ocean_http={name="Paper Ocean HTTP",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
    "app-server",
  ]);
});

test("new and persisted threads explicitly select HTTP, including threads saved with another provider", async () => {
  const { CodexClient } = await import("../electron/codex-client.mjs");
  const client = new CodexClient(), calls = [];
  client.start = async () => {};
  client.models = async () => [{id:"gpt-5.6-luna",supportedEfforts:["max"]}];
  client.request = async (method, params) => {
    calls.push({method, params});
    return {thread:{id:params.threadId || "new-thread"}};
  };
  await client.startThread({contextDir:".",title:"Fixture"});
  await client.resumeThread({threadId:"existing-openai-thread",contextDir:"."});
  assert.deepEqual(calls.map(call => call.method), ["thread/start", "thread/resume"]);
  for (const {params} of calls) {
    assert.equal(params.modelProvider, PAPER_OCEAN_PROVIDER);
    assert.equal(params.sandbox, "read-only");
    assert.equal(params.approvalPolicy, "never");
  }
  assert.equal(calls[1].params.threadId,"existing-openai-thread");
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

test("Fast uses catalog tier ID, standard explicitly resets it, unavailable Fast stays standard", async () => {
  const { CodexClient } = await import("../electron/codex-client.mjs");
  const client = new CodexClient(), calls = [];
  client.start = async () => {};
  client.models = async () => normalizeModelCatalog({ data: [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["max"], serviceTiers: [{ id: "priority", name: "Fast" }] }] });
  client.request = async (method, params) => { calls.push(params); return { thread: { id: "t" }, turn: { id: "turn" } }; };
  await client.startThread({ contextDir: ".", title: "Fast" });
  await client.sendTurn({ threadId: "t", contextDir: ".", prompt: "Read" });
  await client.sendTurn({ threadId: "t", contextDir: ".", prompt: "Read", serviceTier: null });
  assert.deepEqual(calls.map(call => call.serviceTier), ["priority", "priority", null]);
  assert.equal(calls[1].effort, "max");
  client.models = async () => [{ id: "gpt-5.6-luna", supportedEfforts: ["max"] }];
  const result = await client.sendTurn({ threadId: "t", contextDir: ".", prompt: "Read" });
  assert.equal(result.serviceTier, null);
});

test("warm threads skip resume; changed context, failed resume and stopped server cannot reuse cache", async () => {
  const { CodexClient } = await import("../electron/codex-client.mjs");
  const client = new CodexClient(), calls = [];
  client.start = async () => {};
  client.models = async () => [{ id: "gpt-5.6-luna", supportedEfforts: ["max"] }];
  client.request = async (method) => { calls.push(method); return { thread: { id: "t" } }; };
  await client.startThread({ contextDir: ".", title: "Fixture" });
  await client.resumeThread({ threadId: "t", contextDir: "." });
  assert.deepEqual(calls, ["thread/start"]);
  await client.resumeThread({ threadId: "t", contextDir: "changed" });
  assert.deepEqual(calls, ["thread/start", "thread/resume"]);
  await client.stop();
  await client.resumeThread({ threadId: "t", contextDir: "changed" });
  assert.equal(calls.length, 3);
  client.request = async () => { throw new Error("unavailable"); };
  await assert.rejects(client.resumeThread({ threadId: "other", contextDir: "." }), /unavailable/);
  assert.equal(client.loadedThreads.has("other"), false);
});

test("parallel context reads preserve every byte and trust kind; unreadable context never starts a turn", async () => {
  const { CodexClient } = await import("../electron/codex-client.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-context-read-"));
  try {
    const entries = await Promise.all(Array.from({ length: 35 }, async (_, index) => {
      const file = path.join(root, `${index}.md`);
      await fs.writeFile(file, `第 ${index} 页：海洋 ${"x".repeat(index)}`);
      return { key: `paper-${index}`, path: file, kind: index === 0 ? "application" : "untrusted" };
    }));
    const client = new CodexClient(); let sent, calls = 0;
    client.start = async () => {};
    client.models = async () => [{ id: "gpt-5.6-luna", supportedEfforts: ["max"] }];
    client.request = async (_method, params) => { sent = params; calls++; return { turn: { id: "turn" } }; };
    await client.sendTurn({ threadId: "t", contextDir: root, entries, prompt: "Read" });
    for (const [index, entry] of entries.entries()) assert.deepEqual(sent.additionalContext[entry.key], { value: `第 ${index} 页：海洋 ${"x".repeat(index)}`, kind: entry.kind });
    await assert.rejects(client.sendTurn({ threadId: "t", contextDir: root, entries: [...entries, { key: "missing", path: path.join(root, "missing") }], prompt: "Read" }), /ENOENT/);
    assert.equal(calls, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
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
