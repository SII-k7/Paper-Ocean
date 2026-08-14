import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaperOceanWebServer, fetchWithOutboundAllowlist } from "../server/web-server.mjs";

const PDF_ONE = Buffer.from("%PDF-1.4\nPaper Ocean web fixture one\n%%EOF\n");
const PDF_TWO = Buffer.from("%PDF-1.4\nPaper Ocean web fixture two\n%%EOF\n");

class FakeCodex extends EventEmitter {
  constructor() {
    super();
    this.turns = [];
  }

  async account() {
    return {
      connected: true,
      accountType: "chatgpt",
      planType: "pro",
      codexPath: "C:\\secret\\codex.exe",
    };
  }

  async login() { return { alreadyConnected: true }; }
  async models() {
    return [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "test",
      defaultEffort: "low",
      supportedEfforts: ["low"],
      isDefault: true,
    }];
  }
  async rateLimits() { return null; }
  async startThread() { return "real-thread-1"; }
  async resumeThread({ threadId }) { return threadId; }
  async sendTurn(input) {
    this.turns.push(input);
    return { turnId: "real-turn-1" };
  }
  async interrupt() {}
  async stop() {}
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withWebServer(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-web-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-web-data-"));
  const port = await freePort();
  const codex = new FakeCodex();
  const viteFactory = async () => ({
    middlewares(_request, response) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Paper Ocean test</title>");
    },
    async close() {},
  });
  const web = await createPaperOceanWebServer({
    port,
    rootDir,
    dataDir,
    codex,
    viteFactory,
    fetcher: async () => new Response("not used", { status: 404 }),
    recommendationsFetcher: async () => [],
  });
  await web.listen();
  try {
    await run({ web, codex, dataDir });
  } finally {
    await web.close();
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function session(web) {
  const response = await fetch(`${web.url}/api/session`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

function mutationHeaders(web, cookie, extra = {}) {
  return {
    Origin: web.url,
    Cookie: cookie,
    "X-Paper-Ocean-CSRF": web.csrfToken,
    ...extra,
  };
}

async function uploadPdf(web, cookie, bytes, filename = "fixture.pdf") {
  const response = await fetch(`${web.url}/api/papers/import`, {
    method: "POST",
    headers: mutationHeaders(web, cookie, {
      "Content-Type": "application/pdf",
      "X-Paper-Ocean-Filename": encodeURIComponent(filename),
    }),
    body: bytes,
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

test("web outbound fetch validates every redirect against the paper-service allowlist", async () => {
  const calls = [];
  const response = await fetchWithOutboundAllowlist(
    async (url, options) => {
      calls.push({ url: url.toString(), redirect: options.redirect });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { Location: "https://export.arxiv.org/pdf/2501.00001" } })
        : new Response(PDF_ONE, { status: 200, headers: { "Content-Type": "application/pdf" } });
    },
    "https://arxiv.org/abs/2501.00001",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { url: "https://arxiv.org/abs/2501.00001", redirect: "manual" },
    { url: "https://export.arxiv.org/pdf/2501.00001", redirect: "manual" },
  ]);

  let unsafeCalls = 0;
  await assert.rejects(
    () => fetchWithOutboundAllowlist(async () => {
      unsafeCalls += 1;
      return new Response(null, { status: 302, headers: { Location: "https://example.com/private" } });
    }, "https://arxiv.org/abs/2501.00001"),
    /不允许访问该论文服务地址/,
  );
  assert.equal(unsafeCalls, 1);
});

test("web runtime rejects DNS rebinding, cross-site mutations, and arbitrary paper paths", async () => {
  await withWebServer(async ({ web }) => {
    const badHost = await new Promise((resolve, reject) => {
      const url = new URL(web.url);
      const request = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: "/api/session",
        headers: { Host: "evil.example" },
      }, resolve);
      request.once("error", reject);
      request.end();
    });
    assert.equal(badHost.statusCode, 421);
    assert.equal(badHost.headers["access-control-allow-origin"], undefined);
    badHost.resume();

    const cookie = await session(web);
    const crossSite = await fetch(`${web.url}/api/library`, {
      method: "PUT",
      headers: {
        ...mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
        Origin: "https://evil.example",
      },
      body: JSON.stringify({}),
    });
    assert.equal(crossSite.status, 403);

    const missingCsrf = await fetch(`${web.url}/api/library`, {
      method: "PUT",
      headers: { Origin: web.url, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingCsrf.status, 403);

    const arbitraryPath = await fetch(`${web.url}/api/papers/reopen`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ handle: "C:\\Windows\\win.ini" }),
    });
    assert.equal(arbitraryPath.status, 400);
  });
});

test("two browser PDF imports stay distinct and persist behind opaque handles", async () => {
  await withWebServer(async ({ web, dataDir }) => {
    const cookie = await session(web);
    const first = await uploadPdf(web, cookie, PDF_ONE, "one.pdf");
    const second = await uploadPdf(web, cookie, PDF_TWO, "two.pdf");
    assert.notEqual(first.id, second.id);
    assert.equal(first.path, `paper:${first.id}`);
    assert.equal(second.path, `paper:${second.id}`);
    assert.equal(first.path.includes(dataDir), false);

    const reopened = await fetch(`${web.url}/api/papers/reopen`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ handle: second.path }),
    });
    const reopenedText = await reopened.text();
    assert.equal(reopened.status, 200, reopenedText);
    const value = JSON.parse(reopenedText);
    assert.equal(value.id, second.id);
    assert.equal(Buffer.from(value.dataBase64, "base64").equals(PDF_TWO), true);
  });
});

test("web Codex endpoints hide executable paths and translate thread and turn ids", async () => {
  await withWebServer(async ({ web, codex }) => {
    const cookie = await session(web);
    const status = await fetch(`${web.url}/api/codex/status`).then((response) => response.json());
    assert.equal(status.connected, true);
    assert.equal("codexPath" in status, false);

    const paper = await uploadPdf(web, cookie, PDF_ONE);
    const contextResponse = await fetch(`${web.url}/api/papers/context`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        paper,
        pages: [{ page: 1, text: "A method, architecture, experiment, and limitation." }],
      }),
    });
    const contextText = await contextResponse.text();
    assert.equal(contextResponse.status, 200, contextText);
    const saved = JSON.parse(contextText);
    assert.equal(saved.paperDir, `context:${paper.id}`);

    const conversationResponse = await fetch(`${web.url}/api/conversations/prepare`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        scopeKey: `paper:${paper.id}`,
        papers: [{ ...paper, ...saved }],
      }),
    });
    const conversationText = await conversationResponse.text();
    assert.equal(conversationResponse.status, 200, conversationText);
    const conversation = JSON.parse(conversationText);

    const startResponse = await fetch(`${web.url}/api/codex/threads/start`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        contextDir: conversation.contextDir,
        title: "Fixture",
        model: "gpt-5.6-sol",
      }),
    });
    const startText = await startResponse.text();
    assert.equal(startResponse.status, 200, startText);
    const { threadId } = JSON.parse(startText);
    assert.match(threadId, /^thread:/);
    assert.equal(threadId.includes("real-thread"), false);

    const turnResponse = await fetch(`${web.url}/api/codex/turns/start`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        threadId,
        contextDir: conversation.contextDir,
        entries: conversation.entries,
        prompt: "What is the method?",
        model: "gpt-5.6-sol",
        effort: "low",
      }),
    });
    const turnText = await turnResponse.text();
    assert.equal(turnResponse.status, 200, turnText);
    const { turnId } = JSON.parse(turnText);
    assert.match(turnId, /^turn:/);
    assert.equal(codex.turns[0].threadId, "real-thread-1");
    assert.ok(codex.turns[0].entries.length > 0);

    codex.emit("event", {
      method: "error",
      params: {
        threadId: "real-thread-1",
        turnId: "real-turn-1",
        willRetry: true,
        error: { message: "Reconnecting... 1/5" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const overlappingTurn = await fetch(`${web.url}/api/codex/turns/start`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        threadId,
        contextDir: conversation.contextDir,
        entries: conversation.entries,
        prompt: "Do not overlap the retrying turn",
        model: "gpt-5.6-sol",
        effort: "low",
      }),
    });
    assert.equal(overlappingTurn.status, 409);

    codex.emit("event", {
      method: "turn/completed",
      params: {
        threadId: "real-thread-1",
        turn: { id: "real-turn-1", threadId: "real-thread-1", status: "completed" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const nextTurn = await fetch(`${web.url}/api/codex/turns/start`, {
      method: "POST",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        threadId,
        contextDir: conversation.contextDir,
        entries: conversation.entries,
        prompt: "The completed turn released the slot",
        model: "gpt-5.6-sol",
        effort: "low",
      }),
    });
    assert.equal(nextTurn.status, 200);
  });
});
