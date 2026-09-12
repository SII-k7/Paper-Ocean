import { createAnswerStream } from "./answer-stream.mjs";

const EMPTY_PATCH = Object.freeze({});
const LANES = ["main", "auxiliary"];
const messageKey = (scopeKey, messageId) => JSON.stringify([scopeKey, messageId]);
const errorText = (reason) => reason instanceof Error ? reason.message : String(reason);

export class CancelledTurnError extends Error {
  constructor() { super("回答已停止。"); this.name = "CancelledTurnError"; }
}

/** Renderer-owned state. Tokens never pass through the application/library store. */
export function createConversationRuntime(options = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const displayInterval = options.displayInterval ?? 50;
  const snapshotInterval = options.snapshotInterval ?? 350;
  const closeTimeout = options.closeTimeout ?? 10_000;
  const records = new Map();
  const messageListeners = new Map();
  const lanes = new Map(LANES.map(lane => [lane, {
    active: null, listeners: new Set(),
    snapshot: { busy: false, busyScope: "", error: null, errorScope: null, cancelRequested: false },
  }]));
  let adapter;
  let snapshotTimer;
  let flushing = false;
  let closing = false;

  function laneOf(lane) {
    const result = lanes.get(lane);
    if (!result) throw new Error(`Unknown conversation lane: ${lane}`);
    return result;
  }
  function isActive(run) { return laneOf(run.lane).active === run; }
  function notifyMessage(record) {
    for (const listener of [...(messageListeners.get(record.key) ?? [])]) listener();
  }
  function updateLane(lane, patch) {
    const state = laneOf(lane);
    if (Object.entries(patch).every(([key, value]) => Object.is(state.snapshot[key], value))) return;
    state.snapshot = { ...state.snapshot, ...patch };
    for (const listener of [...state.listeners]) listener();
  }
  function scheduleSnapshot() {
    if (!flushing && adapter && snapshotTimer === undefined) {
      snapshotTimer = schedule(flushSnapshots, snapshotInterval);
    }
  }
  function publish(record, patch) {
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !Object.is(record.message[key], value)));
    if (!Object.keys(changed).length) return;
    record.message = { ...record.message, ...changed };
    record.overlay = { ...record.overlay, ...changed };
    record.dirty = { ...record.dirty, ...changed };
    notifyMessage(record);
    scheduleSnapshot();
  }
  function flushText(record) {
    if (record.displayTimer !== undefined) cancel(record.displayTimer);
    record.displayTimer = undefined;
    if (record.bufferedText === undefined) return;
    const text = record.bufferedText;
    record.bufferedText = undefined;
    publish(record, { text, firstTextAt: record.message.firstTextAt ?? record.firstTextAt, responsePhase: "正在输出" });
  }
  function queueText(record, text) {
    record.bufferedText = text;
    record.firstTextAt ??= now();
    if (record.displayTimer === undefined) record.displayTimer = schedule(() => flushText(record), displayInterval);
    scheduleSnapshot();
  }
  // This is synchronous: useLibrary dispatches before-save, then reads its
  // latest ref for saver.flush(). Even a <50ms final delta must be in that ref.
  function flushSnapshots() {
    if (snapshotTimer !== undefined) cancel(snapshotTimer);
    snapshotTimer = undefined;
    flushing = true;
    try {
      for (const record of records.values()) flushText(record);
      const pending = [...records.values()].filter(record => Object.keys(record.dirty).length);
      if (!pending.length || !adapter) return;
      const patches = pending.map(record => ({ scopeKey: record.scopeKey, messageId: record.message.id, patch: record.dirty }));
      adapter.persist(patches);
      for (let index = 0; index < pending.length; index++) {
        // A reentrant update during persist must remain pending for next time.
        if (pending[index].dirty === patches[index].patch) pending[index].dirty = {};
      }
    } finally {
      flushing = false;
    }
  }
  function begin(lane, scopeKey, assistantMessage) {
    const state = laneOf(lane);
    if (closing) throw new CancelledTurnError();
    if (state.active) throw new Error("这个对话窗口仍在回答。");
    const key = messageKey(scopeKey, assistantMessage.id);
    if (records.has(key)) throw new Error("回答消息标识不能重复使用。");
    const record = { key, scopeKey, message: assistantMessage, overlay: EMPTY_PATCH, dirty: {}, bufferedText: undefined, displayTimer: undefined, firstTextAt: undefined };
    records.set(key, record);
    const run = { lane, scopeKey, assistantMessageId: assistantMessage.id, record, stream: createAnswerStream(), threadId: undefined, turnId: undefined, earlyEvents: [], interrupting: null };
    state.active = run;
    updateLane(lane, { busy: true, busyScope: scopeKey, error: null, errorScope: null, cancelRequested: false });
    return run;
  }
  function patch(run, changes) {
    if (!isActive(run)) return;
    flushText(run.record);
    publish(run.record, changes);
  }
  function checkCancelled(run) {
    if (!isActive(run) || laneOf(run.lane).snapshot.cancelRequested) throw new CancelledTurnError();
  }
  function bindThread(run, threadId) {
    checkCancelled(run);
    run.threadId = threadId;
  }
  function finish(run, { status, failure } = {}) {
    if (!isActive(run)) return;
    flushText(run.record);
    publish(run.record, {
      pending: false, error: status === "failed", interrupted: status === "interrupted", finishedAt: now(),
      text: run.record.message.text || failure || (status === "interrupted" ? "回答已停止。" : "没有生成可显示的回答。"),
    });
    // Keep the record until React acknowledges the matching persisted message.
    // That prevents a leaf from falling back to an older prop during this commit.
    laneOf(run.lane).active = null;
    run.earlyEvents = [];
    flushSnapshots();
    updateLane(run.lane, { busy: false, cancelRequested: false, ...(failure ? { error: failure, errorScope: run.scopeKey } : {}) });
  }
  function fail(run, reason) {
    if (!isActive(run)) return;
    const cancelled = reason instanceof CancelledTurnError;
    finish(run, { status: cancelled ? "interrupted" : "failed", failure: cancelled ? undefined : errorText(reason) });
  }
  function consumeRunEvent(run, event) {
    if (!isActive(run)) return;
    const params = event.params ?? {};
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (eventTurnId && eventTurnId !== run.turnId) return;
    const text = run.stream.consume(event.method, params);
    if (text) queueText(run.record, text);
    if (event.method === "item/started" && params.item?.type === "reasoning") patch(run, { responsePhase: "思考中" });
    if (event.method === "error") {
      if (params.willRetry === true) patch(run, { responsePhase: "连接波动，正在重试" });
      else fail(run, new Error(params.error?.message ?? "Codex 回答失败"));
    }
    if (event.method === "turn/completed") {
      finish(run, { status: params.turn?.status, failure: params.turn?.error?.message });
      adapter?.onTurnCompleted?.(run.lane);
    }
  }
  function handleEvent(event) {
    if (event.method === "account/updated" || event.method === "account/login/completed") adapter?.onAccountEvent?.(event);
    if (event.method === "paperOcean/serverExited") {
      for (const state of lanes.values()) if (state.active) fail(state.active, new Error(typeof event.params?.message === "string" ? event.params.message : "Codex 服务意外退出，请重新发送问题。"));
      return;
    }
    const params = event.params ?? {};
    const threadId = params.threadId ?? params.turn?.threadId;
    if (!threadId) return;
    for (const state of lanes.values()) {
      const run = state.active;
      if (!run || run.threadId !== threadId) continue;
      // Events can arrive before sendTurn resolves. Wait for its actual turnId
      // instead of attributing a late event from an earlier turn to this answer.
      if (!run.turnId) run.earlyEvents.push(event);
      else consumeRunEvent(run, event);
    }
  }
  async function interruptRun(run) {
    if (!isActive(run) || !run.turnId) return;
    if (run.interrupting) return run.interrupting;
    const request = (async () => {
      try {
        if (!adapter) throw new Error("会话连接尚未就绪。");
        await adapter.interrupt({ threadId: run.threadId, turnId: run.turnId });
      } catch (reason) {
        // A delayed error from an older run must not unlock a newer one.
        if (isActive(run)) updateLane(run.lane, { cancelRequested: false, error: `停止失败，请重试。${errorText(reason)}`, errorScope: run.scopeKey });
      }
    })();
    run.interrupting = request;
    try { await request; } finally { run.interrupting = null; }
  }
  async function bindTurn(run, result) {
    if (!isActive(run)) return;
    run.turnId = result.turnId;
    patch(run, { serviceTier: result.serviceTier ?? null });
    const earlyEvents = run.earlyEvents;
    run.earlyEvents = [];
    for (const event of earlyEvents) consumeRunEvent(run, event);
    if (isActive(run) && laneOf(run.lane).snapshot.cancelRequested) await interruptRun(run);
  }
  async function stop(lane) {
    const state = laneOf(lane);
    const run = state.active;
    if (!run) return;
    updateLane(lane, { cancelRequested: true, error: null, errorScope: null });
    await interruptRun(run);
  }
  function waitForIdle(run) {
    if (!isActive(run)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const state = laneOf(run.lane);
      const timer = schedule(() => { state.listeners.delete(onState); reject(new Error("回答尚未停止，已保留窗口和现有内容。请稍后重试关闭。")); }, closeTimeout);
      function onState() {
        if (isActive(run) && state.snapshot.cancelRequested) return;
        state.listeners.delete(onState);
        cancel(timer);
        if (isActive(run)) reject(new Error(state.snapshot.error || "停止回答失败，请重试关闭。"));
        else resolve();
      }
      state.listeners.add(onState);
      onState();
    });
  }
  async function prepareForClose() {
    closing = true;
    try {
      const runs = [...lanes.values()].map(state => state.active).filter(Boolean);
      await Promise.all(runs.map(async run => {
        // Do not await interruption here: even a stuck IPC request must respect
        // the close timeout and leave the window open, with output preserved.
        void stop(run.lane);
        await waitForIdle(run);
      }));
      flushSnapshots();
    } finally { closing = false; }
  }
  function attach(nextAdapter, target) {
    if (adapter) throw new Error("Conversation runtime is already attached.");
    adapter = nextAdapter;
    const unsubscribe = nextAdapter.onEvent(handleEvent);
    const beforeSave = () => flushSnapshots();
    const beforeClose = event => event.detail?.waitUntil(prepareForClose());
    target?.addEventListener("paper-ocean-before-save", beforeSave);
    target?.addEventListener("paper-ocean-before-close", beforeClose);
    if ([...records.values()].some(record => Object.keys(record.dirty).length)) scheduleSnapshot();
    return () => {
      flushSnapshots();
      unsubscribe();
      target?.removeEventListener("paper-ocean-before-save", beforeSave);
      target?.removeEventListener("paper-ocean-before-close", beforeClose);
      adapter = undefined;
    };
  }
  function subscribeMessage(scopeKey, messageId, listener) {
    const key = messageKey(scopeKey, messageId);
    const listeners = messageListeners.get(key) ?? new Set();
    listeners.add(listener);
    messageListeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) messageListeners.delete(key); };
  }
  function acknowledgeMessage(scopeKey, persistedMessage) {
    const key = messageKey(scopeKey, persistedMessage.id);
    const record = records.get(key);
    if (!record || record.message.pending || Object.keys(record.dirty).length) return;
    if (!Object.entries(record.overlay).every(([field, value]) => Object.is(persistedMessage[field], value))) return;
    records.delete(key);
    notifyMessage(record);
  }

  return {
    begin, bindThread, bindTurn, patch, checkCancelled, fail, stop, handleEvent, attach, flushSnapshots, prepareForClose,
    isBusy: lane => laneOf(lane).active !== null,
    setError: (lane, error, scopeKey) => updateLane(lane, { error, errorScope: error ? scopeKey ?? laneOf(lane).active?.scopeKey ?? null : null }),
    clearError: lane => updateLane(lane, { error: null, errorScope: null }),
    getLaneSnapshot: lane => laneOf(lane).snapshot,
    subscribeLane(lane, listener) { const state = laneOf(lane); state.listeners.add(listener); return () => state.listeners.delete(listener); },
    subscribeMessage, acknowledgeMessage,
    getMessagePatch: (scopeKey, messageId) => records.get(messageKey(scopeKey, messageId))?.overlay ?? EMPTY_PATCH,
  };
}

export const conversationRuntime = createConversationRuntime();
