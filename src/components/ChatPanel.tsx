import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, CheckCircle2, Quote, Send, Sparkles, Square } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";
import ResponseStatus from "./ResponseStatus";
import useChatPosition from "../hooks/useChatPosition";
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
  selectedText: string;
  currentPage: number;
  busy: boolean;
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
  draft: input,
  position,
  onDraftChange: setInput,
  onPositionChange,
  onOpenEvidence,
  onSaveNote,
  selectedText,
  currentPage,
  busy,
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
  const [hasNewAnswer, setHasNewAnswer] = useState(false);
  const composingRef = useRef(false);
  const previousMessagesRef = useRef(messages);
  const [search, setSearch] = useState("");
  const [foundIndex, setFoundIndex] = useState(0);
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
    if (!value || readOnly || !scopePapers.length || busy || !modelSelection) return;
    onSend(value);
    scrollToLatest();
  };

  const scopeDescription = isAllScope
    ? `全部 ${scopePapers.length} 篇论文`
    : scopePapers[0]
      ? `《${scopePapers[0].title}》`
      : "当前论文";

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
  const announcement = busy
    ? "Codex 正在回答"
    : latestMessage?.role === "assistant" && !latestMessage.pending
      ? latestMessage.error
        ? "Codex 回答失败"
        : latestMessage.interrupted || latestMessage.text === "回答已停止。"
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
              多论文
            </button>
          </div>
        )}
        <div className={`account-chip ${account?.connected ? "account-chip--online" : ""}`}>
          <span className="status-dot" />
          {account?.connected ? `CODEX ${(account.planType ?? "PRO").toUpperCase()}` : "未连接"}
        </div>
      </header>

      {!!conversations.length && <div className="conversation-controls">
        <select aria-label="选择讨论" value={scopeKey} onChange={(event) => onSelectConversation(event.target.value)}>
          {!conversation && <option value={scopeKey}>选择讨论</option>}
          {conversations.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.readOnly ? "历史" : `${item.paperIds.length} 篇`}</option>)}
        </select>
        <button type="button" onClick={onNewConversation} disabled={busy || (!scopePapers.length && !openPapers.length)}>新讨论</button>
        {conversation && <input aria-label="讨论标题" value={conversation.title} onChange={(event) => onRenameConversation(event.target.value)} />}
        <p>{conversation?.readOnly ? "旧记录没有保存完整论文集合，历史与草稿已保留。请用新讨论继续。" : readOnly ? "这次讨论绑定的论文有缺失，请恢复资料或新建讨论。" : `固定论文集合：${scopePapers.map((paper) => paper.title).join("、")}`}</p>
      </div>}

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
          <button type="button" disabled={readOnly || busy} onClick={() => onSend("请逐句解释我选中的内容，并说明它在全文论证中的作用。")}>解释这段</button>
        </div>
      )}

      {!!messages.length && (
        <div className="chat-navigation">
          <select aria-label="跳转到问题" value="" onChange={(event) => goToMessage(event.target.value)}>
            <option value="" disabled>问题导航 · {questions.length}</option>
            {questions.map((message, index) => <option key={message.id} value={message.id}>{index + 1}. {message.text.slice(0, 80)}</option>)}
          </select>
          <div className="chat-search">
            <input aria-label="搜索对话" placeholder="搜索对话" value={search} onChange={(event) => {
              const query = event.target.value;
              setSearch(query);
              setFoundIndex(0);
              const first = query.trim() && messages.find((message) => message.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
              if (first) goToMessage(first.id);
            }} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); visitMatch(foundIndex + (event.shiftKey ? -1 : 1)); }
            }} />
            {search && <>
              <button type="button" aria-label="上一条搜索结果" disabled={!matches.length} onClick={() => visitMatch(foundIndex - 1)}>↑</button>
              <button type="button" aria-label="下一条搜索结果" disabled={!matches.length} onClick={() => visitMatch(foundIndex + 1)}>↓</button>
              <span role="status">{matches.length ? foundIndex + 1 : 0}/{matches.length}</span>
            </>}
          </div>
        </div>
      )}

      <div
        className="message-list"
        ref={scrollRef}
        role="log"
        aria-live="polite"
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
                  <button type="button" key={index} onClick={() => onSend(prompt)} disabled={readOnly || busy || !modelSelection}>{prompt}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} data-message-id={message.id} className={`message message--${message.role} ${message.error ? "message--error" : ""} ${search && matches[foundIndex]?.id === message.id ? "message--match" : ""}`}>
            <header>{message.role === "user" ? "你" : "Codex"}{message.page && (message.paperId || scopePaperId) ? <button type="button" className="evidence-link" onClick={() => onOpenEvidence(message.paperId || scopePaperId!, message.page!)}>第 {message.page} 页 ↗</button> : message.page ? ` · 第 ${message.page} 页` : ""}</header>
            {message.contextCoverage && <small className="context-coverage" title="这里只统计已提取的文字。扫描页和图表的视觉内容以本轮附带页图为准，不包含自动 OCR。">{message.contextCoverage.complete ? "已提取文字" : "相关文字／节选"} · {message.contextCoverage.providedPages}/{message.contextCoverage.totalPages} 页</small>}
            {!!message.pageImages?.length && <small className="context-coverage">页图证据：{message.pageImages.map((item) => <button type="button" className="evidence-link" key={`${item.paperId}:${item.page}`} onClick={() => onOpenEvidence(item.paperId, item.page)}>{scopePapers.length > 1 ? `${scopePapers.find((paper) => paper.id === item.paperId)?.title.slice(0, 14) ?? "论文"} · ` : ""}第 {item.page} 页</button>)}</small>}
            {message.role === "assistant" && message.text
              ? <MarkdownMessage text={message.text} onOpenEvidence={openEvidence} />
              : <div className="message__content">{message.text || (message.pending ? `${message.responsePhase ?? "准备回答"}…` : "")}</div>}
            {message.role === "assistant" && <ResponseStatus message={message} />}
            {message.pending && <span className="typing-indicator" aria-label="Codex 正在回答"><i /><i /><i /></span>}
            {message.interrupted && <small className="context-coverage" role="status">回答已停止，以上为已生成的部分内容。</small>}
            {message.error && message.text && <small className="context-coverage" role="status">回答未完成；已保留现有内容，可重新发送问题。</small>}
            {message.role === "assistant" && message.text && !message.pending && <button type="button" className="message-save-note" onClick={() => onSaveNote(message)}>保存为笔记</button>}
          </article>
        ))}
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

      <div className="chat-composer">
        {modelError && <div className="model-connection-status" role="status"><span>{modelError}</span><button type="button" onClick={onRetryModels}>重试连接</button></div>}
        <div className="reading-preferences">
          <label>回答深度 <select aria-label="回答深度" value={depth} onChange={(event) => onPreferencesChange({ ...preferences, depth: event.target.value as ReadingPreferences["depth"] })}>
            <option value="brief">简短</option><option value="balanced">标准</option><option value="deep">深入</option>
          </select></label>
          <label title="Fast 保留 max 思考强度。官方标称约 1.5 倍速度，GPT-5.6 额度消耗约为标准模式的 2.5 倍。">响应速度 <select aria-label="响应速度" disabled={busy} value={fast ? "fast" : "standard"} onChange={event => onPreferencesChange({ ...preferences, depth, speed: event.target.value as ReadingPreferences["speed"] })}>
            <option value="fast" disabled={!modelSelection?.serviceTier}>Fast{!modelSelection?.serviceTier ? "（当前不可用）" : " · 更多额度"}</option>
            <option value="standard">标准</option>
          </select></label>
          <details className="prompt-settings">
            <summary>提问模板</summary>
            <div className="prompt-settings__body">
              {prompts.map((prompt, index) => <div key={index}>
                <textarea aria-label={`提问模板 ${index + 1}`} rows={2} maxLength={8000} value={prompt} onChange={(event) => onPreferencesChange({ ...preferences, depth, templates: prompts.map((text, offset) => offset === index ? event.target.value : text) })} />
                <button type="button" disabled={!prompt.trim()} onClick={() => setInput(input.trim() ? `${input}\n\n${prompt}` : prompt)}>填入问题</button>
              </div>)}
              <button type="button" disabled={prompts.length >= 8} onClick={() => onPreferencesChange({ ...preferences, depth, templates: [...prompts, ""] })}>新增模板</button>
              <button type="button" onClick={() => onPreferencesChange({ ...preferences, depth, templates: undefined })}>恢复默认模板</button>
            </div>
          </details>
        </div>
        <textarea
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
          placeholder={scopePapers.length ? `询问${scopeDescription}的完整内容…` : "请先打开论文"}
          disabled={!scopePapers.length && !conversation?.readOnly}
          rows={3}
          aria-label="向 Codex 提问"
        />
        <div className="composer-toolbar">
          <span className="reading-model-label" title={modelSelection ? "阅读模型固定为 GPT-5.6 Luna，思考强度 max" : "当前模型暂不可用，请检查 Codex 连接"}>GPT-5.6 Luna · max{fast && " · Fast"}{!modelSelection && " · 暂不可用"}</span>
          <button
            type="button"
            className={`send-button${busy ? " send-button--stop" : ""}`}
            onClick={busy ? onStop : submit}
            disabled={!busy && (readOnly || !scopePapers.length || !input.trim() || !modelSelection)}
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
