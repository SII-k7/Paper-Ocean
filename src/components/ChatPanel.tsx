import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, CheckCircle2, ChevronDown, Clock3, Files, MoreHorizontal, Search, Send, SlidersHorizontal, Sparkles, Square, X } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";
import ResponseStatus from "./ResponseStatus";
import ComposerAttachment, { type ComposerAttachmentData } from "./ComposerAttachment";
import useChatPosition from "../hooks/useChatPosition";
import useConversationMessage from "../hooks/useConversationMessage";
import useComposerDraft from "../hooks/useComposerDraft";
import type {
  ChatMessage,
  ChatPosition,
  ConversationRecord,
  CodexAccount,
  CodexSelection,
  PaperRecord,
  RateLimitInfo,
  ReadingPreferences,
} from "../types";

type Props = {
  activePaper: PaperRecord | null;
  openPapers: PaperRecord[];
  scopeKey: string;
  conversation?: ConversationRecord;
  conversations: ConversationRecord[];
  scopePapers: PaperRecord[];
  onNewConversation(): void;
  onRenameConversation(title: string): void;
  preferences?: ReadingPreferences;
  onPreferencesChange(preferences: ReadingPreferences): void;
  account: CodexAccount | null;
  rateLimits: RateLimitInfo | null;
  messages: ChatMessage[];
  draft: string;
  position?: ChatPosition;
  onDraftChange(draft: string): void;
  onPositionChange(position: ChatPosition): void;
  onOpenEvidence(paperId: string, page: number): void;
  onSaveNote(message: ChatMessage): void;
  selectedText?: string;
  currentPage?: number;
  readingPaperId?: string;
  attachment?: ComposerAttachmentData | null;
  onRemoveAttachment?(): void;
  focusRequest?: number;
  onReturnToRunning?(): void;
  busy: boolean;
  blocked: boolean;
  error?: string | null;
  modelSelection: CodexSelection | null;
  modelError?: string | null;
  onRetryModels(): void;
  onScopeChange(scopeKey: string): void;
  onSelectConversation(scopeKey: string): void;
  onLogin(): void;
  onSend(text: string): void;
  onStop(): void;
};

const SINGLE_PROMPTS = [
  "请完整、深入地解读这篇文章，重点讲方法、架构、核心创新与实验证据",
  "结合全文详细解释当前页的作用，以及它和前后章节的逻辑关系",
  "深入拆解网络架构、关键模块、数据流，以及训练和推理流程",
  "完整分析实验与消融：每组结果支撑了哪些主张，还有哪些问题尚未证明？",
];

const ALL_PROMPTS = [
  "完整比较这些论文的研究问题、方法、架构、创新、实验证据与局限",
  "深入梳理这些论文之间的方法继承、关键分歧及其取舍",
  "给出由浅入深的阅读顺序，并详细解释每一步的知识依赖",
  "系统分析哪些结论互相支持、哪些存在冲突，以及证据强弱",
];

const ConversationMessage = memo(function ConversationMessage({ scopeKey, persistedMessage, scopePaperId, scopePapers, matched, onOpenEvidence, onSaveNote }: {
  scopeKey: string; persistedMessage: ChatMessage; scopePaperId?: string; scopePapers: PaperRecord[]; matched: boolean;
  onOpenEvidence(paperId: string, page: number): void; onSaveNote(message: ChatMessage): void;
}) {
  const message = useConversationMessage(scopeKey, persistedMessage);
  return <article data-message-id={message.id} className={`message message--${message.role}${message.error ? " message--error" : ""}${matched ? " message--match" : ""}`}>
    <header>{message.role === "user" ? "你" : "Luna"}{message.page && (message.paperId || scopePaperId) ? <button type="button" className="evidence-link" onClick={() => onOpenEvidence(message.paperId || scopePaperId!, message.page!)}>第 {message.page} 页 ↗</button> : message.page ? ` · 第 ${message.page} 页` : ""}</header>
    {message.role === "assistant" && message.text ? <MarkdownMessage text={message.text} onOpenEvidence={onOpenEvidence} /> : <div className="message__content">{message.text || (message.pending ? `${message.responsePhase ?? "准备回答"}…` : "")}</div>}
    {message.attachment && <div className="message-attachment"><ComposerAttachment label="已发送选文" attachment={{ ...message.attachment, paperTitle: scopePapers.find(paper => paper.id === message.attachment?.paperId)?.title ?? "原文" }} onOpenEvidence={onOpenEvidence} /></div>}
    {(message.contextCoverage || message.pageImages?.length) && <details className="message-evidence"><summary>{message.contextCoverage ? `${message.contextCoverage.complete ? "已提取文字" : "相关文字／节选"} · ${message.contextCoverage.providedPages}/${message.contextCoverage.totalPages} 页` : "查看本轮原文证据"}{!!message.pageImages?.length && ` · ${message.pageImages.length} 张页图`}</summary>
      <p>覆盖统计仅包含已提取的文字；扫描页与图表以本轮附带页图为准。</p>
      {!!message.pageImages?.length && <div>{message.pageImages.map(item => <button type="button" className="evidence-link" key={`${item.paperId}:${item.page}`} onClick={() => onOpenEvidence(item.paperId,item.page)}>{scopePapers.length > 1 ? `${scopePapers.find(paper => paper.id === item.paperId)?.title.slice(0,14) ?? "论文"} · ` : ""}第 {item.page} 页 ↗</button>)}</div>}
    </details>}
    {message.role === "assistant" && <ResponseStatus message={message} />}
    {message.pending && <span className="typing-indicator" aria-hidden="true"><i /><i /><i /></span>}
    {message.interrupted && <small className="context-coverage">回答已停止，以上为已生成的部分内容。</small>}
    {message.error && message.text && <small className="context-coverage">回答未完成；已保留现有内容，可重新发送问题。</small>}
    {message.role === "assistant" && message.text && !message.pending && <button type="button" className="message-save-note" onClick={() => onSaveNote(message)}>保存为笔记</button>}
  </article>;
});

export default function ChatPanel({
  activePaper,
  openPapers,
  scopeKey,
  conversation,
  conversations,
  scopePapers,
  onNewConversation,
  onRenameConversation,
  preferences,
  onPreferencesChange,
  account,
  rateLimits,
  messages,
  draft: persistedDraft,
  position,
  onDraftChange,
  onPositionChange,
  onOpenEvidence,
  onSaveNote,
  readingPaperId,
  attachment,
  onRemoveAttachment,
  focusRequest,
  onReturnToRunning,
  busy,
  blocked,
  error,
  modelSelection,
  modelError,
  onRetryModels,
  onScopeChange,
  onSelectConversation,
  onLogin,
  onSend,
  onStop,
}: Props) {
  const { draft: input, setDraft: setInput, flushDraft } = useComposerDraft(scopeKey, persistedDraft, onDraftChange);
  const [hasNewAnswer, setHasNewAnswer] = useState(false);
  const composingRef = useRef(false);
  const previousMessagesRef = useRef(messages);
  const [search, setSearch] = useState("");
  const [foundIndex, setFoundIndex] = useState(0);
  const [panel, setPanel] = useState<"context" | "history" | "more" | "search" | "settings" | null>(null);
  const [renameDraft, setRenameDraft] = useState(conversation?.title ?? "");
  const rootRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelOpenerRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const panelId = useId();
  const evidenceCallbackRef = useRef(onOpenEvidence);
  evidenceCallbackRef.current = onOpenEvidence;
  const openEvidence = useCallback((paperId: string, page: number) => evidenceCallbackRef.current(paperId, page), []);
  const { scrollRef, itemsRef, positionRef, remember, goToMessage, scrollToLatest: followLatest } = useChatPosition(messages, position, onPositionChange);
  const isAllScope = scopePapers.length > 1 || conversation?.readOnly;
  const scopePaperId = scopePapers.length === 1 ? scopePapers[0].id : undefined;
  const readOnly = conversation?.readOnly || scopePapers.length !== conversation?.paperIds.length;
  const scopeReady = !readOnly && scopePapers.length > 0 && scopePapers.every((paper) => paper.paperDir);
  const prompts = preferences?.templates ?? (isAllScope ? ALL_PROMPTS : SINGLE_PROMPTS);
  const depth = preferences?.depth ?? "deep";
  const fast = preferences?.speed !== "standard" && Boolean(modelSelection?.serviceTier);
  const viewingOtherPaper = Boolean((readingPaperId ?? activePaper?.id) && scopePapers.length && !scopePapers.some(paper => paper.id === (readingPaperId ?? activePaper?.id)));

  const closePanel = (restoreFocus = false) => {
    setPanel(null);
    if (restoreFocus) panelOpenerRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => { setPanel(null); setSearch(""); setFoundIndex(0); setHasNewAnswer(false); }, [scopeKey]);
  useEffect(() => {
    if (!focusRequest) return;
    setPanel(null);
    composerRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  useLayoutEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.max(50, Math.min(field.scrollHeight, 152))}px`;
  }, [input, scopeKey]);
  useEffect(() => {
    if (!panel) return;
    if (panel === "more") setRenameDraft(conversation?.title ?? "");
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close-panel])")?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !(target instanceof Element && target.closest("[data-conversation-panel-trigger]"))) setPanel(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); };
  }, [panel]);

  const scrollToLatest = () => {
    followLatest();
    setHasNewAnswer(false);
  };

  useEffect(() => {
    const changed = previousMessagesRef.current !== messages;
    previousMessagesRef.current = messages;
    if (changed && !positionRef.current.followOutput) {
      if (messages.at(-1)?.role === "assistant") setHasNewAnswer(true);
      return;
    }
  }, [messages]);

  const submit = () => {
    const value = input.trim();
    if (!value || composingRef.current || readOnly || !scopePapers.length || busy || blocked || !modelSelection) return;
    flushDraft();
    onSend(value);
    scrollToLatest();
  };

  const usage = rateLimits?.primary?.usedPercent;
  const indexedPages = scopePapers.reduce((sum, paper) => sum + (paper.pageCount ?? 0), 0);
  const latestMessage = messages.at(-1);
  const questions = messages.filter((message) => message.role === "user");
  const matches = search.trim() ? messages.filter((message) => message.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [];
  const visitMatch = (index: number) => {
    if (!matches.length) return;
    const bounded = (index + matches.length) % matches.length;
    setFoundIndex(bounded);
    goToMessage(matches[bounded].id);
  };
  const announcement = blocked
    ? "另一讨论正在回答，完成后可在这里提问"
    : busy
    ? "Codex 正在回答"
    : latestMessage?.role === "assistant" && !latestMessage.pending
      ? latestMessage.error
        ? "Codex 回答失败"
        : latestMessage.interrupted || latestMessage.text === "回答已停止。"
          ? "Codex 回答已停止"
          : "Codex 回答完成"
      : "";

  const openPanel = (next: NonNullable<typeof panel>, opener?: HTMLButtonElement) => {
    if (opener) panelOpenerRef.current = opener;
    setPanel(current => current === next ? null : next);
  };

  return (
    <section ref={rootRef} className="chat-panel conversation-ui" aria-label="AI 论文对话" onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape" && panel) { event.preventDefault(); event.stopPropagation(); closePanel(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && messages.length) {
        event.preventDefault(); event.stopPropagation();
        if (panel !== "search") panelOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPanel("search");
      }
    }}>
      <header className="chat-topbar conversation-header">
        <button type="button" className="conversation-context" data-conversation-panel-trigger aria-label="查看对话绑定论文" aria-expanded={panel === "context"} aria-controls={panel === "context" ? panelId : undefined} onClick={event => openPanel("context", event.currentTarget)}>
          <Files size={17} aria-hidden="true" />
          <span><small className="chat-topbar__label">{busy ? latestMessage?.responsePhase ?? "正在回答" : blocked ? "另一讨论正在回答" : "本讨论依据"}</small>
            <strong title={scopePapers.map(paper => paper.title).join("、")}>{scopePapers.length === 1 ? scopePapers[0].title : scopePapers.length ? `${scopePapers.length} 篇论文` : conversation?.readOnly ? "历史讨论" : "尚未添加论文"}</strong></span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button type="button" className="conversation-icon-button" data-conversation-panel-trigger aria-label="讨论历史" title="讨论历史" aria-expanded={panel === "history"} aria-controls={panel === "history" ? panelId : undefined} onClick={event => openPanel("history", event.currentTarget)}><Clock3 size={17} aria-hidden="true" /></button>
        <button type="button" className="conversation-icon-button" data-conversation-panel-trigger aria-label="更多对话操作" title="更多对话操作" aria-expanded={panel === "more"} aria-controls={panel === "more" ? panelId : undefined} onClick={event => openPanel("more", event.currentTarget)}><MoreHorizontal size={19} aria-hidden="true" /></button>
      </header>
      {viewingOtherPaper && <div className="conversation-context-notice" role="status">正在查看其他论文；本讨论仍使用上方资料。</div>}
      {readOnly && <div className="conversation-context-notice" role="status">{conversation?.readOnly ? "旧记录未保存完整论文范围，历史与草稿仍保留。请新建讨论继续。" : "本讨论有论文缺失，请恢复原文或新建讨论。"}</div>}

      {panel && <div ref={panelRef} id={panelId} className="conversation-popover" role="dialog" aria-label={{context:"对话资料",history:"讨论历史",more:"更多对话操作",search:"查找对话",settings:"回答设置"}[panel]}>
        <header><strong>{{context:"对话资料",history:"讨论历史",more:"更多操作",search:"查找对话",settings:"回答设置"}[panel]}</strong><button type="button" data-close-panel className="conversation-icon-button" aria-label="关闭对话工具" onClick={() => closePanel(true)}><X size={16} aria-hidden="true" /></button></header>
        {panel === "context" && <div className="conversation-tools-body">
          <p>本讨论固定使用以下资料。查看其他原文不会改变讨论范围。</p>
          <ul className="conversation-source-list">{scopePapers.map(paper => <li key={paper.id}><button type="button" onClick={() => { onOpenEvidence(paper.id, paper.lastPage ?? 1); closePanel(true); }}><span>{paper.title}</span><small>{paper.pageCount ? `${paper.pageCount} 页` : "页数待确认"}</small></button></li>)}</ul>
          {!!openPapers.length && <div className="conversation-actions" role="group" aria-label="对话范围">
            <button type="button" disabled={!activePaper} onClick={() => { if (activePaper) onScopeChange(`paper:${activePaper.id}`); closePanel(); }}>与正在阅读的论文对话</button>
            <button type="button" disabled={openPapers.length < 2} onClick={() => { onScopeChange("all"); closePanel(); }}>多论文讨论</button>
          </div>}
        </div>}
        {panel === "history" && <div className="conversation-tools-body">
          {conversations.length ? <label>已保存的讨论<select className="conversation-history-list" aria-label="选择讨论" size={Math.min(7, Math.max(2, conversations.length))} value={scopeKey} onChange={event => { onSelectConversation(event.target.value); closePanel(); }}>
            {!conversation && <option value={scopeKey}>选择讨论</option>}
            {conversations.map(item => <option key={item.id} value={item.id}>{item.title} · {item.readOnly ? "历史" : `${item.paperIds.length} 篇`}</option>)}
          </select></label> : <p>打开论文后，讨论会自动保存在这里。</p>}
          <button type="button" onClick={() => { onNewConversation(); closePanel(); }} disabled={busy || blocked || (!scopePapers.length && !openPapers.length)}>新讨论</button>
        </div>}
        {panel === "more" && <div className="conversation-tools-body">
          {conversation && <form className="conversation-rename" onSubmit={event => { event.preventDefault(); if (renameDraft.trim()) { onRenameConversation(renameDraft.trim()); closePanel(true); } }}>
            <label>讨论标题<input aria-label="讨论标题" value={renameDraft} maxLength={300} onChange={event => setRenameDraft(event.target.value)} /></label><button type="submit" disabled={!renameDraft.trim()}>保存标题</button>
          </form>}
          <div className="conversation-actions">
            <button type="button" disabled={!messages.length} onClick={() => setPanel("search")}><Search size={15} aria-hidden="true" />查找对话</button>
            <button type="button" onClick={() => setPanel("settings")}><SlidersHorizontal size={15} aria-hidden="true" />回答设置与模板</button>
            <button type="button" onClick={() => { onNewConversation(); closePanel(); }} disabled={busy || blocked || (!scopePapers.length && !openPapers.length)}>新讨论</button>
          </div>
        </div>}
        {panel === "search" && <div className="conversation-tools-body">
          <div className="chat-search"><input aria-label="搜索对话" placeholder="在这段讨论中查找…" value={search} onChange={event => { const query = event.target.value; setSearch(query); setFoundIndex(0); const first = query.trim() && messages.find(message => message.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())); if (first) goToMessage(first.id); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); visitMatch(foundIndex + (event.shiftKey ? -1 : 1)); } }} />
            <button type="button" aria-label="上一条搜索结果" disabled={!matches.length} onClick={() => visitMatch(foundIndex - 1)}>↑</button><button type="button" aria-label="下一条搜索结果" disabled={!matches.length} onClick={() => visitMatch(foundIndex + 1)}>↓</button>
          </div><small role="status">{search ? `${matches.length ? foundIndex + 1 : 0} / ${matches.length} 条匹配` : "输入文字查找；Enter 下一条，Shift + Enter 上一条"}</small>
          <label>按问题跳转<select aria-label="跳转到问题" value="" onChange={event => { goToMessage(event.target.value); closePanel(true); }}><option value="" disabled>选择一个问题</option>{questions.map((message,index) => <option key={message.id} value={message.id}>{index + 1}. {message.text.slice(0,80)}</option>)}</select></label>
        </div>}
        {panel === "settings" && <div className="conversation-tools-body">
          <div className="conversation-preferences"><label>回答深度<select aria-label="回答深度" value={depth} onChange={event => onPreferencesChange({ ...preferences, depth: event.target.value as ReadingPreferences["depth"] })}><option value="brief">简短</option><option value="balanced">标准</option><option value="deep">深入</option></select></label>
            <label>响应速度<select aria-label="响应速度" disabled={busy} value={fast ? "fast" : "standard"} onChange={event => onPreferencesChange({ ...preferences, depth, speed: event.target.value as ReadingPreferences["speed"] })}><option value="fast" disabled={!modelSelection?.serviceTier}>Fast{!modelSelection?.serviceTier ? "（当前不可用）" : " · 更多额度"}</option><option value="standard">标准</option></select></label>
          </div><p>Luna · max{fast ? " · Fast" : ""}。回答深度控制说明的详略，思考强度保持 max。</p>
          {usage !== undefined && <small>当前额度窗口已使用 {Math.round(usage)}%</small>}
          <details className="conversation-templates"><summary>提问模板 · {prompts.length}</summary><div>{prompts.map((prompt,index) => <div key={index}><textarea aria-label={`提问模板 ${index+1}`} rows={2} maxLength={8000} value={prompt} onChange={event => onPreferencesChange({ ...preferences, depth, templates: prompts.map((text,offset) => offset === index ? event.target.value : text) })} /><button type="button" disabled={!prompt.trim()} onClick={() => { setInput(input.trim() ? `${input}\n\n${prompt}` : prompt); closePanel(); requestAnimationFrame(() => composerRef.current?.focus()); }}>填入问题</button></div>)}<div className="conversation-actions"><button type="button" disabled={prompts.length >= 8} onClick={() => onPreferencesChange({ ...preferences, depth, templates: [...prompts, ""] })}>新增模板</button><button type="button" onClick={() => onPreferencesChange({ ...preferences, depth, templates: undefined })}>恢复默认模板</button></div></div></details>
        </div>}
      </div>}

      {!account?.connected && (
        <div className="login-card">
          <div>
            <strong>使用你的 ChatGPT 订阅</strong>
            <p>登录由本机 Codex 管理，Paper Ocean 不读取你的密码或登录令牌。</p>
          </div>
          <button type="button" className="primary-button" onClick={onLogin}>连接 Codex</button>
        </div>
      )}

      <div
        className="message-list"
        ref={scrollRef}
        role="log"
        aria-live="off"
        aria-relevant="additions"
        onScroll={(event) => {
          remember();
          if (positionRef.current.followOutput) setHasNewAnswer(false);
        }}
      >
        <div ref={itemsRef} className="message-items">
        {!messages.length && (
          <div className="chat-welcome">
            <div className="chat-welcome__mark"><Sparkles size={23} strokeWidth={1.8} aria-hidden="true" /></div>
            <h3>{scopePapers.length ? "准备分析" : "先打开一篇论文"}</h3>
            <p>{scopePapers.length
              ? `已载入 ${scopePapers.length} 篇论文、${indexedPages || "全部"} 页的全文索引。提问时会提供全文或相关页面，并显示实际覆盖范围。`
              : "打开后可以直接询问方法、公式、实验和相关工作。"}</p>
            {scopePapers.length > 0 && (
              <div className={`context-status ${scopeReady ? "context-status--ready" : ""}`} aria-live="polite">
                <CheckCircle2 size={14} aria-hidden="true" />
                {scopeReady ? "全文索引已载入" : "正在建立全文索引"}
              </div>
            )}
            {!!scopePapers.length && (
              <div className="quick-prompts">
                {prompts.map((prompt, index) => prompt.trim() && (
                  <button type="button" key={index} onClick={() => { flushDraft(); onSend(prompt); }} disabled={readOnly || busy || blocked || !modelSelection}>{prompt}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map(message => <ConversationMessage key={message.id} scopeKey={scopeKey} persistedMessage={message} scopePaperId={scopePaperId} scopePapers={scopePapers} matched={Boolean(search && matches[foundIndex]?.id === message.id)} onOpenEvidence={openEvidence} onSaveNote={onSaveNote} />)}
        </div>
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

      <div className="chat-composer conversation-composer">
        {blocked && <div className="conversation-blocked" role="status"><span>另一讨论正在回答，可先写下问题。</span>{onReturnToRunning && <button type="button" onClick={onReturnToRunning}>返回正在回答的讨论</button>}</div>}
        {modelError && <div className="model-connection-status" role="status"><span>{modelError}</span><button type="button" onClick={onRetryModels}>重试连接</button></div>}
        {attachment && <ComposerAttachment attachment={attachment} onRemove={onRemoveAttachment} onOpenEvidence={openEvidence} />}
        <textarea
          ref={composerRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={blocked ? "另一讨论正在回答，可先写下问题…" : attachment ? "围绕附加选文提问…" : scopePapers.length ? "就方法、公式或实验继续追问…" : "请先打开论文"}
          disabled={!scopePapers.length && !conversation?.readOnly}
          rows={2}
          aria-label="向 Codex 提问"
        />
        <div className="composer-toolbar">
          <button type="button" data-conversation-panel-trigger className="conversation-model-button" aria-label="打开回答设置" aria-expanded={panel === "settings"} onClick={event => openPanel("settings",event.currentTarget)} title="回答设置与提问模板"><SlidersHorizontal size={13} aria-hidden="true" /><span>Luna · max{fast && " · Fast"}{!modelSelection && " · 暂不可用"}</span><ChevronDown size={12} aria-hidden="true" /></button>
          <button
            type="button"
            className={`send-button${busy ? " send-button--stop" : ""}`}
            onClick={busy ? onStop : submit}
            disabled={!busy && (blocked || readOnly || !scopePapers.length || !input.trim() || !modelSelection)}
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
