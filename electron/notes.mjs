const paperIdPattern = /^[a-f0-9]{24}$/;
const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
const timestamp = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

export function normalizeAnchor(value) {
  if (!value || !paperIdPattern.test(value.paperId) || !Number.isInteger(value.page) || value.page < 1 || value.page > 10_000) return undefined;
  const rects = (Array.isArray(value.rects) ? value.rects : []).flatMap((rect) => {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return [];
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const right = Math.min(1, rect.x + rect.width), bottom = Math.min(1, rect.y + rect.height);
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
  }).slice(0, 500);
  return { id: text(value.id, 180) || `${value.paperId}:${value.page}`, paperId: value.paperId, page: value.page, quote: text(value.quote, 20_000), rects };
}

export function normalizeNotes(value) {
  return {
    highlights: (Array.isArray(value.highlights) ? value.highlights : []).flatMap((item) => {
      const anchor = normalizeAnchor(item);
      return anchor ? [{ ...anchor, color: ["yellow", "green", "pink"].includes(item.color) ? item.color : "yellow", createdAt: timestamp(item.createdAt), archivedAt: item.archivedAt === undefined ? undefined : timestamp(item.archivedAt) }] : [];
    }),
    notes: (Array.isArray(value.notes) ? value.notes : []).flatMap((item) => {
      if (!item || typeof item.id !== "string" || !item.id) return [];
      return [{
        id: text(item.id, 180), title: text(item.title, 300), body: text(item.body, 500_000),
        anchors: (Array.isArray(item.anchors) ? item.anchors : []).map(normalizeAnchor).filter(Boolean),
        sourceMessage: item.sourceMessage && typeof item.sourceMessage.scopeKey === "string" && typeof item.sourceMessage.messageId === "string"
          ? { scopeKey: text(item.sourceMessage.scopeKey, 180), messageId: text(item.sourceMessage.messageId, 180) } : undefined,
        createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt),
        archivedAt: item.archivedAt === undefined ? undefined : timestamp(item.archivedAt),
      }];
    }),
  };
}
