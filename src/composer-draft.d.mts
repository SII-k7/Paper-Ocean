export type ComposerDraftBuffer = {
  readonly value: string;
  edit(value: string): void;
  receive(scopeKey: string, value: string, onCommit: (value: string) => void): string;
  flush(): void;
};
export function createComposerDraftBuffer(scopeKey: string, value: string, onCommit: (value: string) => void, options?: {
  delayMs?: number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): ComposerDraftBuffer;
