import assert from "node:assert/strict";
import test from "node:test";
import { initialWorkspaceState, workspaceReducer, normalizedPaneSizes, resizePanePair, paneFractions } from "../src/workspace-state.mjs";

test("workspace preferences retain existing modes and font sizes without reopening transient panels", () => {
  const state = initialWorkspaceState({ mode: "explore", fontSize: "18" });
  assert.equal(state.mode, "explore"); assert.equal(state.fontSize, 18);
  assert.equal(state.libraryOpen, false); assert.equal(state.sidePanel, "chat"); assert.equal(state.focusRequest, null);
  assert.equal(initialWorkspaceState({ mode: "unknown", fontSize: 999 }).mode, "discuss");
  assert.equal(initialWorkspaceState().fontSize, 16, "new readers receive a comfortable default");
  assert.equal(initialWorkspaceState({ fontSize: null }).fontSize, 16);
  assert.equal(initialWorkspaceState({ fontSize: "12" }).fontSize, 12, "older compact preferences remain supported");
  assert.equal(initialWorkspaceState({ fontSize: "14" }).fontSize, 14, "existing normal-size preferences are not reset");
  assert.equal(workspaceReducer(state, { type: "font-size", fontSize: 20 }).fontSize, 20);
});

test("showing notes or discussion reveals its pane without discarding explore or conflating library visibility", () => {
  let state = initialWorkspaceState({ mode: "read" });
  state = workspaceReducer(state, { type: "open-library" });
  state = workspaceReducer(state, { type: "show-notes" });
  assert.equal(state.mode, "discuss"); assert.equal(state.sidePanel, "notes"); assert.equal(state.libraryOpen, true);
  assert.deepEqual(state.focusRequest, { target: "notes", sequence: 2 });
  state = workspaceReducer(state, { type: "mode", mode: "explore" });
  state = workspaceReducer(state, { type: "show-discussion" });
  assert.equal(state.mode, "explore"); assert.equal(state.sidePanel, "chat");
  const again = workspaceReducer(state, { type: "show-discussion" });
  assert.ok(again.focusRequest.sequence > state.focusRequest.sequence, "repeated intents remain observable for focus");
  state = workspaceReducer(again, { type: "close-library" });
  assert.equal(state.mode, "explore"); assert.equal(state.focusRequest, null);
});

test("width migration and pair resizing preserve total space and the hidden recommendation preference", () => {
  assert.deepEqual(normalizedPaneSizes([92, 62, 46]), [46, 31, 23]);
  assert.equal(normalizedPaneSizes([0, 50, 50]), null);
  assert.equal(normalizedPaneSizes([Infinity, 1, 1]), null);
  const narrow = resizePanePair([300, 300, 0], 0, 10000);
  assert.ok(Math.abs(narrow[0] + narrow[1] - 600) < 0.001);
  assert.ok(narrow[0] > 300 && narrow[1] > 280, "small windows scale both minimum widths together");
  const widths = resizePanePair([600, 400, 0], 0, -100);
  assert.deepEqual(paneFractions(widths, [46, 31, 23], "discuss"), [38.5, 38.5, 23]);
  const explore = resizePanePair([460, 310, 230], 1, -1000);
  assert.equal(explore[0], 460); assert.equal(explore.reduce((sum, width) => sum + width, 0), 1000);
});
