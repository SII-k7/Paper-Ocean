import { useCallback, useSyncExternalStore } from "react";
import { conversationRuntime, type ConversationLane } from "../conversation-runtime.mjs";

/** Lane snapshots change only for lifecycle/errors, never for answer tokens. */
export default function useConversationLane(lane: ConversationLane) {
  const subscribe = useCallback((notify: () => void) => conversationRuntime.subscribeLane(lane, notify), [lane]);
  const getSnapshot = useCallback(() => conversationRuntime.getLaneSnapshot(lane), [lane]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
