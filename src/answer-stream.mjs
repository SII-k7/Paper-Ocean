// Each agent message is a separate streamed item. Completion replaces only
// that item's deltas, never an earlier paragraph from the same turn.
export function createAnswerStream() {
  const items = new Map();
  return {
    consume(method, params) {
      const complete = method === "item/completed" && params.item?.type === "agentMessage";
      if (!complete && method !== "item/agentMessage/delta") return undefined;
      const id = (complete ? params.item.id : params.itemId) ?? "answer";
      const previous = items.get(id) ?? { text: "", complete: false };
      if (complete) items.set(id, { text: params.item.text || previous.text, complete: true });
      else if (!previous.complete) {
        const delta = typeof params.delta === "string" ? params.delta : params.delta?.text;
        if (delta) items.set(id, { text: previous.text + delta, complete: false });
      }
      return [...items.values()].map(item => item.text).filter(Boolean).join("\n\n");
    },
  };
}
