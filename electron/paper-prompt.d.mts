export type PaperPromptInput = {
  mode: "single" | "all";
  characterCount: number;
  papers: Array<{ id?: string; title: string; pageCount?: number }>;
  currentPaperTitle?: string;
  currentPage?: number;
  hasSelection: boolean;
  question: string;
  coverage?: { complete: boolean; providedPages: number; totalPages: number };
  hasPageImage?: boolean;
  answerDepth?: "brief" | "balanced" | "deep";
  pageImages?: Array<{ paperId: string; page: number }>;
};

export declare const PAPER_READING_BASE_INSTRUCTIONS: string;
export declare function buildPaperTurnPrompt(input: PaperPromptInput): string;
