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
      id: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      description: "test",
      defaultEffort: "max",
      supportedEfforts: ["low", "medium", "max"],
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

async function withWebServer(run, overrides = {}) {
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
    archiveDirectory: path.join(dataDir, "archive-test"),
    codex,
    viteFactory,
    fetcher: async () => new Response("not used", { status: 404 }),
    recommendationsFetcher: async () => [],
    ...overrides,
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
  assert.equal((await response.clone().json()).csrfToken, web.csrfToken);
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

test("web download pause and immediate resume preserve bytes and the pinned arXiv version", async () => {
  const pdf = Buffer.from(`%PDF-1.7\n${"fixture".repeat(200)}\n%%EOF\n`), ranges = [];
  let metadataCalls = 0;
  const fetcher = async (url, options = {}) => {
    if (String(url).includes("/api/query")) {
      metadataCalls++;
      return new Response('<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Download fixture</title><summary>Test only</summary><published>2017-06-12T00:00:00Z</published><updated>2023-08-02T00:00:00Z</updated></entry></feed>');
    }
    assert.equal(String(url), "https://arxiv.org/pdf/1706.03762v7");
    const start = Number(new Headers(options.headers).get("Range")?.match(/bytes=(\d+)-/)?.[1] || 0);
    ranges.push(start);
    const headers = { etag: '"fixture-v7"', "content-length": String(pdf.length - start) };
    if (start) {
      assert.equal(new Headers(options.headers).get("If-Range"), '"fixture-v7"');
      headers["content-range"] = `bytes ${start}-${pdf.length - 1}/${pdf.length}`;
      return new Response(pdf.subarray(start), { status: 206, headers });
    }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(pdf.subarray(0, 50));
      options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
    } }), { headers });
  };
  await withWebServer(async ({ web, dataDir }) => {
    const cookie = await session(web), id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const post = (route, body) => fetch(`${web.url}/api/papers/${route}`, { method: "POST", headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
    const opening = post("open-url", { value: "1706.03762v7", requestId: id });
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await post("download-status", { id })).json();
      if (state?.received === 50) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.received, 50); assert.equal(state.reference, "1706.03762v7");
    assert.equal((await post("download-cancel", { id })).status, 200);
    assert.notEqual((await opening).status, 200);
    const resumed = await post("open-url", { value: "1706.03762v7", requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const result = await resumed.json(); assert.equal(resumed.status, 200, JSON.stringify(result));
    assert.equal(result.arxivVersion, 7); assert.deepEqual(Buffer.from(result.dataBase64, "base64"), pdf);
    assert.deepEqual(ranges, [0, 50]); assert.equal(metadataCalls, 1);
    assert.equal((await (await post("download-status", { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).json()).phase, "complete");
    assert.deepEqual(await fs.readFile(path.join(dataDir, "library-pdfs", `${result.id}.pdf`)), pdf);
  }, { fetcher });
});

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

test("web title suggestions and archived conversation PDFs use authenticated routes and owned originals", async () => {
  await withWebServer(async ({ web, dataDir }) => {
    const cookie = await session(web);
    const post = (route, body) => fetch(`${web.url}${route}`, {method:'POST', headers:mutationHeaders(web,cookie,{'Content-Type':'application/json'}),body:JSON.stringify(body)});
    const suggested = await post('/api/papers/search',{query:'openvl'});
    assert.equal(suggested.status,200);assert.equal((await suggested.json()).items[0].title,'OpenVLA');
    const paper = await uploadPdf(web,cookie,PDF_ONE,'Diffusion Policy.pdf');
    const library = await (await fetch(`${web.url}/api/library`)).json();
    library.papers=[{...paper,title:'Diffusion Policy'}];
    library.messagesByScope={[`paper:${paper.id}`]:[{id:'question',role:'user',text:'Explain',createdAt:1}]};
    const saved=await fetch(`${web.url}/api/library`,{method:'PUT',headers:mutationHeaders(web,cookie,{'Content-Type':'application/json'}),body:JSON.stringify(library)});
    assert.equal(saved.status,200);
    const status=await (await post('/api/archive/retry',{})).json();
    assert.equal(status.failures.length,0);assert.equal(status.entries[0].category,'动作生成');
    assert.ok(status.entries[0].path.startsWith(path.join(dataDir,'archive-test')));assert.deepEqual(await fs.readFile(status.entries[0].path),PDF_ONE);
    const changed=await (await post('/api/archive/category',{paperId:paper.id,category:'运动控制'})).json();
    assert.equal(changed.entries[0].category,'运动控制');assert.deepEqual(await fs.readFile(changed.entries[0].path),PDF_ONE);
    const denied=await fetch(`${web.url}/api/archive/category`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paperId:paper.id,category:'VLA'})});
    assert.equal(denied.status,403);
  },{fetcher:async()=>new Response(JSON.stringify({matches:[{id:'a'.repeat(40),title:'OpenVLA',authorsYear:'2024'}]}))});
});

test("web library refuses corrupt overwrites and restores a backup through an authenticated request", async () => {
  await withWebServer(async ({ web, dataDir }) => {
    const cookie = await session(web);
    const paper = await uploadPdf(web, cookie, PDF_ONE);
    let revision = (await fetch(`${web.url}/api/library`).then((response) => response.json()))._revision;
    const save = async (lastPage) => {
      const response = await fetch(`${web.url}/api/library`, {
      method: "PUT",
      headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        _revision: revision,
        papers: [{ ...paper, lastPage, readingPosition: { page: 2, x: 0.5, y: 0.37, zoom: 1.5, fitWidth: false } }],
        openPaperIds: [paper.id], lastPaperId: paper.id,
        lastScopeKey: "all",
        threadsByScope: { [`paper:${paper.id}`]: `thread:${"x".repeat(32)}` },
        draftsByScope: { [`paper:${paper.id}`]: "未发送的中文草稿" },
        chatPositions: { [`paper:${paper.id}`]: { messageId: "saved-answer", block: 2, offset: 0.4, followOutput: false } },
      }),
      });
      if (response.ok) revision = (await response.clone().json())._revision;
      return response;
    };
    assert.equal((await save(2)).status, 200);
    assert.equal((await save(3)).status, 200);
    const libraryPath = path.join(dataDir, "library.json");
    await fs.writeFile(libraryPath, "{truncated");
    assert.equal((await fetch(`${web.url}/api/library`)).status, 400);
    assert.equal((await save(1)).status, 400);
    assert.equal(await fs.readFile(libraryPath, "utf8"), "{truncated");
    const denied = await fetch(`${web.url}/api/library/recover`, {
      method: "POST", headers: { Origin: web.url, Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(denied.status, 403);
    const response = await fetch(`${web.url}/api/library/recover`, {
      method: "POST", headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }), body: "{}",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const recovered = await response.json();
    revision = recovered._revision;
    assert.equal(recovered.papers[0].lastPage, 2);
    assert.equal(recovered.lastScopeKey, "all");
    assert.equal(recovered.threadsByScope[`paper:${paper.id}`], `thread:${"x".repeat(32)}`);
    assert.equal(recovered.papers[0].path, `paper:${paper.id}`);
    assert.deepEqual(recovered.papers[0].readingPosition, { page: 2, x: 0.5, y: 0.37, zoom: 1.5, fitWidth: false });
    assert.equal(recovered.draftsByScope[`paper:${paper.id}`], "未发送的中文草稿");
    assert.deepEqual(recovered.chatPositions[`paper:${paper.id}`], { messageId: "saved-answer", block: 2, offset: 0.4, followOutput: false });
    const archives = (await fs.readdir(dataDir)).filter((name) => name.startsWith("library.json.before-recovery-"));
    assert.equal(archives.length, 1);
    assert.equal(await fs.readFile(path.join(dataDir, archives[0]), "utf8"), "{truncated");
    assert.equal((await save(4)).status, 200);
    // A reported write failure must not poison server shutdown either.
    await fs.writeFile(libraryPath, "{broken again");
    assert.equal((await save(5)).status, 400);
  });
});

test("web relocation checks the original content and retains reading metadata", async () => {
  await withWebServer(async ({ web, dataDir }) => {
    const cookie = await session(web);
    const paper = await uploadPdf(web, cookie, PDF_ONE);
    const originalPath = path.join(dataDir, "library-pdfs", `${paper.id}.pdf`);
    await fs.writeFile(originalPath, "damaged original");
    const relink = (body) => fetch(`${web.url}/api/papers/import`, { method: "POST", headers: mutationHeaders(web, cookie, { "Content-Type": "application/pdf", "X-Paper-Ocean-Expected-Id": paper.id, "X-Paper-Ocean-Filename": "relocated.pdf" }), body });
    assert.equal((await relink(PDF_TWO)).status, 409);
    assert.equal(await fs.readFile(originalPath, "utf8"), "damaged original");
    const restored = await relink(PDF_ONE);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).id, paper.id);
    assert.ok((await fs.readdir(path.dirname(originalPath))).some((name) => name.includes(".before-repair-")));
    const state = await fetch(`${web.url}/api/library`).then((response) => response.json());
    state.papers = [{ ...paper, readingStatus: "done", publishedAt: "2026-09", arxivVersion: 3, authors: ["Ada"] }];
    const saved = await fetch(`${web.url}/api/library`, { method: "PUT", headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }), body: JSON.stringify(state) });
    assert.equal(saved.status, 200);
    const loaded = await fetch(`${web.url}/api/library`).then((response) => response.json());
    assert.equal(loaded.papers[0].readingStatus, "done");
    assert.equal(loaded.papers[0].publishedAt, "2026-09");
    assert.equal(loaded.papers[0].arxivVersion, 3);
    assert.equal(loaded.papers[0].managedOriginal, true);
  });
});

test("stale browser snapshots cannot overwrite notes or drafts saved by another page", async () => {
  await withWebServer(async ({ web }) => {
    const cookie = await session(web);
    const read = () => fetch(`${web.url}/api/library`).then((response) => response.json());
    const write = (state) => fetch(`${web.url}/api/library`, { method: "PUT", headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }), body: JSON.stringify(state) });
    const first = await read(), second = await read();
    const note = { id: "browser-note", title: "研究成果", body: "已保存的理解", anchors: [], createdAt: 1, updatedAt: 1 };
    first.notes = [note]; first.draftsByScope = { all: "页面 A 草稿" };
    const saved = await write(first);
    assert.equal(saved.status, 200);
    const revision = (await saved.json())._revision;
    second.draftsByScope = { all: "页面 B 较旧草稿" };
    const conflict = await write(second);
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error.message, /其他页面|未保存副本/);
    assert.equal((await read()).notes[0].body, note.body);
    assert.equal((await read()).draftsByScope.all, "页面 A 草稿");
    assert.equal((await write(first)).status, 200, "identical retry after a lost response is idempotent");
    const latest = await read();
    assert.equal(latest._revision, revision);
    latest.notes[0].body = "重新读取后继续编辑";
    assert.equal((await write(latest)).status, 200);
    delete latest._revision;
    assert.equal((await write(latest)).status, 409, "old clients must reload before writing");
  });
});

test("large web libraries preserve every record and malformed entries cannot silently disappear", async () => {
  await withWebServer(async ({ web }) => {
    const cookie = await session(web);
    const state = await fetch(`${web.url}/api/library`).then((response) => response.json());
    state.papers = Array.from({ length: 350 }, (_, index) => { const id = (index + 1).toString(16).padStart(24, "0"); return { id, path: `paper:${id}`, title: `Paper ${index}`, name: `${id}.pdf`, openedAt: index }; });
    const save = (snapshot) => fetch(`${web.url}/api/library`, { method: "PUT", headers: mutationHeaders(web, cookie, { "Content-Type": "application/json" }), body: JSON.stringify(snapshot) });
    assert.equal((await save(state)).status, 200);
    const loaded = await fetch(`${web.url}/api/library`).then((response) => response.json());
    assert.equal(loaded.papers.length, 350);
    loaded.papers[349].path = "not-an-opaque-handle";
    assert.equal((await save(loaded)).status, 400);
    assert.equal((await fetch(`${web.url}/api/library`).then((response) => response.json())).papers.length, 350);
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
        model: "gpt-5.6-luna",
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
        model: "gpt-5.6-luna",
        effort: "max",
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
        model: "gpt-5.6-luna",
        effort: "max",
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
        model: "gpt-5.6-luna",
        effort: "max",
      }),
    });
    assert.equal(nextTurn.status, 200);
  });
});
