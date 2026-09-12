import { useCallback, useEffect, useReducer } from "react";
import { initialWorkspaceState, workspaceReducer, type WorkspaceFocusTarget, type WorkspaceMode, type WorkspaceSidePanel } from "../workspace-state.mjs";

function initialState() {
  try {
    return initialWorkspaceState({ mode: localStorage.getItem("paper-ocean-workspace-mode"), fontSize: localStorage.getItem("paper-ocean-reading-font-size") });
  } catch { return initialWorkspaceState(); }
}

export default function useWorkspaceController() {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialState);
  useEffect(() => {
    try {
      localStorage.setItem("paper-ocean-workspace-mode", state.mode);
      localStorage.setItem("paper-ocean-reading-font-size", String(state.fontSize));
    } catch { /* Workspace controls remain usable without persistent storage. */ }
  }, [state.mode, state.fontSize]);

  return {
    ...state,
    setMode: useCallback((mode: WorkspaceMode) => dispatch({ type: "mode", mode }), []),
    setFontSize: useCallback((fontSize: number) => dispatch({ type: "font-size", fontSize }), []),
    setSidePanel: useCallback((sidePanel: WorkspaceSidePanel) => dispatch({ type: "side-panel", sidePanel }), []),
    showDiscussion: useCallback(() => dispatch({ type: "show-discussion" }), []),
    showNotes: useCallback(() => dispatch({ type: "show-notes" }), []),
    showReader: useCallback(() => dispatch({ type: "show-reader" }), []),
    openLibrary: useCallback(() => dispatch({ type: "open-library" }), []),
    closeLibrary: useCallback(() => dispatch({ type: "close-library" }), []),
    toggleLibrary: useCallback(() => dispatch({ type: "toggle-library" }), []),
    requestFocus: useCallback((target: WorkspaceFocusTarget) => dispatch({ type: "focus", target }), []),
  };
}
