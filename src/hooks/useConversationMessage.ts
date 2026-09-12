import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { conversationRuntime } from "../conversation-runtime.mjs";
import type { ChatMessage } from "../types";

/** Subscribe in the message leaf, never in the conversation list or App. */
export default function useConversationMessage(scopeKey: string, persistedMessage: ChatMessage): ChatMessage {
  const subscribe = useCallback((notify: () => void) => conversationRuntime.subscribeMessage(scopeKey, persistedMessage.id, notify), [scopeKey, persistedMessage.id]);
  const getSnapshot = useCallback(() => conversationRuntime.getMessagePatch(scopeKey, persistedMessage.id), [scopeKey, persistedMessage.id]);
  const patch = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { conversationRuntime.acknowledgeMessage(scopeKey, persistedMessage); }, [scopeKey, persistedMessage]);
  return useMemo(() => Object.keys(patch).length ? { ...persistedMessage, ...patch } : persistedMessage, [persistedMessage, patch]);
}
