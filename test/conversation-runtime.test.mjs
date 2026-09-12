import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { CancelledTurnError, createConversationRuntime } from "../src/conversation-runtime.mjs";
import { createLibrarySaver } from "../src/library-saver.mjs";

function fakeClock() {
  let time = 1_000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(duration) {
      const end = time + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
  };
}

function fixture(options = {}) {
  const clock = fakeClock();
  const runtime = createConversationRuntime({ ...clock, ...options });
  const target = new EventTarget();
  const snapshots = [];
  const messages = {};
  const interrupts = [];
  let listener;
  const adapter = {
    onEvent(next) { assert.equal(listener, undefined); listener = next; return () => { listener = undefined; }; },
    interrupt: async input => { interrupts.push(input); },
    persist(patches) {
      snapshots.push({ at: clock.now(), patches });
      for (const { scopeKey, messageId, patch } of patches) messages[scopeKey][messageId] = { ...messages[scopeKey][messageId], ...patch };
    },
  };
  const detach = runtime.attach(adapter, target);
  function begin(lane = "main", scopeKey = "paper:one", id = "answer-1") {
    const message = { id, role: "assistant", text: "", createdAt: clock.now(), pending: true, responsePhase: "准备论文资料", serviceTier: "fast" };
    messages[scopeKey] ??= {};
    messages[scopeKey][id] = message;
    return runtime.begin(lane, scopeKey, message);
  }
  async function start(lane = "main", scopeKey = "paper:one", id = "answer-1", threadId = "thread-1", turnId = "turn-1") {
    const run = begin(lane, scopeKey, id);
    runtime.bindThread(run, threadId);
    await runtime.bindTurn(run, { turnId, serviceTier: "fast" });
    return run;
  }
  const emit = (method, params) => listener({ method, params });
  const delta = (text, threadId = "thread-1", turnId = "turn-1", itemId = "item-1") => emit("item/agentMessage/delta", { threadId, turnId, itemId, delta: text });
  const complete = (threadId = "thread-1", turnId = "turn-1", status = "completed") => emit("turn/completed", { threadId, turn: { id: turnId, status } });
  return { clock, runtime, target, snapshots, messages, interrupts, adapter, detach, begin, start, emit, delta, complete };
}

test("4,000 interleaved chunks notify only their message leaves; library checkpoints stay at 350ms", async t => {
  const f = fixture();
  await f.start();
  await f.start("auxiliary", "auxiliary:one", "answer-2", "thread-2", "turn-2");
  const counts = { main: 0, auxiliary: 0, unrelatedMessage: 0, unrelatedScope: 0, lane: 0 };
  f.runtime.subscribeMessage("paper:one", "answer-1", () => counts.main++);
  f.runtime.subscribeMessage("auxiliary:one", "answer-2", () => counts.auxiliary++);
  f.runtime.subscribeMessage("paper:one", "old-answer", () => counts.unrelatedMessage++);
  f.runtime.subscribeMessage("paper:other", "answer-1", () => counts.unrelatedScope++);
  f.runtime.subscribeLane("main", () => counts.lane++);
  f.runtime.subscribeLane("auxiliary", () => counts.lane++);
  const mainText = "依据第 2 页 🦾。";
  const auxText = "辅助窗口独立上下文。";
  const started = performance.now();
  for (let index = 0; index < 2_000; index++) {
    f.delta(mainText);
    f.delta(auxText, "thread-2", "turn-2");
    f.clock.advance(5);
  }
  const checkpointsDuringStreaming = f.snapshots.length;
  const elapsed = performance.now() - started;
  assert.equal(checkpointsDuringStreaming, 28);
  assert.equal(counts.main, 200);
  assert.equal(counts.auxiliary, 200);
  assert.equal(counts.lane, 0, "the App lane subscription receives no streaming updates");
  assert.equal(counts.unrelatedMessage, 0);
  assert.equal(counts.unrelatedScope, 0);
  f.complete();
  f.complete("thread-2", "turn-2");
  assert.equal(counts.lane, 2);
  assert.equal(f.snapshots.length, 30);
  assert.equal(f.messages["paper:one"]["answer-1"].text, mainText.repeat(2_000));
  assert.equal(f.messages["auxiliary:one"]["answer-2"].text, auxText.repeat(2_000));
  assert.equal(f.messages["paper:one"]["answer-1"].serviceTier, "fast");
  t.diagnostic(`Controlled 10s / 4,000 chunks: 400 message-leaf publications, 28 library checkpoints, 0 token-driven lane/unrelated-leaf notifications; ${elapsed.toFixed(1)}ms CPU for the harness (not a browser frame profile).`);
  f.detach();
});

test("unpublished final delta and metadata synchronously reach before-save, without mutating unrelated fields", async () => {
  const f = fixture();
  const run = await f.start();
  const coverage = { complete: true, providedPages: 122, totalPages: 122 };
  const pageImages = [{ paperId: "one", page: 15 }];
  f.runtime.patch(run, { contextCoverage: coverage, pageImages, sentAt: f.clock.now() });
  f.messages["paper:one"]["answer-1"].page = 3;
  f.delta("最后一段 🦾");
  assert.equal(f.messages["paper:one"]["answer-1"].text, "");
  f.target.dispatchEvent(new Event("paper-ocean-before-save"));
  const saved = f.messages["paper:one"]["answer-1"];
  assert.equal(saved.text, "最后一段 🦾");
  assert.equal(saved.firstTextAt, f.clock.now());
  assert.deepEqual(saved.contextCoverage, coverage);
  assert.deepEqual(saved.pageImages, pageImages);
  assert.equal(saved.page, 3);
  assert.equal(saved.serviceTier, "fast");
  assert.equal(f.snapshots.length, 1);
  f.clock.advance(400);
  assert.equal(f.snapshots.length, 1);
  f.complete();
  f.detach();
});

test("events before RPC result are replayed only for its actual thread and turn", async () => {
  const f = fixture();
  const run = f.begin();
  f.runtime.bindThread(run, "thread-1");
  f.delta("stale previous answer", "thread-1", "previous-turn");
  f.complete("thread-1", "previous-turn");
  f.delta("wrong thread", "thread-else", "turn-1");
  f.delta("本轮答案");
  f.complete();
  f.clock.advance(400);
  assert.equal(f.messages["paper:one"]["answer-1"].text, "");
  assert.equal(f.runtime.isBusy("main"), true);
  await f.runtime.bindTurn(run, { turnId: "turn-1", serviceTier: "fast" });
  assert.equal(f.messages["paper:one"]["answer-1"].text, "本轮答案");
  assert.equal(f.runtime.isBusy("main"), false);
  f.detach();
});

test("item completion is authoritative and multiple answer items are neither duplicated nor truncated", async () => {
  const f = fixture();
  await f.start();
  f.delta("初稿");
  f.emit("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "完整结论。" } });
  f.delta("迟到的旧分片");
  f.delta({ text: "第 15 页依据。" }, "thread-1", "turn-1", "item-2");
  f.emit("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-2", text: "" } });
  f.complete();
  assert.equal(f.messages["paper:one"]["answer-1"].text, "完整结论。\n\n第 15 页依据。");
  f.detach();
});

test("terminal errors preserve buffered content, while retryable errors keep the run alive", async () => {
  const f = fixture();
  await f.start();
  f.delta("已收到的原文解释");
  f.emit("error", { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "retry" } });
  assert.equal(f.runtime.isBusy("main"), true);
  assert.equal(f.runtime.getMessagePatch("paper:one", "answer-1").responsePhase, "连接波动，正在重试");
  f.emit("error", { threadId: "thread-1", turnId: "turn-1", error: { message: "连接中断" } });
  assert.equal(f.runtime.isBusy("main"), false);
  assert.equal(f.messages["paper:one"]["answer-1"].text, "已收到的原文解释");
  assert.equal(f.messages["paper:one"]["answer-1"].error, true);
  assert.equal(f.runtime.getLaneSnapshot("main").error, "连接中断");
  f.detach();
});

test("stop failures leave the same turn retryable and cannot reset a newer run", async () => {
  const f = fixture();
  await f.start();
  let rejectOld;
  f.adapter.interrupt = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  const stopping = f.runtime.stop("main");
  rejectOld(new Error("temporary failure"));
  await stopping;
  assert.equal(f.runtime.isBusy("main"), true);
  assert.equal(f.runtime.getLaneSnapshot("main").cancelRequested, false);
  assert.match(f.runtime.getLaneSnapshot("main").error, /停止失败/);
  const secondStopping = f.runtime.stop("main");
  f.complete();
  await f.start("main", "paper:two", "answer-3", "thread-3", "turn-3");
  rejectOld(new Error("old late failure"));
  await secondStopping;
  assert.deepEqual(f.runtime.getLaneSnapshot("main"), { busy: true, busyScope: "paper:two", error: null, errorScope: null, cancelRequested: false });
  f.complete("thread-3", "turn-3");
  f.detach();
});

test("cancel during preparation is checked before send; cancel during send interrupts its actual returned turn", async () => {
  const f = fixture();
  const preparing = f.begin();
  await f.runtime.stop("main");
  assert.throws(() => f.runtime.checkCancelled(preparing), CancelledTurnError);
  assert.throws(() => f.runtime.bindThread(preparing, "thread-1"), CancelledTurnError);
  f.runtime.fail(preparing, new CancelledTurnError());
  assert.equal(f.messages["paper:one"]["answer-1"].interrupted, true);
  const sending = f.begin("main", "paper:two", "answer-2");
  f.runtime.bindThread(sending, "thread-2");
  await f.runtime.stop("main");
  assert.equal(f.interrupts.length, 0);
  await f.runtime.bindTurn(sending, { turnId: "turn-2", serviceTier: "fast" });
  assert.deepEqual(f.interrupts, [{ threadId: "thread-2", turnId: "turn-2" }]);
  f.complete("thread-2", "turn-2", "interrupted");
  f.detach();
});

test("before-close waits for both interruptions then library-saver flush includes even the final unpainted chunk", async () => {
  const f = fixture();
  await f.start();
  await f.start("auxiliary", "auxiliary:one", "answer-2", "thread-2", "turn-2");
  let latest = { messagesByScope: {} };
  const disk = [];
  const saver = createLibrarySaver(async snapshot => { disk.push(structuredClone(snapshot)); }, () => undefined);
  const originalPersist = f.adapter.persist;
  f.adapter.persist = patches => {
    originalPersist(patches);
    latest = { messagesByScope: Object.fromEntries(Object.entries(f.messages).map(([scope, messages]) => [scope, Object.values(messages)])) };
    saver.schedule(latest);
  };
  f.adapter.interrupt = async ({ threadId, turnId }) => {
    f.delta(`最后分片 ${threadId}`, threadId, turnId);
    f.complete(threadId, turnId, "interrupted");
  };
  const tasks = [];
  f.target.dispatchEvent(new CustomEvent("paper-ocean-before-close", { detail: { waitUntil: task => tasks.push(task) } }));
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  f.target.dispatchEvent(new Event("paper-ocean-before-save"));
  await saver.flush();
  assert.equal(saver.isDirty(), false);
  assert.equal(disk.at(-1).messagesByScope["paper:one"][0].text, "最后分片 thread-1");
  assert.equal(disk.at(-1).messagesByScope["auxiliary:one"][0].text, "最后分片 thread-2");
  assert.equal(disk.at(-1).messagesByScope["paper:one"][0].pending, false);
  assert.equal(disk.at(-1).messagesByScope["auxiliary:one"][0].interrupted, true);
  f.detach();
});

test("close rejection preserves the window's active state and permits a successful close retry", async () => {
  const f = fixture();
  await f.start();
  f.delta("保留这段内容");
  f.adapter.interrupt = async () => { throw new Error("temporary failure"); };
  await assert.rejects(f.runtime.prepareForClose(), /停止失败/);
  assert.equal(f.runtime.isBusy("main"), true);
  assert.equal(f.runtime.getLaneSnapshot("main").cancelRequested, false);
  f.adapter.interrupt = async ({ threadId, turnId }) => { f.complete(threadId, turnId, "interrupted"); };
  await f.runtime.prepareForClose();
  assert.equal(f.messages["paper:one"]["answer-1"].text, "保留这段内容");
  assert.equal(f.messages["paper:one"]["answer-1"].interrupted, true);
  f.detach();
});

test("a stuck interrupt respects close timeout and never reports a saved/completed answer", async () => {
  const f = fixture({ closeTimeout: 1_000 });
  await f.start();
  f.adapter.interrupt = () => new Promise(() => undefined);
  const closing = f.runtime.prepareForClose();
  const rejected = assert.rejects(closing, /回答尚未停止/);
  f.clock.advance(1_000);
  await rejected;
  assert.equal(f.runtime.isBusy("main"), true);
  assert.equal(f.messages["paper:one"]["answer-1"].pending, true);
  f.complete();
  f.detach();
});

test("stale async callbacks and completed-turn events cannot overwrite the next run on the same thread", async () => {
  const f = fixture();
  const old = await f.start();
  f.complete();
  await f.start("main", "paper:one", "answer-2", "thread-1", "turn-2");
  f.runtime.patch(old, { text: "late async patch" });
  f.runtime.fail(old, new Error("late async rejection"));
  await f.runtime.bindTurn(old, { turnId: "turn-1" });
  f.delta("late event", "thread-1", "turn-1");
  f.complete("thread-1", "turn-1");
  f.delta("new answer", "thread-1", "turn-2");
  f.complete("thread-1", "turn-2");
  assert.equal(f.messages["paper:one"]["answer-2"].text, "new answer");
  assert.equal(f.runtime.getLaneSnapshot("main").error, null);
  f.detach();
});

test("completed overlays stay visible until matching persisted props arrive, then release their record", async () => {
  const f = fixture();
  await f.start();
  const oldPersisted = f.messages["paper:one"]["answer-1"];
  f.delta("保存前后的文本一致");
  f.complete();
  f.runtime.acknowledgeMessage("paper:one", oldPersisted);
  assert.equal(f.runtime.getMessagePatch("paper:one", "answer-1").text, "保存前后的文本一致");
  f.runtime.acknowledgeMessage("paper:one", f.messages["paper:one"]["answer-1"]);
  assert.deepEqual(f.runtime.getMessagePatch("paper:one", "answer-1"), {});
  f.detach();
});

test("one IPC subscription covers account updates and service exit for both preparing and streaming lanes", async () => {
  const f = fixture();
  let accountEvents = 0;
  f.adapter.onAccountEvent = () => accountEvents++;
  await f.start();
  f.begin("auxiliary", "auxiliary:one", "answer-2");
  f.delta("server exit前的回答");
  f.emit("account/updated", {});
  assert.equal(accountEvents, 1);
  f.emit("paperOcean/serverExited", { message: "服务意外退出" });
  assert.equal(f.runtime.isBusy("main"), false);
  assert.equal(f.runtime.isBusy("auxiliary"), false);
  assert.equal(f.messages["paper:one"]["answer-1"].text, "server exit前的回答");
  assert.equal(f.messages["auxiliary:one"]["answer-2"].text, "服务意外退出");
  f.detach();
});

test("background failures retain their originating scope; pre-send validation can target a different scope", async () => {
  const f = fixture();
  await f.start();
  // Changing the visible discussion does not change the active run's ownership.
  f.runtime.clearError("main");
  f.emit("error", { threadId: "thread-1", turnId: "turn-1", error: { message: "后台论文回答失败" } });
  assert.equal(f.runtime.getLaneSnapshot("main").errorScope, "paper:one");
  f.runtime.setError("main", "当前选文附件不属于论文", "paper:two");
  assert.equal(f.runtime.getLaneSnapshot("main").errorScope, "paper:two");
  f.runtime.clearError("main");
  assert.equal(f.runtime.getLaneSnapshot("main").errorScope, null);
  f.runtime.setError("auxiliary", "兼容未指明scope的调用");
  assert.equal(f.runtime.getLaneSnapshot("auxiliary").errorScope, null);
  await f.start("main", "paper:two", "answer-2", "thread-2", "turn-2");
  f.runtime.setError("main", "未显式指明scope时使用当前run");
  assert.equal(f.runtime.getLaneSnapshot("main").errorScope, "paper:two");
  f.adapter.interrupt = async () => { throw new Error("停止重试"); };
  await f.runtime.stop("main");
  assert.equal(f.runtime.getLaneSnapshot("main").errorScope, "paper:two");
  f.complete("thread-2", "turn-2");
  f.detach();
});

test("close during send waits for RPC identity, ignores old events, then interrupts and persists the correct turn", async () => {
  const f = fixture();
  const run = f.begin();
  f.runtime.bindThread(run, "thread-1");
  f.delta("previous-turn text", "thread-1", "previous-turn");
  f.complete("thread-1", "previous-turn");
  f.delta("正确的最后分片");
  f.adapter.interrupt = async ({ threadId, turnId }) => {
    f.interrupts.push({ threadId, turnId });
    f.complete(threadId, turnId, "interrupted");
  };
  const closing = f.runtime.prepareForClose();
  assert.throws(() => f.begin("auxiliary", "auxiliary:one", "new-answer"), CancelledTurnError);
  assert.equal(f.interrupts.length, 0);
  await f.runtime.bindTurn(run, { turnId: "turn-1", serviceTier: "fast" });
  await closing;
  assert.deepEqual(f.interrupts, [{ threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(f.messages["paper:one"]["answer-1"].text, "正确的最后分片");
  assert.equal(f.messages["paper:one"]["answer-1"].interrupted, true);
  f.detach();
});
