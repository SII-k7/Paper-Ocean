import type { SaveState } from "./library-saver.mjs";
export function createSaveStateNotifier(notify: (state: SaveState) => void): (state: SaveState) => void;
