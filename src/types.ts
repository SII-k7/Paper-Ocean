export type PdfPageIndex = {
  page: number;
  text: string;
};

export type PaperRecord = {
  id: string;
  name: string;
  path: string;
  sourceUrl?: string;
  arxivId?: string;
  title: string;
  abstract?: string;
  pageCount?: number;
  paperDir?: string;
  threadId?: string;
  lastPage?: number;
  openedAt: number;
};

export type OpenedPaper = PaperRecord & {
  dataBase64: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  page?: number;
  pending?: boolean;
  error?: boolean;
};

export type Recommendation = {
  paperId: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  url?: string;
  pdfUrl?: string;
  arxivId?: string;
  citationCount?: number;
  relevanceScore?: number;
  fameScore?: number;
  score?: number;
  reason: string;
};

export type ConversationContext = {
  contextDir: string;
  entries: Array<{
    key: string;
    path: string;
    kind: "application" | "untrusted";
  }>;
  paperCount: number;
  characterCount: number;
};

export type CodexAccount = {
  connected: boolean;
  accountType: string | null;
  planType: string | null;
  codexPath?: string;
  error?: string;
};

export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type CodexModel = {
  id: "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
  displayName: string;
  description: string;
  defaultEffort: CodexEffort;
  supportedEfforts: CodexEffort[];
  isDefault: boolean;
};

export type CodexSelection = {
  model: CodexModel["id"];
  effort: CodexEffort;
};

export type RateLimitWindow = {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
};

export type RateLimitInfo = {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};

export type LibraryState = {
  papers: PaperRecord[];
  messagesByScope: Record<string, ChatMessage[]>;
  threadsByScope: Record<string, string>;
  aiSettingsByScope: Record<string, CodexSelection>;
  openPaperIds: string[];
  lastPaperId?: string;
};

export type CodexEvent = {
  method: string;
  params?: Record<string, unknown>;
};
