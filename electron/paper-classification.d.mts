import type { PaperCategory, PaperRecord } from '../src/types';
export const PAPER_CATEGORIES: PaperCategory[];
export function classifyPaper(paper: Partial<PaperRecord>, excerpt?: string): { category: PaperCategory; reason: string };
