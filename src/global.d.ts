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
  Recommendation,
  RecommendationPreview,
} from "./types";

declare global {
  interface Window {
    paperOcean: {
      runtime?: "web" | "electron" | "demo";
      openPdf(): Promise<OpenedPaper | null>;
      reopenPdf(path: string): Promise<OpenedPaper>;
      openUrl(url: string): Promise<OpenedPaper>;
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
      prepareConversation(input: {
        scopeKey: string;
        papers: PaperRecord[];
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
      }): Promise<Recommendation[]>;
      prepareRecommendationPreview(arxivId: string): Promise<RecommendationPreview>;
      saveRecommendationThumbnail(input: {
        arxivId: string;
        dataUrl: string;
      }): Promise<string>;
      library: {
        load(): Promise<LibraryState>;
        save(state: LibraryState): Promise<void>;
      };
    };
  }
}

export {};
