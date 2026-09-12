export const WORKSPACE_MODES = Object.freeze(["read", "discuss", "explore"]);
export const READING_FONT_SIZES = Object.freeze([12, 14, 15, 16, 17, 18, 20, 22]);
export const DEFAULT_PANE_SIZES = Object.freeze([46, 31, 23]);
const MINIMUM_WIDTHS = [360, 320, 250];

export function initialWorkspaceState(preferences = {}) {
  return {
    mode: WORKSPACE_MODES.includes(preferences.mode) ? preferences.mode : "discuss",
    fontSize: READING_FONT_SIZES.includes(Number(preferences.fontSize)) ? Number(preferences.fontSize) : 16,
    sidePanel: "chat",
    libraryOpen: false,
    focusRequest: null,
    focusSequence: 0,
  };
}

function focus(state, target) {
  const sequence = state.focusSequence + 1;
  return { ...state, focusSequence: sequence, focusRequest: { target, sequence } };
}

export function workspaceReducer(state, action) {
  switch (action.type) {
    case "mode":
      if (!WORKSPACE_MODES.includes(action.mode)) return state;
      return focus({ ...state, mode: action.mode }, action.mode === "discuss" ? state.sidePanel : "reader");
    case "font-size":
      return READING_FONT_SIZES.includes(action.fontSize) ? { ...state, fontSize: action.fontSize } : state;
    case "side-panel":
    case "show-discussion":
    case "show-notes": {
      const sidePanel = action.type === "show-discussion" ? "chat" : action.type === "show-notes" ? "notes" : action.sidePanel;
      if (sidePanel !== "chat" && sidePanel !== "notes") return state;
      return focus({ ...state, sidePanel, mode: state.mode === "read" ? "discuss" : state.mode }, sidePanel);
    }
    case "show-reader": return focus({ ...state, mode: "read" }, "reader");
    case "open-library": return focus({ ...state, libraryOpen: true }, "library");
    case "close-library": return { ...state, libraryOpen: false, focusRequest: null };
    case "toggle-library": return state.libraryOpen
      ? { ...state, libraryOpen: false, focusRequest: null }
      : focus({ ...state, libraryOpen: true }, "library");
    case "focus": return ["reader", "chat", "notes", "library"].includes(action.target) ? focus(state, action.target) : state;
    default: return state;
  }
}

export function normalizedPaneSizes(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const sizes = value.map(Number);
  if (sizes.some(size => !Number.isFinite(size) || size <= 0)) return null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return Number.isFinite(total) && total > 0 ? sizes.map(size => size / total * 100) : null;
}

export function resizePanePair(widths, divider, delta) {
  const next = [...widths];
  const pairWidth = widths[divider] + widths[divider + 1];
  const scale = Math.min(1, pairWidth / (MINIMUM_WIDTHS[divider] + MINIMUM_WIDTHS[divider + 1]));
  const left = Math.min(pairWidth - MINIMUM_WIDTHS[divider + 1] * scale, Math.max(MINIMUM_WIDTHS[divider] * scale, widths[divider] + delta));
  next[divider] = left;
  next[divider + 1] = pairWidth - left;
  return next;
}

export function paneFractions(widths, previous, mode) {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (!total) return previous;
  return mode === "discuss"
    ? [widths[0] / total * (100 - previous[2]), widths[1] / total * (100 - previous[2]), previous[2]]
    : widths.map(width => width / total * 100);
}
