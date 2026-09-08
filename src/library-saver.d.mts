import type { LibraryState } from "./types";
export type SaveState = { status: "saved" | "saving" | "error"; error?: string };
export function createLibrarySaver(save: (state: LibraryState) => Promise<void>, notify: (state: SaveState) => void, delay?: number): {
  schedule(state: LibraryState): void;
  flush(): Promise<void>;
  isDirty(): boolean;
  error(): unknown;
  cancelTimer(): void;
};
