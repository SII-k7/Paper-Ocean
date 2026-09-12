import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ChevronDown, ChevronUp, MessageCircle, Send, Square } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";
import ResponseStatus from "./ResponseStatus";
import ComposerAttachment, { type ComposerAttachmentData } from "./ComposerAttachment";
import useConversationMessage from "../hooks/useConversationMessage";
import useComposerDraft from "../hooks/useComposerDraft";
import type { ChatMessage, PaperRecord } from "../types";

type Props = {
  paper: PaperRecord;
  scopeKey: string;
  messages: ChatMessage[];
  draft: string;
  onDraftChange(value: string): void;
  busy: boolean;
  blocked: boolean;
  ready: boolean;
  connected: boolean;
  fast: boolean;
  error: string | null;
  attachment?: ComposerAttachmentData | null;
  onRemoveAttachment?(): void;
  expanded?: boolean;
  onExpandedChange?(value: boolean): void;
  focusRequest?: number;
  messageJump?: { messageId: string; requestId: number };
  onReturnToRunning?(): void;
  onSaveNote?(message: ChatMessage): void;
  onLogin(): void;
  onSend(question: string): void;
  onStop(): void;
  onOpenEvidence(paperId: string, page: number): void;
};

const AuxiliaryMessage = memo(function AuxiliaryMessage({ scopeKey, persistedMessage, paperId, paperTitle, onOpenEvidence, onSaveNote }: {
  scopeKey: string; persistedMessage: ChatMessage; paperId: string; paperTitle: string;
  onOpenEvidence(paperId: string, page: number): void; onSaveNote?(message: ChatMessage): void;
}) {
  const message = useConversationMessage(scopeKey, persistedMessage);
  return <article tabIndex={-1} data-message-id={message.id} className={`auxiliary-message auxiliary-message--${message.role}${message.error ? " auxiliary-message--error" : ""}`}>
    <header><small>{message.role === "user" ? "你" : "Luna"}</small>{message.page && <button type="button" className="evidence-link" onClick={() => onOpenEvidence(message.paperId || paperId, message.page!)}>第 {message.page} 页 ↗</button>}</header>
    {message.role === "assistant" ? <MarkdownMessage text={message.text || (message.pending ? "" : "未收到回答")} onOpenEvidence={onOpenEvidence} /> : <div className="auxiliary-message__text">{message.text}</div>}
    {message.attachment && <div className="message-attachment"><ComposerAttachment label="已发送选文" attachment={{ ...message.attachment, paperTitle }} onOpenEvidence={onOpenEvidence} /></div>}
    {(message.contextCoverage || message.pageImages?.length) && <details className="message-evidence"><summary>{message.contextCoverage ? `${message.contextCoverage.complete ? "已提取文字" : "相关文字／节选"} · ${message.contextCoverage.providedPages}/${message.contextCoverage.totalPages} 页` : "本轮原文证据"}{!!message.pageImages?.length && ` · ${message.pageImages.length} 张页图`}</summary><p>统计仅包含已提取文字；扫描页与图表以附带页图为准。</p>{!!message.pageImages?.length && <div>{message.pageImages.map(item => <button type="button" className="evidence-link" key={`${item.paperId}:${item.page}`} onClick={() => onOpenEvidence(item.paperId,item.page)}>第 {item.page} 页 ↗</button>)}</div>}</details>}
    {message.role === "assistant" && <ResponseStatus message={message} />}
    {message.interrupted && <small className="context-coverage">回答已停止，已保留现有内容。</small>}
    {message.error && message.text && <small className="context-coverage">回答未完成，可重新发送问题。</small>}
    {message.role === "assistant" && message.text && !message.pending && onSaveNote && <button type="button" className="message-save-note" onClick={() => onSaveNote(message)}>保存为笔记</button>}
  </article>;
});

export default function AuxiliaryChat({ paper, scopeKey, messages, draft: persistedDraft, onDraftChange, busy, blocked, ready, connected, fast, error, attachment, onRemoveAttachment, expanded: controlledExpanded, onExpandedChange, focusRequest, messageJump, onReturnToRunning, onSaveNote, onLogin, onSend, onStop, onOpenEvidence }: Props) {
  const [fallbackExpanded, setFallbackExpanded] = useState(() => {
    try { return localStorage.getItem("paper-ocean-auxiliary-expanded") === "true"; } catch { return false; }
  });
  const expanded = controlledExpanded ?? fallbackExpanded;
  const { draft, setDraft, flushDraft } = useComposerDraft(scopeKey, persistedDraft, onDraftChange);
  const bodyId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const followRef = useRef(true);
  const composingRef = useRef(false);
  const appliedJumpRef = useRef("");
  const jumpingRef = useRef(false);
  const [unread, setUnread] = useState(false);
  const [hasNewAnswer, setHasNewAnswer] = useState(false);
  const seenContent = useRef(new Map<string, string>());
  const evidenceCallbackRef = useRef(onOpenEvidence);
  evidenceCallbackRef.current = onOpenEvidence;
  const openEvidence = useCallback((paperId: string, page: number) => evidenceCallbackRef.current(paperId,page), []);
  const latest = messages.at(-1);
  const contentKey = latest?.role === "assistant" && latest.text ? `${latest.id}:${latest.text.length}` : "";

  const changeExpanded = (value: boolean) => {
    if (controlledExpanded === undefined) {
      setFallbackExpanded(value);
      try { localStorage.setItem("paper-ocean-auxiliary-expanded", String(value)); } catch { /* Keep the session preference. */ }
    }
    onExpandedChange?.(value);
    if (value) setUnread(false);
    else { flushDraft(); toggleRef.current?.focus({ preventScroll: true }); }
  };
  useEffect(() => {
    followRef.current = true;
    setUnread(false);
    setHasNewAnswer(false);
    if (!seenContent.current.has(scopeKey)) seenContent.current.set(scopeKey, contentKey);
  }, [scopeKey]);
  useEffect(() => {
    if (expanded && followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    if (expanded) seenContent.current.set(scopeKey, contentKey);
    setUnread(!expanded && Boolean(contentKey) && seenContent.current.get(scopeKey) !== contentKey);
    if (expanded && !followRef.current && contentKey) setHasNewAnswer(true);
  }, [contentKey, expanded, scopeKey]);
  useEffect(() => {
    const content = itemsRef.current;
    if (!expanded || !content) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, scopeKey]);
  useEffect(() => {
    if (!focusRequest) return;
    changeExpanded(true);
    const frame = requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  useLayoutEffect(() => {
    const field = composerRef.current;
    if (!field || !expanded) return;
    field.style.height = "auto";
    field.style.height = `${Math.max(42, Math.min(field.scrollHeight, 100))}px`;
  }, [draft, expanded, scopeKey]);
  useEffect(() => {
    if (!expanded || !messageJump) return;
    const jumpKey = `${scopeKey}:${messageJump.requestId}`;
    if (appliedJumpRef.current === jumpKey) return;
    let settleFrame = 0;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const target = Array.from(itemsRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find(node => node.dataset.messageId === messageJump.messageId);
      if (!scroller || !target) return;
      appliedJumpRef.current = jumpKey;
      followRef.current = false;
      jumpingRef.current = true;
      setHasNewAnswer(false);
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
      target.focus({ preventScroll: true });
      settleFrame = requestAnimationFrame(() => { jumpingRef.current = false; });
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(settleFrame); jumpingRef.current = false; };
  }, [expanded, scopeKey, messageJump?.requestId, messages.length]);
  const send = () => {
    if (!ready || busy || blocked || !draft.trim() || composingRef.current) return;
    flushDraft();
    followRef.current = true;
    setHasNewAnswer(false);
    onSend(draft.trim());
  };

  return <section className={`auxiliary-chat auxiliary-chat--workspace${expanded ? " auxiliary-chat--expanded" : ""}`} data-busy={busy} data-unread={unread} aria-label="论文辅助对话" onKeyDown={event => {
    if (event.key === "Escape" && expanded && !composingRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); changeExpanded(false); }
  }}>
    <button ref={toggleRef} className="auxiliary-chat__toggle" type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => {
      changeExpanded(!expanded);
      if (!expanded) requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    }}>
      <MessageCircle size={16} aria-hidden="true" /><strong>辅助对话</strong>
      <span>{busy ? "正在回答…" : unread ? "有新回答" : "独立上下文"}</span>
      {!expanded && attachment && <small className="auxiliary-attachment-count">1 处选文</small>}
      {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
    </button>
    <div id={bodyId} className="auxiliary-chat__body" hidden={!expanded}>
      <button type="button" className="auxiliary-chat__scope" title={paper.title} onClick={() => openEvidence(paper.id,paper.lastPage ?? 1)}><small>本讨论依据</small><span>{paper.title}</span></button>
      <div className="auxiliary-chat__messages" ref={scrollRef} role="log" aria-label="辅助对话记录" aria-live="off" onScroll={() => {
        const el = scrollRef.current;
        if (el && !jumpingRef.current) { followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; if (followRef.current) setHasNewAnswer(false); }
      }}><div ref={itemsRef} className="auxiliary-chat__message-items">
        {!messages.length && <p className="auxiliary-chat__empty">随手追问术语、公式或一段原文，保留主讨论的思路。</p>}
        {messages.map(message => <AuxiliaryMessage key={message.id} scopeKey={scopeKey} persistedMessage={message} paperId={paper.id} paperTitle={paper.title} onOpenEvidence={openEvidence} onSaveNote={onSaveNote} />)}
      </div></div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{busy ? "辅助对话正在回答" : latest?.role === "assistant" ? latest.error ? "辅助回答失败" : latest.interrupted ? "辅助回答已停止" : "辅助回答已完成" : ""}</span>
      {hasNewAnswer && <button type="button" className="auxiliary-chat__latest" onClick={() => { followRef.current = true; setHasNewAnswer(false); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}><ArrowDown size={13} aria-hidden="true" />查看新回答</button>}
      {error && <div className="auxiliary-chat__error" role="alert">{error}</div>}
      <form className="auxiliary-chat__composer" onSubmit={event => { event.preventDefault(); send(); }}>
        {blocked && <div className="conversation-blocked" role="status"><span>另一讨论正在回答，可先写下问题。</span>{onReturnToRunning && <button type="button" onClick={onReturnToRunning}>返回该讨论</button>}</div>}
        {attachment && <ComposerAttachment attachment={attachment} onRemove={onRemoveAttachment} onOpenEvidence={openEvidence} />}
        <textarea ref={composerRef} aria-label="辅助对话问题" placeholder={attachment ? "围绕附加选文提问…" : blocked ? "可先写下问题，完成后发送…" : ready ? "问问这篇论文…" : connected ? "等待论文和模型就绪…" : "登录后可提问"} value={draft} rows={2}
          onChange={event => setDraft(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send(); }
          }} />
        <div className="auxiliary-chat__composer-toolbar"><small>Luna · max{fast ? " · Fast" : ""}</small>
          {!connected ? <button type="button" onClick={onLogin}>登录</button>
            : busy ? <button type="button" aria-label="停止辅助回答" onClick={onStop}><Square size={14} fill="currentColor" aria-hidden="true" /></button>
            : <button type="submit" aria-label="发送辅助问题" disabled={!ready || blocked || !draft.trim()}><Send size={16} aria-hidden="true" /></button>}
        </div>
      </form>
    </div>
  </section>;
}
