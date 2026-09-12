export type WorkspaceMode = "read" | "discuss" | "explore";
export type WorkspaceSidePanel = "chat" | "notes";
export type WorkspaceFocusTarget = "reader" | "chat" | "notes" | "library";
export type PaneSizes = [reader: number, chat: number, recommendations: number];
export type WorkspaceState = {
  mode: WorkspaceMode;
  fontSize: number;
  sidePanel: WorkspaceSidePanel;
  libraryOpen: boolean;
  focusRequest: { target: WorkspaceFocusTarget; sequence: number } | null;
  focusSequence: number;
};
export type WorkspaceAction =
  | { type: "mode"; mode: WorkspaceMode }
  | { type: "font-size"; fontSize: number }
  | { type: "side-panel"; sidePanel: WorkspaceSidePanel }
  | { type: "show-discussion" | "show-notes" | "show-reader" | "open-library" | "close-library" | "toggle-library" }
  | { type: "focus"; target: WorkspaceFocusTarget };
export const WORKSPACE_MODES: readonly WorkspaceMode[];
export const READING_FONT_SIZES: readonly number[];
export const DEFAULT_PANE_SIZES: readonly [46, 31, 23];
export function initialWorkspaceState(preferences?: { mode?: unknown; fontSize?: unknown }): WorkspaceState;
export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState;
export function normalizedPaneSizes(value: unknown): PaneSizes | null;
export function resizePanePair(widths: PaneSizes, divider: 0 | 1, delta: number): PaneSizes;
export function paneFractions(widths: PaneSizes, previous: PaneSizes, mode: WorkspaceMode): PaneSizes;
