import type { PaperRecord, PaperSuggestion } from '../src/types';
export function searchText(value?: string): string;
export function titleMatchScore(query: string, title: string): number;
export function localPaperSuggestions(query: string, papers: PaperRecord[]): PaperSuggestion[];
