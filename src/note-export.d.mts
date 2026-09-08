import type { EvidenceAnchor, PaperRecord, ResearchNote } from "./types";
export function evidenceImageName(anchor: Pick<EvidenceAnchor, "paperId" | "page">): string;
export function noteMarkdown(note: ResearchNote, papers: PaperRecord[], includeImages?: boolean): string;
