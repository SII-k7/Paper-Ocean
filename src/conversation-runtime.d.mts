import type { ChatMessage, CodexEvent } from "./types";

export type ConversationLane = "main" | "auxiliary";
export type ConversationRun = {
  readonly lane: ConversationLane;
  readonly scopeKey: string;
  readonly assistantMessageId: string;
};
export type ConversationLaneSnapshot = {
  busy: boolean;
  busyScope: string;
  error: string | null;
  errorScope: string | null;
  cancelRequested: boolean;
};
export type ConversationPatch = { scopeKey: string; messageId: string; patch: Partial<ChatMessage> };
export type ConversationAdapter = {
  /** Must synchronously merge patches into useLibrary's latest state. */
  persist(patches: ConversationPatch[]): void;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  interrupt(input: { threadId: string; turnId: string }): Promise<unknown>;
  onAccountEvent?(event: CodexEvent): void;
  onTurnCompleted?(lane: ConversationLane): void;
};
export class CancelledTurnError extends Error {}
export interface ConversationRuntime {
  begin(lane: ConversationLane, scopeKey: string, assistantMessage: ChatMessage): ConversationRun;
  bindThread(run: ConversationRun, threadId: string): void;
  bindTurn(run: ConversationRun, result: { turnId: string; serviceTier?: string | null }): Promise<void>;
  patch(run: ConversationRun, patch: Partial<ChatMessage>): void;
  checkCancelled(run: ConversationRun): void;
  fail(run: ConversationRun, reason: unknown): void;
  stop(lane: ConversationLane): Promise<void>;
  handleEvent(event: CodexEvent): void;
  attach(adapter: ConversationAdapter, target?: EventTarget): () => void;
  flushSnapshots(): void;
  prepareForClose(): Promise<void>;
  isBusy(lane: ConversationLane): boolean;
  setError(lane: ConversationLane, error: string | null, scopeKey?: string): void;
  clearError(lane: ConversationLane): void;
  getLaneSnapshot(lane: ConversationLane): ConversationLaneSnapshot;
  subscribeLane(lane: ConversationLane, listener: () => void): () => void;
  subscribeMessage(scopeKey: string, messageId: string, listener: () => void): () => void;
  acknowledgeMessage(scopeKey: string, persistedMessage: ChatMessage): void;
  getMessagePatch(scopeKey: string, messageId: string): Partial<ChatMessage>;
}
export function createConversationRuntime(options?: {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  displayInterval?: number;
  snapshotInterval?: number;
  closeTimeout?: number;
}): ConversationRuntime;
export const conversationRuntime: ConversationRuntime;
