export function parseArxivReference(input: string): { id: string; version?: number; reference: string } | null;
export function publicationDate(value: unknown): string | undefined;
export function paperMetadata(value: Record<string, unknown>): Record<string, unknown>;
