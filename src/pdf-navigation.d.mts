import type { PDFDocumentProxy } from "pdfjs-dist";
export type PdfTextMatch = { start: number; end: number };
export type PdfSearchResult = { page: number; occurrence: number; snippet: string };
export function findTextMatches(text: string, query: string, limit?: number): PdfTextMatch[];
export function pageTextWithRanges(items: Array<{ str?: string; hasEOL?: boolean }>): { text: string; ranges: Array<{ index: number; start: number; end: number }> };
export function searchPdfPages(pages: Array<{ page: number; text: string }>, query: string, limit?: number): PdfSearchResult[];
export function safePdfUrl(value: unknown): string | null;
export function resolvePdfDestination(document: PDFDocumentProxy, input: unknown): Promise<{ page: number; x: number; y: number }>;
