import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, CheckCircle2, Quote, Send, Sparkles, Square } from "lucide-react";
import ModelReasoningPicker from "./ModelReasoningPicker";
import type {
  ChatMessage,
  CodexAccount,
  CodexModel,
  CodexSelection,
  PaperRecord,
  RateLimitInfo,
} from "../types";

type Props = {
  activePaper: PaperRecord | null;
  openPapers: PaperRecord[];
  scopeKey: string;
  account: CodexAccount | null;
  rateLimits: RateLimitInfo | null;
  messages: ChatMessage[];
  selectedText: string;
  currentPage: number;
  busy: boolean;
  error?: string | null;
  models: CodexModel[];
  modelSelection: CodexSelection | null;
  onScopeChange(scopeKey: string): void;
  onModelSelectionChange(selection: CodexSelection): void;
  onLogin(): void;
  onSend(text: string): void;
  onStop(): void;
};

const SINGLE_PROMPTS = [
  "总结这篇论文的核心贡献",
  "结合全文解释当前页的作用",
  "找出作者的主要假设",
  "这篇论文有哪些局限？",
];

const ALL_PROMPTS = [
  "比较这些论文的核心问题、方法与结论",
  "梳理这些论文之间的继承和分歧",
  "给出阅读顺序并解释原因",
  "哪些结论互相支持，哪些存在冲突？",
];

export default function ChatPanel({
  activePaper,
  openPapers,
  scopeKey,
  account,
  rateLimits,
  messages,
  selectedText,
  currentPage,
  busy,
  error,
  models,
  modelSelection,
  onScopeChange,
  onModelSelectionChange,
  onLogin,
  onSend,
  onStop,
}: Props) {
  const [input, setInput] = useState("");
  const [hasNewAnswer, setHasNewAnswer] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const isAllScope = scopeKey === "all";
  const scopePaperId = scopeKey.startsWith("paper:") ? scopeKey.slice(6) : undefined;
  const scopePapers = useMemo(
    () => (isAllScope ? openPapers : openPapers.filter((paper) => paper.id === scopePaperId)),
    [isAllScope, openPapers, scopePaperId],
  );
  const scopeReady = scopePapers.length > 0 && scopePapers.every((paper) => paper.paperDir);
  const prompts = isAllScope ? ALL_PROMPTS : SINGLE_PROMPTS;

  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    const node = scrollRef.current;
    if (!node) return;
    followOutputRef.current = true;
    setHasNewAnswer(false);
    node.scrollTo({ top: node.scrollHeight, behavior });
  };

  useEffect(() => {
    if (!followOutputRef.current) {
      if (messages.at(-1)?.role === "assistant") setHasNewAnswer(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (followOutputRef.current) scrollToLatest("auto");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    followOutputRef.current = true;
    setHasNewAnswer(false);
    const frame = window.requestAnimationFrame(() => scrollToLatest("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [scopeKey]);

  const submit = () => {
    const value = input.trim();
    if (!value || !scopePapers.length || busy || !modelSelection) return;
    onSend(value);
    setInput("");
    followOutputRef.current = true;
  };

  const scopeDescription = isAllScope
    ? `全部 ${scopePapers.length} 篇论文`
    : scopePapers[0]
      ? `《${scopePapers[0].title}》`
      : "当前论文";

  const usage = rateLimits?.primary?.usedPercent;
  const indexedPages = scopePapers.reduce((sum, paper) => sum + (paper.pageCount ?? 0), 0);
  const latestMessage = messages.at(-1);
  const announcement = busy
    ? "Codex 正在回答"
    : latestMessage?.role === "assistant" && !latestMessage.pending
      ? latestMessage.error
        ? "Codex 回答失败"
        : latestMessage.text === "回答已停止。"
          ? "Codex 回答已停止"
          : "Codex 回答完成"
      : "";

  return (
    <section className="chat-panel" aria-label="AI 论文对话">
      <header className="chat-topbar">
        <span className="chat-topbar__label">THINKING</span>
        {!!openPapers.length && (
          <div className="scope-segmented" role="group" aria-label="对话范围">
            <button
              type="button"
              className={!isAllScope ? "active" : ""}
              aria-pressed={!isAllScope}
              disabled={!activePaper}
              onClick={() => activePaper && onScopeChange(`paper:${activePaper.id}`)}
            >
              当前论文
            </button>
            <button
              type="button"
              className={isAllScope ? "active" : ""}
              aria-pressed={isAllScope}
              disabled={openPapers.length < 2}
              onClick={() => onScopeChange("all")}
            >
              全部论文
            </button>
          </div>
        )}
        <div className={`account-chip ${account?.connected ? "account-chip--online" : ""}`}>
          <span className="status-dot" />
          {account?.connected ? `CODEX ${(account.planType ?? "PRO").toUpperCase()}` : "未连接"}
        </div>
      </header>

      {usage !== undefined && (
        <div className="usage-strip" title="Codex 当前额度窗口使用情况" aria-label={`额度窗口已使用 ${Math.round(usage)}%`}>
          <div style={{ width: `${Math.min(usage, 100)}%` }} />
        </div>
      )}

      {!account?.connected && (
        <div className="login-card">
          <div>
            <strong>使用你的 ChatGPT 订阅</strong>
            <p>登录由本机 Codex 管理，Paper Ocean 不读取你的密码或登录令牌。</p>
          </div>
          <button type="button" className="primary-button" onClick={onLogin}>连接 Codex</button>
        </div>
      )}

      {selectedText && (
        <div className="selection-card">
          <span><Quote size={13} aria-hidden="true" /> 第 {currentPage} 页的选中文本</span>
          <p>{selectedText}</p>
          <button type="button" onClick={() => onSend("请逐句解释我选中的内容，并说明它在全文论证中的作用。")}>解释这段</button>
        </div>
      )}

      <div
        className="message-list"
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 84;
          followOutputRef.current = nearBottom;
          if (nearBottom) setHasNewAnswer(false);
        }}
      >
        {!messages.length && (
          <div className="chat-welcome">
            <div className="chat-welcome__mark"><Sparkles size={23} strokeWidth={1.8} aria-hidden="true" /></div>
            <h3>{scopePapers.length ? "准备分析" : "先打开一篇论文"}</h3>
            <p>{scopePapers.length
              ? `已载入 ${scopePapers.length} 篇论文、${indexedPages || "全部"} 页的全文上下文。当前页面只用于定位，不是阅读边界。`
              : "打开后可以直接询问方法、公式、实验和相关工作。"}</p>
            {scopePapers.length > 0 && (
              <div className={`context-status ${scopeReady ? "context-status--ready" : ""}`} aria-live="polite">
                <CheckCircle2 size={14} aria-hidden="true" />
                {scopeReady ? "全文索引已载入" : "正在建立全文索引"}
              </div>
            )}
            {!!scopePapers.length && (
              <div className="quick-prompts">
                {prompts.map((prompt) => (
                  <button type="button" key={prompt} onClick={() => onSend(prompt)} disabled={busy || !modelSelection}>{prompt}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`message message--${message.role} ${message.error ? "message--error" : ""}`}>
            <header>{message.role === "user" ? "你" : "Codex"}{message.page ? ` · 第 ${message.page} 页` : ""}</header>
            <div>{message.text || (message.pending ? "正在通读全文…" : "")}</div>
            {message.pending && <span className="typing-indicator" aria-label="Codex 正在回答"><i /><i /><i /></span>}
          </article>
        ))}
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {hasNewAnswer && (
        <button type="button" className="new-answer-button" onClick={() => scrollToLatest()}>
          <ArrowDown size={14} aria-hidden="true" /> 查看新回答
        </button>
      )}

      {error && <div className="inline-error" role="alert">{error}</div>}

      <div className="chat-composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={scopePapers.length ? `询问${scopeDescription}的完整内容…` : "请先打开论文"}
          disabled={!scopePapers.length}
          rows={3}
          aria-label="向 Codex 提问"
        />
        <div className="composer-toolbar">
          <ModelReasoningPicker
            models={models}
            selection={modelSelection}
            busy={busy}
            onChange={onModelSelectionChange}
          />
          <button
            type="button"
            className={`send-button${busy ? " send-button--stop" : ""}`}
            onClick={busy ? onStop : submit}
            disabled={!busy && (!scopePapers.length || !input.trim() || !modelSelection)}
            aria-label={busy ? "停止回答" : "发送问题"}
            title={busy ? "停止回答" : "发送问题"}
          >
            {busy
              ? <Square size={15} fill="currentColor" aria-hidden="true" />
              : <Send size={17} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </section>
  );
}
