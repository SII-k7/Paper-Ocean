import type { ConversationRecord, LibraryState } from "../src/types";
export declare function isConversationKey(value: unknown): boolean;
export declare function normalizeConversations(library: Partial<LibraryState>): Record<string, ConversationRecord>;
export declare function samePaperSet(left: string[], right: string[]): boolean;
export declare function validateConversationPapers(library: Partial<LibraryState>, scopeKey: string, paperIds: string[]): void;
