import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Library, Moon, Plus, Settings, Sun, X } from "lucide-react";
import PaperSearch from "./components/PaperSearch";
import { fixedReadingSelection } from "../electron/reading-model.mjs";
import { createAnswerStream } from "./answer-stream.mjs";
import ChatPanel from "./components/ChatPanel";
import NotesPanel from "./components/NotesPanel";
import LibraryPanel from "./components/LibraryPanel";
import PaperTabs from "./components/PaperTabs";
import PdfReader, { type PdfReaderHandle } from "./components/PdfReader";
import RecommendationPanel from "./components/RecommendationPanel";
import ResizableWorkspace from "./components/ResizableWorkspace";
import useLibrary from "./hooks/useLibrary";
import usePaperDownload from "./hooks/usePaperDownload";
import DownloadStatus from "./components/DownloadStatus";
import AboutPanel from "./components/AboutPanel";
import paperOceanMark from "./assets/paper-ocean-mark.png";
import { buildPaperTurnPrompt } from "../electron/paper-prompt.mjs";
import { normalizeConversations, samePaperSet } from "../electron/conversations.mjs";
import type {
  ChatMessage,
  CodexAccount,
  CodexEvent,
  CodexModel,
  CodexSelection,
  ReadingPosition,
  OpenedPaper,
  PaperRecord,
  PdfPageIndex,
  RateLimitInfo,
  EvidenceAnchor,
  EvidenceRect,
  ResearchNote,
} from "./types";

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  scopeKey: string;
  assistantMessageId: string;
};

type Selection = {
  id: string;
  paperId: string;
  page: number;
  text: string;
  rects: EvidenceRect[];
};

class CancelledTurnError extends Error {}

type Theme = "dark" | "light";

function initialTheme(): Theme {
  const fromDocument = document.documentElement.dataset.theme;
  if (fromDocument === "light" || fromDocument === "dark") return fromDocument;
  try {
    const saved = window.localStorage.getItem("paper-ocean-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // The operating-system preference below is a safe first-run fallback.
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function paperScope(paperId: string) {
  return `paper:${paperId}`;
}


function recordFromOpened(paper: OpenedPaper): PaperRecord {
  const { dataBase64: _dataBase64, cachedPages: _cachedPages, ...record } = paper;
  return record;
}

function mergePaper(existing: PaperRecord | undefined, next: PaperRecord): PaperRecord {
  return {
    ...existing,
    ...next,
    threadId: next.threadId ?? existing?.threadId,
    paperDir: next.paperDir ?? existing?.paperDir,
    title: existing?.title || next.title || next.name,
    abstract: next.abstract || existing?.abstract,
    originalPath: next.originalPath || existing?.originalPath,
    authors: next.authors || existing?.authors,
    publishedAt: next.publishedAt || existing?.publishedAt,
    revisedAt: next.revisedAt || existing?.revisedAt,
    arxivId: next.arxivId || existing?.arxivId,
    arxivVersion: next.arxivVersion ?? existing?.arxivVersion,
    readingStatus: existing?.readingStatus === "done" ? "done" : "reading",
  };
}

function restoredPaper(opened: OpenedPaper, record: PaperRecord): OpenedPaper {
  return { ...opened, ...record, path: opened.path, originalPath: record.originalPath || opened.originalPath, managedOriginal: opened.managedOriginal || record.managedOriginal };
}

export default function App() {
  const readerRef = useRef<PdfReaderHandle>(null);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const cancelRequestedRef = useRef(false);
  const deltaBufferRef = useRef<{ scopeKey: string; messageId: string; text: string } | null>(null);
  const deltaTimerRef = useRef<number | undefined>(undefined);
  const answerStreamRef = useRef(createAnswerStream());
  const themeTransitionTimerRef = useRef<number | undefined>(undefined);
  const bootedRef = useRef(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [openedPapers, setOpenedPapers] = useState<Record<string, OpenedPaper>>({});
  const [activePaperId, setActivePaperId] = useState<string>();
  const [pagesByPaper, setPagesByPaper] = useState<Record<string, PdfPageIndex[]>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sidePanel, setSidePanel] = useState<"chat" | "notes">("chat");
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [discussionRequest, setDiscussionRequest] = useState(0);
  const [sourceJump, setSourceJump] = useState(0);
  const [showLibrary, setShowLibrary] = useState(false);
  const [chatScopeKey, setChatScopeKey] = useState("");
  const { library, setLibrary, libraryReady, initializeLibrary, saveState, flushLibrary } = useLibrary();
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [account, setAccount] = useState<CodexAccount | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [opening, setOpening] = useState(false);
  const download = usePaperDownload();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [destination, setDestination] = useState<{ paperId: string; position: ReadingPosition; requestId: number }>();
  const [evidenceHistory, setEvidenceHistory] = useState<Array<{ paperId: string; position: ReadingPosition }>>([]);

  const activePaper = activePaperId ? openedPapers[activePaperId] ?? null : null;
  const activeRecord = useMemo(
    () => (activePaperId
      ? library.papers.find((paper) => paper.id === activePaperId) ?? activePaper ?? null
      : null),
    [activePaper, activePaperId, library.papers],
  );
  const openRecords = useMemo(
    () => library.openPaperIds
      .map((id) => library.papers.find((paper) => paper.id === id))
      .filter((paper): paper is PaperRecord => Boolean(paper && openedPapers[paper.id])),
    [library.openPaperIds, library.papers, openedPapers],
  );
  const effectiveScopeKey = chatScopeKey || (activePaperId ? paperScope(activePaperId) : "");
  const conversations = useMemo(() => normalizeConversations(library), [library]);
  const activeConversation = conversations[effectiveScopeKey];
  const scopeRecords = (activeConversation?.paperIds ?? [])
    .map((id) => library.papers.find((paper) => paper.id === id))
    .filter((paper): paper is PaperRecord => Boolean(paper));
  const isMultiScope = (activeConversation?.paperIds.length ?? 0) > 1 || effectiveScopeKey === "all";
  const preferredPaperConversation = (paperId: string) => {
    const saved = library.lastConversationByPaper?.[paperId];
    return saved && conversations[saved]?.paperIds.length === 1 && conversations[saved].paperIds[0] === paperId ? saved : paperScope(paperId);
  };
  const pages = activePaperId ? pagesByPaper[activePaperId] ?? [] : [];
  const messages = effectiveScopeKey ? library.messagesByScope[effectiveScopeKey] ?? [] : [];
  const selectedText = selection && scopeRecords.some((paper) => paper.id === selection.paperId)
    ? selection.text
    : "";
  const modelSelection = useMemo(
    () => fixedReadingSelection(models),
    [models],
  );

  useEffect(() => {
    if (!libraryReady || !effectiveScopeKey) return;
    setLibrary((previous) => {
      const ids = normalizeConversations(previous)[effectiveScopeKey]?.paperIds ?? [];
      if (previous.lastScopeKey === effectiveScopeKey && (ids.length !== 1 || previous.lastConversationByPaper?.[ids[0]] === effectiveScopeKey)) return previous;
      return { ...previous, lastScopeKey: effectiveScopeKey, lastConversationByPaper: ids.length === 1 ? { ...previous.lastConversationByPaper, [ids[0]]: effectiveScopeKey } : previous.lastConversationByPaper };
    });
  }, [effectiveScopeKey, libraryReady, setLibrary]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem("paper-ocean-theme", theme);
    } catch {
      // Theme still applies for the current session when storage is unavailable.
    }
    window.paperOcean.setTheme(theme).catch(() => undefined);
  }, [theme]);

  useEffect(() => () => {
    if (themeTransitionTimerRef.current !== undefined) {
      window.clearTimeout(themeTransitionTimerRef.current);
    }
  }, []);

  const loadModels = useCallback(() => {
    setModels([]);
    setModelError(null);
    window.paperOcean.codex.models()
      .then(setModels)
      .catch((reason) => {
        setModels([]);
        setModelError("暂时无法连接 GPT-5.6 Luna，请检查 Codex 网络与模型支持情况。");
      });
  }, []);

  const updatePaper = (paperId: string, patch: Partial<PaperRecord>) => {
    setLibrary((previous) => ({
      ...previous,
      papers: previous.papers.map((paper) => (
        paper.id === paperId ? { ...paper, ...patch } : paper
      )),
    }));
    setOpenedPapers((previous) => (
      previous[paperId]
        ? { ...previous, [paperId]: { ...previous[paperId], ...patch } }
        : previous
    ));
  };

  const activatePaper = (opened: OpenedPaper) => {
    setDestination(undefined);
    if (opened.cachedPages) setPagesByPaper((previous) => ({ ...previous, [opened.id]: opened.cachedPages! }));
    const existing = library.papers.find((paper) => paper.id === opened.id);
    const merged = mergePaper(existing, { ...recordFromOpened(opened), openedAt: Date.now() });
    const runtime = { ...opened, ...merged };
    setOpenedPapers((previous) => ({ ...previous, [merged.id]: runtime }));
    setActivePaperId(merged.id);
    setCurrentPage(merged.lastPage ?? 1);
    setSelection(null);
    setChatScopeKey(preferredPaperConversation(merged.id));
    setError(null);
    setLibrary((previous) => {
      const freshExisting = previous.papers.find((paper) => paper.id === opened.id);
      const freshMerged = mergePaper(freshExisting, { ...recordFromOpened(opened), openedAt: Date.now() });
      const without = previous.papers.filter((paper) => paper.id !== freshMerged.id);
      return {
        ...previous,
        papers: [freshMerged, ...without],
        openPaperIds: previous.openPaperIds.includes(freshMerged.id)
          ? previous.openPaperIds
          : [...previous.openPaperIds, freshMerged.id],
        messagesByScope: {
          ...previous.messagesByScope,
          [paperScope(freshMerged.id)]: previous.messagesByScope[paperScope(freshMerged.id)] ?? [],
        },
        lastPaperId: freshMerged.id,
      };
    });
  };

  const selectOpenPaper = (paperId: string, syncChat = true) => {
    setDestination(undefined);
    const paper = openedPapers[paperId];
    const record = library.papers.find((item) => item.id === paperId);
    if (!paper || !record) return;
    setActivePaperId(paperId);
    setCurrentPage(record.lastPage ?? 1);
    setSelection(null);
    if (syncChat && !isMultiScope) setChatScopeKey(preferredPaperConversation(paperId));
    setLibrary((previous) => ({ ...previous, lastPaperId: paperId, papers: previous.papers.map((item) => item.id === paperId ? { ...item, openedAt: Date.now(), readingStatus: item.readingStatus === "done" ? "done" : "reading" } : item) }));
  };

  const closePaper = (paperId: string) => {
    const currentIds = library.openPaperIds.filter((id) => openedPapers[id]);
    const closingIndex = currentIds.indexOf(paperId);
    const remaining = currentIds.filter((id) => id !== paperId);
    const nextId = remaining[Math.min(Math.max(closingIndex, 0), Math.max(remaining.length - 1, 0))];

    setOpenedPapers((previous) => {
      const next = { ...previous };
      delete next[paperId];
      return next;
    });
    setPagesByPaper((previous) => {
      const next = { ...previous };
      delete next[paperId];
      return next;
    });
    setLibrary((previous) => ({
      ...previous,
      openPaperIds: previous.openPaperIds.filter((id) => id !== paperId),
      lastPaperId: previous.lastPaperId === paperId ? nextId : previous.lastPaperId,
    }));

    if (activePaperId === paperId) {
      setActivePaperId(nextId);
      const nextRecord = library.papers.find((paper) => paper.id === nextId);
      setCurrentPage(nextRecord?.lastPage ?? 1);
      setSelection(null);
    }
    if (activeConversation?.paperIds.length === 1 && activeConversation.paperIds[0] === paperId) {
      setChatScopeKey(nextId ? preferredPaperConversation(nextId) : effectiveScopeKey);
    }
  };

  const loadReadingLibrary = useCallback(async (recover = false) => {
    setLoadingLibrary(true);
    setLibraryError(null);
    try {
      const savedLibrary = await (recover ? window.paperOcean.library.recover() : window.paperOcean.library.load());
      const requestedIds = savedLibrary.openPaperIds.length
        ? savedLibrary.openPaperIds
        : [savedLibrary.lastPaperId].filter((id): id is string => Boolean(id));
      const results = await Promise.allSettled(requestedIds.map(async (paperId) => {
        const record = savedLibrary.papers.find((paper) => paper.id === paperId);
        if (!record?.path) throw new Error("论文路径不存在");
        const reopened = await window.paperOcean.reopenPdf(record.path, record.id);
        if (reopened.id !== record.id) throw new Error("原文件内容已变化，请重新导入以保护已有引用与对话。");
        return { id: paperId, paper: restoredPaper(reopened, record) };
      }));
      const runtime: Record<string, OpenedPaper> = {};
      for (const result of results) {
        if (result.status === "fulfilled") runtime[result.value.id] = result.value.paper;
      }
      const validIds = requestedIds.filter((id) => runtime[id]);
      const initialId = validIds.includes(savedLibrary.lastPaperId ?? "")
        ? savedLibrary.lastPaperId
        : validIds[0];
      const initialRecord = savedLibrary.papers.find((paper) => paper.id === initialId);

      setOpenedPapers(runtime);
      setPagesByPaper(Object.fromEntries(Object.values(runtime).filter((paper) => paper.cachedPages).map((paper) => [paper.id, paper.cachedPages!])));
      initializeLibrary(savedLibrary);
      const migratedPapers = savedLibrary.papers.map((paper) => runtime[paper.id] ? recordFromOpened(runtime[paper.id]) : paper);
      if (migratedPapers.some((paper, index) => paper.path !== savedLibrary.papers[index].path || paper.managedOriginal !== savedLibrary.papers[index].managedOriginal)) setLibrary({ ...savedLibrary, papers: migratedPapers });
      setActivePaperId(initialId);
      setCurrentPage(initialRecord?.lastPage ?? 1);
      const savedScope = savedLibrary.lastScopeKey;
      setChatScopeKey(savedScope && normalizeConversations(savedLibrary)[savedScope] ? savedScope : initialId ? paperScope(initialId) : "");
      if (results.some((result) => result.status === "rejected")) {
        setError("部分论文原文件暂时无法打开，阅读记录已保留。请在资料库中重新定位相同版本的 PDF。");
      } else if (recover) {
        setNotice("已恢复最近备份。恢复前的资料库已另存保留。");
      }
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingLibrary(false);
    }
  }, [initializeLibrary, setLibrary]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void loadReadingLibrary();
    // Reading local files must not wait for CLI discovery or authentication.
    window.paperOcean.codex.status().then((nextAccount) => {
      setAccount(nextAccount);
      if (nextAccount.connected) {
        window.paperOcean.codex.rateLimits().then(setRateLimits).catch(() => undefined);
        loadModels();
      }
    }).catch((reason) => setAccount({ connected: false, accountType: null, planType: null,
      error: reason instanceof Error ? reason.message : String(reason) }));
  }, [loadModels, loadReadingLibrary]);

  useEffect(() => {
    const updateAssistant = (
      scopeKey: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      setLibrary((previous) => ({
        ...previous,
        messagesByScope: {
          ...previous.messagesByScope,
          [scopeKey]: (previous.messagesByScope[scopeKey] ?? []).map((message) => (
            message.id === messageId ? updater(message) : message
          )),
        },
      }));
    };

    const flushDelta = () => {
      if (deltaTimerRef.current !== undefined) {
        window.clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = undefined;
      }
      const buffered = deltaBufferRef.current;
      deltaBufferRef.current = null;
      if (!buffered?.text) return;
      updateAssistant(buffered.scopeKey, buffered.messageId, (message) => ({
        ...message,
        text: buffered.text,
        firstTextAt: message.firstTextAt ?? Date.now(),
        responsePhase: "正在输出",
      }));
    };

    const queueText = (scopeKey: string, messageId: string, text: string) => {
      const buffered = deltaBufferRef.current;
      if (buffered && (buffered.scopeKey !== scopeKey || buffered.messageId !== messageId)) flushDelta();
      deltaBufferRef.current = { scopeKey, messageId, text };
      if (deltaTimerRef.current === undefined) {
        deltaTimerRef.current = window.setTimeout(() => {
          deltaTimerRef.current = undefined;
          flushDelta();
        }, 50);
      }
    };

    const listener = (event: CodexEvent) => {
      const active = activeTurnRef.current;
      const params = event.params as Record<string, any> | undefined;

      if (event.method === "account/updated" || event.method === "account/login/completed") {
        window.paperOcean.codex.status().then((nextAccount) => {
          setAccount(nextAccount);
          if (nextAccount.connected) {
            window.paperOcean.codex.rateLimits().then(setRateLimits).catch(() => undefined);
            loadModels();
          }
        });
      }

      if (event.method === "paperOcean/serverExited") {
        if (!active) return;
        flushDelta();
        const message = typeof params?.message === "string"
          ? params.message
          : "Codex 服务意外退出，请重新发送问题。";
        updateAssistant(active.scopeKey, active.assistantMessageId, (item) => ({
          ...item,
          text: item.text || message,
          pending: false,
          error: true,
        }));
        setError(message);
        cancelRequestedRef.current = false;
        activeTurnRef.current = null;
        setBusy(false);
        return;
      }

      if (!active) return;
      const eventThreadId = params?.threadId ?? params?.turn?.threadId;
      const eventTurnId = params?.turnId ?? params?.turn?.id;
      if (eventThreadId && eventThreadId !== active.threadId) return;
      if (active.turnId && eventTurnId && eventTurnId !== active.turnId) return;

      const streamedText = answerStreamRef.current.consume(event.method, params ?? {});
      if (streamedText) queueText(active.scopeKey, active.assistantMessageId, streamedText);
      if (event.method === "item/started" && params?.item?.type === "reasoning") {
        updateAssistant(active.scopeKey, active.assistantMessageId, message => ({ ...message, responsePhase: "思考中" }));
      }

      if (event.method === "error") {
        if (params?.willRetry === true) {
          updateAssistant(active.scopeKey, active.assistantMessageId, message => ({ ...message, responsePhase: "连接波动，正在重试" }));
          return;
        }
        flushDelta();
        const message = params?.error?.message ?? "Codex 回答失败";
        updateAssistant(active.scopeKey, active.assistantMessageId, (item) => ({
          ...item,
          text: item.text || message,
          pending: false,
          error: true,
        }));
        setError(message);
        cancelRequestedRef.current = false;
        activeTurnRef.current = null;
        setBusy(false);
      }

      if (event.method === "turn/completed") {
        flushDelta();
        const status = params?.turn?.status;
        const failure = params?.turn?.error?.message;
        updateAssistant(active.scopeKey, active.assistantMessageId, (message) => ({
          ...message,
          pending: false,
          error: status === "failed",
          interrupted: status === "interrupted",
          finishedAt: Date.now(),
          text: message.text || failure || (status === "interrupted" ? "回答已停止。" : "没有生成可显示的回答。"),
        }));
        if (failure) setError(failure);
        cancelRequestedRef.current = false;
        activeTurnRef.current = null;
        setBusy(false);
        window.paperOcean.codex.rateLimits().then(setRateLimits).catch(() => undefined);
      }
    };

    const unsubscribe = window.paperOcean.codex.onEvent(listener);
    const prepareForClose = (event: Event) => {
      if (!busyRef.current) return;
      cancelRequestedRef.current = true;
      const finishing = (async () => {
        const active = activeTurnRef.current;
        if (active?.turnId) await window.paperOcean.codex.interrupt({ threadId: active.threadId, turnId: active.turnId });
        const deadline = Date.now() + 10_000;
        while (busyRef.current) {
          if (Date.now() >= deadline) throw new Error("回答尚未停止，已保留窗口和现有内容。请稍后重试关闭。");
          await new Promise((resolve) => window.setTimeout(resolve, 25));
        }
        flushDelta();
      })();
      (event as CustomEvent<{ waitUntil(task: Promise<unknown>): void }>).detail.waitUntil(finishing);
    };
    window.addEventListener("paper-ocean-before-close", prepareForClose);
    window.addEventListener("paper-ocean-before-save", flushDelta);
    return () => {
      unsubscribe();
      window.removeEventListener("paper-ocean-before-close", prepareForClose);
      window.removeEventListener("paper-ocean-before-save", flushDelta);
      if (deltaTimerRef.current !== undefined) window.clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = undefined;
      deltaBufferRef.current = null;
    };
  }, [loadModels]);

  const openLocal = async () => {
    if (!libraryReady || loadingLibrary) return;
    setOpening(true);
    setError(null);
    try {
      const opened = await window.paperOcean.openPdf();
      if (opened) activatePaper(opened);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
    }
  };

  const openArxiv = async (value: string) => {
    if (!libraryReady || loadingLibrary) return false;
    const input = value.trim();
    if (!input) return false;
    setError(null);
    const opened = await download.start(input);
    if (opened) {
      activatePaper(opened);
    }
    return Boolean(opened);
  };

  const reopenLibraryPaper = async (paperId: string) => {
    if (openedPapers[paperId]) {
      selectOpenPaper(paperId);
      return true;
    }
    const record = library.papers.find((paper) => paper.id === paperId);
    if (!record) return false;
    setOpening(true);
    try {
      const opened = await window.paperOcean.reopenPdf(record.path, record.id);
      if (opened.id !== record.id) throw new Error("原文件内容已变化，请重新导入以保护已有对话。");
      activatePaper(restoredPaper(opened, record));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setOpening(false);
    }
  };

  const handleIndexed = async (paperId: string, {
    pages: indexedPages,
    inferredTitle,
    inferredAbstract,
    pageCount,
  }: {
    pages: PdfPageIndex[];
    inferredTitle?: string;
    inferredAbstract?: string;
    pageCount: number;
  }) => {
    const paper = openedPapers[paperId];
    if (!paper) return;
    setPagesByPaper((previous) => ({ ...previous, [paperId]: indexedPages }));
    const fileStem = paper.name.replace(/\.pdf$/i, "");
    const shouldUseInferredTitle = !paper.arxivId && (!paper.title || paper.title === fileStem);
    const nextRecord: PaperRecord = {
      ...recordFromOpened(paper),
      title: shouldUseInferredTitle && inferredTitle ? inferredTitle : paper.title,
      abstract: paper.abstract || inferredAbstract,
      pageCount,
    };

    try {
      const context = await window.paperOcean.saveContext({ paper: nextRecord, pages: indexedPages });
      updatePaper(paperId, { ...nextRecord, ...context });
    } catch (reason) {
      setError(`论文索引保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  const login = async () => {
    setError(null);
    try {
      const result = await window.paperOcean.codex.login();
      if (result.alreadyConnected) {
        const nextAccount = await window.paperOcean.codex.status();
        setAccount(nextAccount);
        if (nextAccount.connected) loadModels();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const chooseCodexExecutable = async () => {
    setError(null);
    try {
      const nextAccount = await window.paperOcean.codex.chooseExecutable();
      if (!nextAccount) return;
      setAccount(nextAccount);
      if (nextAccount.connected) loadModels();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const sendMessage = async (question: string) => {
    if (!scopeRecords.length || !effectiveScopeKey || busy) return;
    if (activeConversation?.readOnly || scopeRecords.length !== activeConversation?.paperIds.length) {
      setError("这段历史的论文集合无法完整确认，请新建讨论后提问；原有对话会保留。");
      return;
    }
    if (!account?.connected) {
      await login();
      setError("请完成浏览器中的 ChatGPT 登录，然后再次发送问题。");
      return;
    }
    if (!modelSelection) {
      setError("模型目录尚未就绪，请稍后重试或在右上角重新定位 Codex CLI。");
      return;
    }

    setBusy(true);
    cancelRequestedRef.current = false;
    setError(null);
    const messagePage = activePaperId && scopeRecords.some((paper) => paper.id === activePaperId)
      ? currentPage
      : undefined;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: question,
      page: messagePage,
      paperId: messagePage ? activePaperId : undefined,
      createdAt: Date.now(),
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      pending: true,
      responsePhase: "准备论文资料",
      serviceTier: library.readingPreferencesByScope?.[effectiveScopeKey]?.speed === "standard" ? null : modelSelection.serviceTier ?? null,
    };
    setLibrary((previous) => ({
      ...previous,
      conversations: { ...normalizeConversations(previous), [effectiveScopeKey]: { ...activeConversation, updatedAt: Date.now() } },
      draftsByScope: { ...previous.draftsByScope, [effectiveScopeKey]: previous.draftsByScope?.[effectiveScopeKey]?.trim() === question.trim() ? "" : previous.draftsByScope?.[effectiveScopeKey] ?? "" },
      messagesByScope: {
        ...previous.messagesByScope,
        [effectiveScopeKey]: [
          ...(previous.messagesByScope[effectiveScopeKey] ?? []),
          userMessage,
          assistantMessage,
        ],
      },
    }));

    const throwIfCancelled = () => {
      if (cancelRequestedRef.current) throw new CancelledTurnError();
    };
    const setPhase = (responsePhase: string, extra: Partial<ChatMessage> = {}) => setLibrary(previous => ({
      ...previous, messagesByScope: { ...previous.messagesByScope, [effectiveScopeKey]: (previous.messagesByScope[effectiveScopeKey] ?? []).map(message => message.id === assistantMessage.id ? { ...message, responsePhase, ...extra } : message) },
    }));

    try {
      const preparedRecords: PaperRecord[] = [];
      for (const record of scopeRecords) {
        throwIfCancelled();
        if (record.paperDir) {
          preparedRecords.push(record);
          continue;
        }
        const indexedPages = pagesByPaper[record.id] ?? [];
        if (!indexedPages.length) {
          throw new Error(`《${record.title}》仍在建立全文索引，请等待左侧“索引 100%”后再提问`);
        }
        const saved = await window.paperOcean.saveContext({ paper: record, pages: indexedPages });
        throwIfCancelled();
        updatePaper(record.id, saved);
        preparedRecords.push({ ...record, ...saved });
      }

      await flushLibrary();
      throwIfCancelled();
      const conversation = await window.paperOcean.prepareConversation({
        scopeKey: effectiveScopeKey,
        papers: preparedRecords,
        question,
        currentPaperId: activePaperId,
        currentPage: messagePage,
      });
      throwIfCancelled();
      if (conversation.coverage) setLibrary((previous) => ({
        ...previous, messagesByScope: { ...previous.messagesByScope, [effectiveScopeKey]: (previous.messagesByScope[effectiveScopeKey] ?? []).map((item) => item.id === assistantMessage.id ? { ...item, contextCoverage: conversation.coverage } : item) },
      }));

      let threadId: string | undefined = library.threadsByScope[effectiveScopeKey];
      setPhase("连接会话");
      if (threadId) {
        try {
          threadId = await window.paperOcean.codex.resumeThread({
            threadId,
            contextDir: conversation.contextDir,
          });
          throwIfCancelled();
        } catch (reason) {
          if (reason instanceof CancelledTurnError) throw reason;
          throw new Error(`暂时无法恢复这次讨论，历史已保留。请重试；没有创建新对话。${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
      if (!threadId) {
        const title = isMultiScope
          ? `Paper Ocean · ${preparedRecords.length} 篇论文`
          : preparedRecords[0].title;
        threadId = await window.paperOcean.codex.startThread({
          contextDir: conversation.contextDir,
          title,
          model: modelSelection.model,
          serviceTier: assistantMessage.serviceTier,
        });
        throwIfCancelled();
        const nextThreadId = threadId;
        setLibrary((previous) => ({
          ...previous,
          threadsByScope: { ...previous.threadsByScope, [effectiveScopeKey]: nextThreadId },
        }));
      }

      const pageImages: Array<{ path: string; paperId: string; page: number }> = [];
      setPhase("准备页图证据");
      const evidencePaper = preparedRecords.find((paper) => paper.id === activePaperId) ?? (preparedRecords.length === 1 ? preparedRecords[0] : undefined);
      if (evidencePaper) {
        const requestedPages = [...question.matchAll(/(?:第\s*)?([1-9]\d*)\s*页|\bpage\s+([1-9]\d*)/giu)].map((match) => Number(match[1] ?? match[2]));
        const selectedPage = selection?.paperId === evidencePaper.id ? selection.page : undefined;
        const defaultPage = evidencePaper.id === activePaperId ? currentPage : evidencePaper.lastPage ?? 1;
        const targets = [...new Set([...requestedPages, selectedPage ?? defaultPage])].filter((page) => page > 0 && page <= (evidencePaper.pageCount ?? 10_000)).slice(0,3);
        let source = openedPapers[evidencePaper.id];
        for (const page of targets) {
          throwIfCancelled();
          try {
            let imagePath = await window.paperOcean.cachedPageImage(evidencePaper.id, page);
            if (!imagePath) {
              source ??= await window.paperOcean.reopenPdf(evidencePaper.path, evidencePaper.id);
              if (source.id !== evidencePaper.id) throw new Error("原文版本已变化");
              const { renderEvidencePage } = await import("./pdf-evidence");
              const dataUrl = await renderEvidencePage(source, page);
              throwIfCancelled();
              imagePath = await window.paperOcean.savePageImage({ paperId: evidencePaper.id, page, dataUrl });
            }
            pageImages.push({ path: imagePath, paperId: evidencePaper.id, page });
          } catch (reason) { if (reason instanceof CancelledTurnError) throw reason; }
        }
      }
      setLibrary((previous) => ({ ...previous, messagesByScope: { ...previous.messagesByScope, [effectiveScopeKey]: (previous.messagesByScope[effectiveScopeKey] ?? []).map((item) => item.id === assistantMessage.id ? { ...item, pageImages: pageImages.map(({ paperId, page }) => ({ paperId, page })) } : item) } }));

      const prompt = buildPaperTurnPrompt({
        mode: isMultiScope ? "all" : "single",
        characterCount: conversation.characterCount,
        papers: preparedRecords.map((paper) => ({
          id: paper.id,
          title: paper.title,
          pageCount: paper.pageCount,
        })),
        currentPaperTitle: activeRecord && messagePage ? activeRecord.title : undefined,
        currentPage: activeRecord && messagePage ? currentPage : undefined,
        hasSelection: Boolean(selectedText),
        question,
        coverage: conversation.coverage,
        pageImages,
        answerDepth: library.readingPreferencesByScope?.[effectiveScopeKey]?.depth,
      });

      activeTurnRef.current = {
        threadId,
        scopeKey: effectiveScopeKey,
        assistantMessageId: assistantMessage.id,
      };
      answerStreamRef.current = createAnswerStream();
      throwIfCancelled();
      setPhase("等待模型响应", { sentAt: Date.now() });
      const result = await window.paperOcean.codex.sendTurn({
        threadId,
        contextDir: conversation.contextDir,
        entries: conversation.entries,
        prompt,
        selectedText: selectedText || undefined,
        pageImages,
        model: modelSelection.model,
        effort: modelSelection.effort,
        serviceTier: assistantMessage.serviceTier,
      });
      if (activeTurnRef.current) {
        activeTurnRef.current.turnId = result.turnId;
        setLibrary(previous => ({ ...previous, messagesByScope: { ...previous.messagesByScope, [effectiveScopeKey]: (previous.messagesByScope[effectiveScopeKey] ?? []).map(message => message.id === assistantMessage.id ? { ...message, serviceTier: result.serviceTier ?? null } : message) } }));
        if (cancelRequestedRef.current) {
          await window.paperOcean.codex.interrupt({ threadId, turnId: result.turnId });
        }
      }
      setSelection(null);
    } catch (reason) {
      const cancelled = reason instanceof CancelledTurnError;
      const message = cancelled
        ? "回答已停止。"
        : reason instanceof Error ? reason.message : String(reason);
      setLibrary((previous) => ({
        ...previous,
        messagesByScope: {
          ...previous.messagesByScope,
          [effectiveScopeKey]: (previous.messagesByScope[effectiveScopeKey] ?? []).map((item) => (
            item.id === assistantMessage.id
              ? { ...item, text: message, pending: false, error: !cancelled }
              : item
          )),
        },
      }));
      if (!cancelled) setError(message);
      cancelRequestedRef.current = false;
      activeTurnRef.current = null;
      setBusy(false);
    }
  };

  const stopAnswer = async () => {
    if (!busy || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    const active = activeTurnRef.current;
    if (!active?.turnId) return;
    try {
      await window.paperOcean.codex.interrupt({ threadId: active.threadId, turnId: active.turnId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const createConversation = (paperIds = activeConversation?.paperIds.length ? activeConversation.paperIds : openRecords.map((paper) => paper.id)) => {
    if (!paperIds.length || busy) return;
    const id = `conversation:${crypto.randomUUID()}`;
    const now = Date.now();
    const title = paperIds.length > 1 ? `${paperIds.length} 篇论文的新讨论` : `${library.papers.find((paper) => paper.id === paperIds[0])?.title ?? "论文"} · 新讨论`;
    setLibrary((previous) => ({
      ...previous,
      conversations: { ...normalizeConversations(previous), [id]: { id, title, paperIds: [...paperIds], createdAt: now, updatedAt: now } },
      messagesByScope: { ...previous.messagesByScope, [id]: [] },
      aiSettingsByScope: modelSelection ? { ...previous.aiSettingsByScope, [id]: modelSelection } : previous.aiSettingsByScope,
      readingPreferencesByScope: previous.readingPreferencesByScope?.[effectiveScopeKey] ? { ...previous.readingPreferencesByScope, [id]: previous.readingPreferencesByScope[effectiveScopeKey] } : previous.readingPreferencesByScope,
    }));
    setChatScopeKey(id);
  };

  const changeChatScope = (scopeKey: string) => {
    if (scopeKey === "all") {
      const ids = openRecords.map((paper) => paper.id);
      const matching = Object.values(conversations).filter((item) => !item.readOnly && samePaperSet(item.paperIds, ids)).sort((a,b) => b.updatedAt - a.updatedAt)[0];
      if (matching) setChatScopeKey(matching.id);
      else createConversation(ids);
    } else setChatScopeKey(scopeKey.startsWith("paper:") ? preferredPaperConversation(scopeKey.slice(6)) : scopeKey);
  };

  const changePage = (page: number) => {
    setCurrentPage(page);
    if (activePaperId) setOpenedPapers((previous) => {
      const paper = previous[activePaperId];
      return !paper || paper.lastPage === page ? previous : { ...previous, [activePaperId]: { ...paper, lastPage: page } };
    });
    if (activePaperId) setLibrary((previous) => {
      if (previous.papers.find((paper) => paper.id === activePaperId)?.lastPage === page) return previous;
      return { ...previous, papers: previous.papers.map((paper) => paper.id === activePaperId ? { ...paper, lastPage: page } : paper) };
    });
    if (selection && selection.paperId === activePaperId && selection.page !== page) setSelection(null);
  };

  const saveReadingPosition = useCallback((paperId: string, position: ReadingPosition) => {
    setLibrary((previous) => {
      const saved = previous.papers.find((paper) => paper.id === paperId)?.readingPosition;
      if (saved && saved.page === position.page && Math.abs(saved.x - position.x) < 0.001 && Math.abs(saved.y - position.y) < 0.001 && saved.zoom === position.zoom && saved.fitWidth === position.fitWidth) return previous;
      return { ...previous, papers: previous.papers.map((paper) => paper.id === paperId ? { ...paper, readingPosition: position } : paper) };
    });
  }, [setLibrary]);

  const visitEvidence = async (paperId: string, position: ReadingPosition, remember = true) => {
    const record = library.papers.find((paper) => paper.id === paperId);
    if (!record || position.page < 1 || (record.pageCount && position.page > record.pageCount)) {
      setError("这条引用对应的论文或页码不在资料库中，请核对原文。");
      return;
    }
    try {
      if (!openedPapers[paperId]) {
        const opened = await window.paperOcean.reopenPdf(record.path, record.id);
        if (opened.id !== paperId) throw new Error("原文件已变化，无法确认引用指向的论文。请重新导入。");
        setOpenedPapers((previous) => ({ ...previous, [paperId]: restoredPaper(opened, record) }));
        updatePaper(paperId, { path: opened.path, originalPath: record.originalPath || opened.originalPath, managedOriginal: opened.managedOriginal });
      }
      const origin = readerRef.current?.capturePosition();
      if (remember && activePaperId && origin) setEvidenceHistory((previous) => [...previous.slice(-19), { paperId: activePaperId, position: origin }]);
      setActivePaperId(paperId);
      setCurrentPage(position.page);
      setSelection(null);
      setDestination({ paperId, position, requestId: Date.now() });
      setLibrary((previous) => ({ ...previous, lastPaperId: paperId, openPaperIds: previous.openPaperIds.includes(paperId) ? previous.openPaperIds : [...previous.openPaperIds, paperId] }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const openEvidence = (paperId: string, page: number) => {
    void visitEvidence(paperId, { page, y: 0, x: 0.5, zoom: activeRecord?.readingPosition?.zoom ?? 1.15, fitWidth: activeRecord?.readingPosition?.fitWidth ?? true });
  };

  const toggleTheme = () => {
    document.documentElement.classList.add("theme-transitioning");
    if (themeTransitionTimerRef.current !== undefined) {
      window.clearTimeout(themeTransitionTimerRef.current);
    }
    setTheme((current) => current === "dark" ? "light" : "dark");
    themeTransitionTimerRef.current = window.setTimeout(() => {
      document.documentElement.classList.remove("theme-transitioning");
      themeTransitionTimerRef.current = undefined;
    }, 320);
  };

  const selectionAnchor: EvidenceAnchor | undefined = selection ? { id: selection.id, paperId: selection.paperId, page: selection.page, quote: selection.text, rects: selection.rects } : undefined;
  const showNotes = () => { setSidePanel("notes"); setDiscussionRequest((value) => value + 1); };
  const createNote = (body = "", anchors: EvidenceAnchor[] = [], sourceMessage?: ResearchNote["sourceMessage"]) => {
    const now = Date.now();
    const note: ResearchNote = { id: crypto.randomUUID(), title: sourceMessage ? "回答笔记" : "", body, anchors, sourceMessage, createdAt: now, updatedAt: now };
    setLibrary((previous) => ({ ...previous, notes: [note, ...previous.notes ?? []] }));
    setSelectedNoteId(note.id);
    showNotes();
  };
  const saveHighlight = () => {
    if (!selectionAnchor) return;
    setLibrary((previous) => ({ ...previous, highlights: previous.highlights?.some((item) => item.id === selectionAnchor.id) ? previous.highlights : [...previous.highlights ?? [], { ...selectionAnchor, color: "yellow", createdAt: Date.now() }] }));
  };
  const saveAnswerNote = (message: ChatMessage) => {
    const anchors: EvidenceAnchor[] = [];
    const append = (paperId: string, page: number) => {
      const record = library.papers.find((paper) => paper.id === paperId);
      if (!record || !activeConversation?.paperIds.includes(paperId) || page < 1 || !record.pageCount || page > record.pageCount || anchors.some((item) => item.paperId === paperId && item.page === page)) return;
      anchors.push({ id: crypto.randomUUID(), paperId, page, quote: "", rects: [] });
    };
    for (const match of message.text.matchAll(/\]\(#paper=([a-f0-9]{24})&page=([1-9]\d{0,3})\)/g)) append(match[1], Number(match[2]));
    createNote(message.text, anchors, { scopeKey: effectiveScopeKey, messageId: message.id });
  };
  const openNoteAnchor = (anchor: EvidenceAnchor) => {
    void visitEvidence(anchor.paperId, { page: anchor.page, y: anchor.rects[0]?.y ?? 0, x: 0.5, zoom: activeRecord?.readingPosition?.zoom ?? 1.15, fitWidth: activeRecord?.readingPosition?.fitWidth ?? true });
  };
  const exportNote = async (note: ResearchNote, images: boolean) => {
    try {
      await flushLibrary();
      const { noteMarkdown, evidenceImageName } = await import("./note-export.mjs");
      let blob: Blob;
      if (images) {
        const { strToU8, zipSync } = await import("fflate");
        const { renderEvidencePage } = await import("./pdf-evidence");
        const files: Record<string, Uint8Array> = { "note.md": strToU8(noteMarkdown(note, library.papers, true)), "evidence.json": strToU8(JSON.stringify({ version: 1, note }, null, 2)) };
        const originals = new Map<string, OpenedPaper>();
        let size = 0;
        for (const anchor of note.anchors) {
          const name = evidenceImageName(anchor);
          if (files[name]) continue;
          const record = library.papers.find((paper) => paper.id === anchor.paperId);
          if (!record) throw new Error("笔记所引论文缺失，无法导出完整页图。可先导出 Markdown。");
          let opened = originals.get(record.id) ?? openedPapers[record.id];
          if (!opened) opened = await window.paperOcean.reopenPdf(record.path, record.id);
          if (opened.id !== record.id) throw new Error("原文件已变化，页图导出已停止。请重新定位对应版本的原文。");
          originals.set(record.id, opened);
          const dataUrl = await renderEvidencePage(opened, anchor.page);
          files[name] = Uint8Array.from(atob(dataUrl.split(",")[1]), (character) => character.charCodeAt(0));
          size += files[name].byteLength;
          if (size > 128 * 1024 * 1024) throw new Error("本条笔记页图超过 128 MB，请拆分笔记后导出，或仅导出 Markdown。");
        }
        blob = new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: "application/zip" });
      } else blob = new Blob([noteMarkdown(note, library.papers)], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(note.title || "研究笔记").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)}.${images ? "zip" : "md"}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(images ? "已发起笔记与原文页图下载。" : "已发起 Markdown 下载。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return (
    <main className="app-shell">
      {showLibrary && <LibraryPanel papers={library.papers} opening={opening} onClose={() => setShowLibrary(false)} onOpen={reopenLibraryPaper} onStatus={(id, readingStatus) => updatePaper(id, { readingStatus })} onRelink={async (record) => {
        const opened = await window.paperOcean.openPdf(record.id);
        if (!opened) return false;
        if (opened.id !== record.id) throw new Error("所选 PDF 与原论文内容不一致，未变更已有记录。");
        const restored = restoredPaper(opened, record);
        updatePaper(record.id, recordFromOpened(restored));
        if (opened.cachedPages) setPagesByPaper((previous) => ({ ...previous, [record.id]: opened.cachedPages! }));
        await flushLibrary();
        return true;
      }} />}
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src={paperOceanMark} alt="" aria-hidden="true" />
          <div>
            <strong>Paper Ocean</strong>
            <span>RESEARCH WORKSPACE</span>
          </div>
        </div>

        <PaperSearch papers={library.papers} disabled={opening || download.busy || !libraryReady || loadingLibrary} onOpenArxiv={openArxiv} onOpenLocal={reopenLibraryPaper} onError={setError} />

        <div className="header-actions">
          <button type="button" className="settings-button" aria-label="打开资料库" onClick={() => setShowLibrary(true)} disabled={!libraryReady}><Library size={17} aria-hidden="true" /></button>
          <button type="button" className="settings-button settings-button--text" onClick={showNotes} disabled={!libraryReady}>笔记</button>
          <AboutPanel />
          <button
            type="button"
            className="settings-button theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          >
            {theme === "dark"
              ? <Sun className="theme-toggle__icon" size={17} aria-hidden="true" />
              : <Moon className="theme-toggle__icon" size={17} aria-hidden="true" />}
          </button>
          {library.papers.some((paper) => !openedPapers[paper.id]) && (
            <label className="recent-library" title="最近阅读">
              <Library size={16} aria-hidden="true" />
              <select
                aria-label="最近阅读"
                value=""
                onChange={(event) => reopenLibraryPaper(event.target.value)}
              >
                <option value="" disabled>最近阅读</option>
                {library.papers.filter((paper) => !openedPapers[paper.id]).slice(0, 20).map((paper) => (
                  <option value={paper.id} key={paper.id}>{paper.title}</option>
                ))}
              </select>
            </label>
          )}
          <button className="open-button" onClick={openLocal} disabled={opening || !libraryReady || loadingLibrary}>
            <Plus size={17} aria-hidden="true" />
            {opening ? "正在打开…" : "本地 PDF"}
          </button>
          {window.paperOcean.runtime !== "web" && (
            <button
              type="button"
              className="settings-button"
              onClick={chooseCodexExecutable}
              disabled={busy}
              aria-label="定位 Codex CLI"
              title={busy ? "回答完成后可重新定位 Codex CLI" : "定位 Codex CLI"}
            >
              <Settings size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {download.progress && <DownloadStatus progress={download.progress} busy={download.busy} onCancel={() => void download.cancel()} onResume={() => void openArxiv(download.progress!.reference || download.progress!.source)} onDismiss={download.dismiss} />}

      <div className="paper-titlebar">
        <div className="paper-titlebar__title">
          <FileText size={15} className="document-icon" aria-hidden="true" />
          {activeRecord ? (
            <input
              value={activeRecord.title}
              onChange={(event) => updatePaper(activeRecord.id, { title: event.target.value })}
              aria-label="论文标题"
            />
          ) : <span>尚未打开论文</span>}
        </div>
        {activeRecord && (
          <div className="paper-titlebar__meta">
            {activeRecord.arxivId && <span>arXiv {activeRecord.arxivId}</span>}
            {activeRecord.pageCount && <span>{activeRecord.pageCount} 页</span>}
            <span className={activeRecord.paperDir ? "index-ready" : ""}>
              {activeRecord.paperDir ? "全文索引就绪" : "正在索引全文"}
            </span>
          </div>
        )}
      </div>

      {notice && <div className="global-error global-notice" role="status"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}
      {libraryError && (
        <div className="global-error library-error" role="alert">
          <span>{libraryError}</span>
          <button type="button" disabled={loadingLibrary} onClick={() => void loadReadingLibrary()}>重新读取</button>
          <button type="button" disabled={loadingLibrary} onClick={() => void loadReadingLibrary(true)}>恢复最近备份</button>
        </div>
      )}
      {libraryReady && saveState.status !== "saved" && (
        <div className={`save-status${saveState.status === "error" ? " save-status--error" : ""}`} role={saveState.status === "error" ? "alert" : "status"}>
          <span>{saveState.status === "error" ? `尚未保存：${saveState.error}` : "正在保存阅读记录…"}</span>
          {saveState.status === "error" && <button type="button" onClick={() => void flushLibrary().catch(() => undefined)}>重试保存</button>}
          {saveState.status === "error" && <button type="button" onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = `paper-ocean-unsaved-${Date.now()}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}>导出未保存副本</button>}
        </div>
      )}
      {error && (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={16} /></button>
        </div>
      )}

      <ResizableWorkspace
        discussionRequest={discussionRequest}
        reader={<>
          {!!evidenceHistory.length && <button type="button" className="return-to-reading" onClick={() => {
            const target = evidenceHistory.at(-1)!;
            void visitEvidence(target.paperId, target.position, false);
            setEvidenceHistory((previous) => previous.slice(0, -1));
          }}>← 返回引用前的阅读位置</button>}
          <PaperTabs
            papers={openRecords}
            activePaperId={activePaperId}
            onActivate={(paperId) => selectOpenPaper(paperId)}
            onClose={closePaper}
          />
          <div className="reader-body">
            <PdfReader
              ref={readerRef}
              paper={activePaper}
              highlights={(library.highlights ?? []).filter((item) => item.paperId === activePaperId)}
              cachedPages={pages}
              currentPage={currentPage}
              readingPosition={activeRecord?.readingPosition}
              destination={destination}
              onPositionChange={saveReadingPosition}
              onPageChange={changePage}
              onIndexed={(input) => activePaperId && handleIndexed(activePaperId, input)}
              onSelection={(text, page, rects) => {
                if (!activePaperId) return;
                if (!text) { setSelection(null); setNotice("请在同一页内选择文字；可向笔记逐次添加多页证据。"); return; }
                changePage(page);
                setSelection({ id: crypto.randomUUID(), paperId: activePaperId, page, text, rects });
              }}
            />
          </div>
          {selectionAnchor && <div className="selection-actions"><span title={selectionAnchor.quote}>第 {selectionAnchor.page} 页 · {selectionAnchor.quote}</span><button type="button" disabled={library.highlights?.some((item) => item.id === selectionAnchor.id)} onClick={saveHighlight}>保存高亮</button><button type="button" onClick={() => createNote("", [selectionAnchor])}>记笔记</button><button type="button" aria-label="清除选文" onClick={() => setSelection(null)}>×</button></div>}
        </>}
        chat={
          <div className="discussion-notes">
          <nav className="discussion-notes__tabs" aria-label="讨论与笔记"><button type="button" aria-pressed={sidePanel === "chat"} onClick={() => setSidePanel("chat")}>AI 讨论</button><button type="button" aria-pressed={sidePanel === "notes"} onClick={showNotes}>研究笔记</button></nav>
          <div className="discussion-notes__body" hidden={sidePanel !== "chat"}>
          <ChatPanel
            key={`${effectiveScopeKey}:${sourceJump}`}
            activePaper={activeRecord}
            openPapers={openRecords}
            scopeKey={effectiveScopeKey}
            conversation={activeConversation}
            conversations={Object.values(conversations).sort((a,b) => b.updatedAt - a.updatedAt)}
            scopePapers={scopeRecords}
            onNewConversation={() => createConversation()}
            onRenameConversation={(title) => setLibrary((previous) => ({ ...previous, conversations: { ...normalizeConversations(previous), [effectiveScopeKey]: { ...activeConversation, title, updatedAt: Date.now() } } }))}
            preferences={library.readingPreferencesByScope?.[effectiveScopeKey]}
            onPreferencesChange={(preferences) => setLibrary((previous) => ({ ...previous, readingPreferencesByScope: { ...previous.readingPreferencesByScope, [effectiveScopeKey]: preferences } }))}
            account={account}
            rateLimits={rateLimits}
            messages={messages}
            draft={library.draftsByScope?.[effectiveScopeKey] ?? ""}
            position={library.chatPositions?.[effectiveScopeKey]}
            onDraftChange={(draft) => setLibrary((previous) => ({ ...previous, draftsByScope: { ...previous.draftsByScope, [effectiveScopeKey]: draft } }))}
            onPositionChange={(position) => setLibrary((previous) => ({ ...previous, chatPositions: { ...previous.chatPositions, [effectiveScopeKey]: position } }))}
            onOpenEvidence={openEvidence}
            onSaveNote={saveAnswerNote}
            selectedText={selectedText}
            currentPage={currentPage}
            busy={busy}
            error={null}
            modelSelection={modelSelection}
            modelError={modelError}
            onRetryModels={loadModels}
            onScopeChange={changeChatScope}
            onSelectConversation={setChatScopeKey}
            onLogin={login}
            onSend={sendMessage}
            onStop={stopAnswer}
          />
          </div>
          <div className="discussion-notes__body" hidden={sidePanel !== "notes"}>
            <NotesPanel notes={library.notes ?? []} highlights={library.highlights ?? []} papers={library.papers} selectedId={selectedNoteId} selection={selectionAnchor} onSelect={setSelectedNoteId} onNew={() => createNote()} onChange={(note) => setLibrary((previous) => ({ ...previous, notes: previous.notes?.map((item) => item.id === note.id ? { ...note, updatedAt: Date.now() } : item) }))} onHighlightChange={(highlight) => setLibrary((previous) => ({ ...previous, highlights: previous.highlights?.map((item) => item.id === highlight.id ? highlight : item) }))} onOpenAnchor={openNoteAnchor} onExport={exportNote} onOpenSource={(note) => {
              const source = note.sourceMessage;
              if (!source || !library.messagesByScope[source.scopeKey]?.some((item) => item.id === source.messageId)) { setError("原回答暂时不在资料库中，笔记正文仍保留。"); return; }
              setLibrary((previous) => ({ ...previous, chatPositions: { ...previous.chatPositions, [source.scopeKey]: { messageId: source.messageId, block: 0, offset: 0, followOutput: false } } }));
              setChatScopeKey(source.scopeKey); setSourceJump((value) => value + 1); setSidePanel("chat");
            }} />
          </div>
          </div>
        }
        recommendations={
          <RecommendationPanel paper={activeRecord} onOpenArxiv={openArxiv} />
        }
      />
    </main>
  );
}
