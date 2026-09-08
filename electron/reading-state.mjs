import { normalizeNotes } from "./notes.mjs";

export function normalizeReadingPosition(value) {
  if (!value || !Number.isInteger(value.page) || value.page < 1 || value.page > 10_000) return undefined;
  const unit = (number, fallback) => Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
  return {
    page: value.page, y: unit(value.y, 0), x: unit(value.x, 0.5),
    zoom: Number.isFinite(value.zoom) ? Math.max(0.25, Math.min(4, value.zoom)) : 1,
    fitWidth: value.fitWidth !== false,
  };
}

export function normalizeReadingState(value) {
  const entries = (input) => input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : [];
  return {
    ...normalizeNotes(value),
    readingPreferencesByScope: Object.fromEntries(entries(value.readingPreferencesByScope).filter(([, item]) => item && typeof item === "object").map(([scope, item]) => [scope, {
      depth: ["brief", "balanced", "deep"].includes(item.depth) ? item.depth : "deep",
      templates: Array.isArray(item.templates) ? item.templates.filter((text) => typeof text === "string").slice(0, 8).map((text) => text.slice(0, 8_000)) : undefined,
    }])),
    lastConversationByPaper: Object.fromEntries(entries(value.lastConversationByPaper).filter(([id, scope]) => /^[a-f0-9]{24}$/.test(id) && typeof scope === "string" && /^(?:paper:[a-f0-9]{24}|conversation:[a-f0-9-]{36})$/.test(scope))),
    chatPositions: Object.fromEntries(entries(value.chatPositions).filter(([, position]) => position && typeof position === "object").map(([scope, position]) => [scope, {
      messageId: typeof position.messageId === "string" ? position.messageId.slice(0, 180) : undefined,
      block: Number.isInteger(position.block) ? Math.max(0, position.block) : 0,
      offset: Number.isFinite(position.offset) ? Math.max(0, Math.min(1, position.offset)) : 0,
      followOutput: position.followOutput !== false,
    }])),
    draftsByScope: Object.fromEntries(entries(value.draftsByScope).filter(([, draft]) => typeof draft === "string").map(([scope, draft]) => [scope, draft.slice(0, 100_000)])),
  };
}
