import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircle, Send, Square } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";
import ResponseStatus from "./ResponseStatus";
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
  onLogin(): void;
  onSend(question: string): void;
  onStop(): void;
  onOpenEvidence(paperId: string, page: number): void;
};

export default function AuxiliaryChat({ paper, scopeKey, messages, draft, onDraftChange, busy, blocked, ready, connected, fast, error, onLogin, onSend, onStop, onOpenEvidence }: Props) {
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem("paper-ocean-auxiliary-expanded") === "true"; } catch { return false; }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const composingRef = useRef(false);
  const [unread, setUnread] = useState(false);
  const latest = messages.at(-1);
  useEffect(() => {
    followRef.current = true;
    setUnread(false);
  }, [scopeKey]);
  useEffect(() => {
    if (expanded && followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    if (!expanded && latest?.role === "assistant" && latest.text) setUnread(true);
  }, [latest?.text, latest?.pending, expanded, scopeKey]);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) setUnread(false);
    try { localStorage.setItem("paper-ocean-auxiliary-expanded", String(next)); } catch { /* Session-only preference is sufficient. */ }
  };
  const send = () => { if (ready && !busy && draft.trim()) onSend(draft.trim()); };
  return <section className={`auxiliary-chat${expanded ? " auxiliary-chat--expanded" : ""}`} aria-label="论文辅助对话">
    <button className="auxiliary-chat__toggle" type="button" aria-expanded={expanded} aria-controls="auxiliary-chat-body" onClick={toggle}>
      <MessageCircle size={16} />
      <strong>辅助对话</strong>
      <span>{busy ? "正在回答…" : unread ? "有新回答" : `Luna max${fast ? " · Fast" : ""}`}</span>
      {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
    </button>
    <div id="auxiliary-chat-body" className="auxiliary-chat__body" hidden={!expanded}>
      <div className="auxiliary-chat__scope" title={paper.title}>仅讨论当前论文 · 独立上下文<span>{paper.title}</span></div>
      <div className="auxiliary-chat__messages" ref={scrollRef} onScroll={() => {
        const el = scrollRef.current;
        if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}>
        {!messages.length && <p className="auxiliary-chat__empty">随手追问术语、公式或当前页，不打断右侧的讨论。</p>}
        {messages.map(message => <article key={message.id} className={`auxiliary-message auxiliary-message--${message.role}`}>
          <small>{message.role === "user" ? "你" : "Luna max"}</small>
          <MarkdownMessage text={message.text || (message.pending ? "" : "未收到回答")} onOpenEvidence={onOpenEvidence} />
          {message.role === "assistant" && <ResponseStatus message={message} />}
        </article>)}
      </div>
      {error && <div className="auxiliary-chat__error" role="alert">{error}</div>}
      <form className="auxiliary-chat__composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea aria-label="辅助对话问题" placeholder={blocked ? "另一篇论文正在回答，完成后可提问…" : ready ? "问问这篇论文…" : connected ? "等待论文索引和模型就绪…" : "登录后可提问"} value={draft} rows={2}
          onChange={event => onDraftChange(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); }
          }} />
        {!connected ? <button type="button" onClick={onLogin}>登录</button>
          : busy ? <button type="button" aria-label="停止辅助回答" onClick={onStop}><Square size={16} /></button>
          : <button type="submit" aria-label="发送辅助问题" disabled={!ready || !draft.trim()}><Send size={16} /></button>}
      </form>
    </div>
  </section>;
}
