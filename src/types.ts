export type PdfPageIndex = {
  page: number;
  text: string;
};

export type ReadingPosition = {
  page: number;
  y: number;
  x: number;
  zoom: number;
  fitWidth: boolean;
};

export type ChatPosition = {
  messageId?: string;
  block: number;
  offset: number;
  followOutput: boolean;
};

export type ConversationRecord = {
  id: string;
  title: string;
  paperIds: string[];
  createdAt: number;
  updatedAt: number;
  readOnly?: boolean;
};

export type ReadingPreferences = {
  depth: "brief" | "balanced" | "deep";
  templates?: string[];
};

export type EvidenceRect = { x: number; y: number; width: number; height: number };
export type EvidenceAnchor = {
  id: string;
  paperId: string;
  page: number;
  quote: string;
  rects: EvidenceRect[];
};
export type PaperHighlight = EvidenceAnchor & {
  color: "yellow" | "green" | "pink";
  createdAt: number;
  archivedAt?: number;
};
export type ResearchNote = {
  id: string;
  title: string;
  body: string;
  anchors: EvidenceAnchor[];
  sourceMessage?: { scopeKey: string; messageId: string };
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type PaperRecord = {
  id: string;
  name: string;
  path: string;
  originalPath?: string;
  managedOriginal?: boolean;
  sourceUrl?: string;
  arxivId?: string;
  arxivVersion?: number;
  authors?: string[];
  publishedAt?: string;
  revisedAt?: string;
  readingStatus?: "unread" | "reading" | "done";
  title: string;
  abstract?: string;
  pageCount?: number;
  paperDir?: string;
  threadId?: string;
  lastPage?: number;
  readingPosition?: ReadingPosition;
  openedAt: number;
};

export type OpenedPaper = PaperRecord & {
  dataBase64: string;
  cachedPages?: PdfPageIndex[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  page?: number;
  paperId?: string;
  contextCoverage?: { complete: boolean; providedPages: number; totalPages: number };
  pageImages?: Array<{ paperId: string; page: number }>;
  pending?: boolean;
  interrupted?: boolean;
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
  publishedAt?: string;
  source?: "OpenAlex" | "Semantic Scholar";
  sourceUrl?: string;
  relation?: "search" | "similar" | "reference";
};

export type RecommendationResult = { items: Recommendation[]; fetchedAt: number; cache: "fresh" | "cached" | "stale"; pending: boolean; error?: string };

export type DownloadProgress = { id: string; source: string; reference?: string; phase: "metadata" | "downloading" | "verifying" | "preparing" | "complete" | "paused" | "error"; received: number; total?: number; resumed: boolean; error?: string; updatedAt?: number };

export type RecommendationPreview =
  | { status: "ready"; imageUrl: string }
  | { status: "render"; pdfUrl: string }
  | { status: "missing"; reason?: string };

export type ConversationContext = {
  contextDir: string;
  entries: Array<{
    key: string;
    path: string;
    kind: "application" | "untrusted";
  }>;
  paperCount: number;
  characterCount: number;
  coverage?: {
    complete: boolean;
    providedPages: number;
    totalPages: number;
    textBytes: number;
    papers: Array<{ paperId: string; pages: number[]; totalPages: number; excerptPages: number[] }>;
  };
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
  id: "gpt-6-astra" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
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
  lastScopeKey?: string;
  chatPositions?: Record<string, ChatPosition>;
  draftsByScope?: Record<string, string>;
  conversations?: Record<string, ConversationRecord>;
  lastConversationByPaper?: Record<string, string>;
  readingPreferencesByScope?: Record<string, ReadingPreferences>;
  highlights?: PaperHighlight[];
  notes?: ResearchNote[];
};

export type CodexEvent = {
  method: string;
  params?: Record<string, unknown>;
};

export type PaperSuggestion = { key: string; title: string; subtitle: string; source: "local" | "arxiv" | "semantic-scholar"; paperId?: string; arxivId?: string; semanticId?: string };
export type PaperSearchResult = { items: PaperSuggestion[]; error?: string };
export type PaperCategory = "运动控制" | "动作生成" | "VLA" | "世界模型" | "待分类";
export type PaperArchiveStatus = {
  directory: string; busy: boolean; error?: string;
  overrides?: Record<string, PaperCategory>;
  entries: Array<{ paperId: string; title: string; category: PaperCategory; reason: string; manual: boolean; path: string; savedAt: number }>;
  failures: Array<{ paperId: string; title: string; error: string }>;
};
