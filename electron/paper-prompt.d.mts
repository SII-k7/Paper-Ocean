export type PaperPromptInput = {
  mode: "single" | "all";
  characterCount: number;
  papers: Array<{ title: string; pageCount?: number }>;
  currentPaperTitle?: string;
  currentPage?: number;
  hasSelection: boolean;
  question: string;
};

export declare const PAPER_READING_BASE_INSTRUCTIONS: string;
export declare function buildPaperTurnPrompt(input: PaperPromptInput): string;
