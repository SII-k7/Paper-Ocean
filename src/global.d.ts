import type {
  CodexAccount,
  CodexModel,
  ConversationContext,
  CodexEvent,
  LibraryState,
  OpenedPaper,
  PaperRecord,
  PdfPageIndex,
  RateLimitInfo,
  RecommendationResult,
  DownloadProgress,
  RecommendationPreview,
  PaperSearchResult,
  PaperArchiveStatus,
  PaperCategory,
} from "./types";

declare global {
  interface Window {
    paperOcean: {
      runtime?: "web" | "electron" | "demo";
      updates?: {
        status(): Promise<import("./types").AppUpdateState>;
        check(): Promise<import("./types").AppUpdateState>;
        apply(): Promise<import("./types").AppUpdateState>;
      };
      pool?: {
        status(): Promise<import("./types").PoolState>;
        sync(): Promise<import("./types").PoolState>;
        configure(input: { url: string; username: string; password?: string } | null): Promise<import("./types").PoolState>;
      };
      searchPapers(query: string): Promise<PaperSearchResult>;
      resolvePaperSuggestion(id: string): Promise<{ arxivId?: string; sourceUrl?: string }>;
      archive: {
        status(): Promise<PaperArchiveStatus>;
        retry(): Promise<PaperArchiveStatus>;
        setCategory(paperId: string, category: PaperCategory | "auto"): Promise<PaperArchiveStatus>;
        openFolder(): Promise<void>;
      };
      openPdf(expectedPaperId?: string): Promise<OpenedPaper | null>;
      reopenPdf(path: string, expectedPaperId?: string): Promise<OpenedPaper>;
      openUrl(url: string, requestId?: string): Promise<OpenedPaper>;
      downloadStatus(id: string): Promise<DownloadProgress | null>;
      cancelDownload(id: string): Promise<void>;
      openExternal(url: string): Promise<void>;
      setTheme(theme: "dark" | "light"): Promise<"dark" | "light">;
      saveContext(input: {
        paper: PaperRecord;
        pages: PdfPageIndex[];
      }): Promise<{ paperDir: string; contextPath: string }>;
      savePageImage(input: {
        paperId: string;
        page: number;
        dataUrl: string;
      }): Promise<string>;
      cachedPageImage(paperId: string, page: number): Promise<string | undefined>;
      prepareConversation(input: {
        scopeKey: string;
        papers: PaperRecord[];
        question?: string;
        currentPaperId?: string;
        currentPage?: number;
      }): Promise<ConversationContext>;
      codex: {
        status(): Promise<CodexAccount>;
        login(): Promise<{ authUrl?: string; alreadyConnected?: boolean }>;
        models(): Promise<CodexModel[]>;
        chooseExecutable(): Promise<CodexAccount | null>;
        rateLimits(): Promise<RateLimitInfo | null>;
        startThread(input: { contextDir: string; title: string; model?: CodexModel["id"] }): Promise<string>;
        resumeThread(input: { threadId: string; contextDir: string }): Promise<string>;
        sendTurn(input: {
          threadId: string;
          contextDir: string;
          entries: ConversationContext["entries"];
          prompt: string;
          selectedText?: string;
          pageImagePath?: string;
          pageImages?: Array<{ path: string; paperId: string; page: number }>;
          model?: CodexModel["id"];
          effort?: CodexModel["supportedEfforts"][number];
        }): Promise<{ turnId: string }>;
        interrupt(input: { threadId: string; turnId: string }): Promise<void>;
        onEvent(listener: (event: CodexEvent) => void): () => void;
      };
      recommendations(input: {
        title: string;
        abstract?: string;
        arxivId?: string;
        mode?: "recent" | "foundations";
        refresh?: boolean;
      }): Promise<RecommendationResult>;
      prepareRecommendationPreview(arxivId: string): Promise<RecommendationPreview>;
      saveRecommendationThumbnail(input: {
        arxivId: string;
        dataUrl: string;
      }): Promise<string>;
      library: {
        load(): Promise<LibraryState>;
        save(state: LibraryState): Promise<void>;
        recover(): Promise<LibraryState>;
        onBeforeClose?(listener: () => Promise<void>): () => void;
        finishClose?(result: { saved: boolean; error?: string }): Promise<void>;
      };
    };
  }
}

export {};
