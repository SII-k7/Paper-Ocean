import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createComposerDraftBuffer } from "../composer-draft.mjs";

/** Keep keystrokes local; flush synchronously before any action that saves or sends. */
export default function useComposerDraft(scopeKey: string, persistedDraft: string, onDraftChange: (value: string) => void) {
  const bufferRef = useRef<ReturnType<typeof createComposerDraftBuffer> | null>(null);
  if (!bufferRef.current) bufferRef.current = createComposerDraftBuffer(scopeKey, persistedDraft, onDraftChange);
  const [draft, setLocalDraft] = useState(persistedDraft);

  useLayoutEffect(() => {
    setLocalDraft(bufferRef.current!.receive(scopeKey, persistedDraft, onDraftChange));
  });

  const setDraft = useCallback((value: string) => {
    bufferRef.current!.edit(value);
    setLocalDraft(value);
  }, []);
  const flushDraft = useCallback(() => { bufferRef.current!.flush(); }, []);

  useEffect(() => {
    window.addEventListener("paper-ocean-before-save", flushDraft);
    window.addEventListener("paper-ocean-before-close", flushDraft);
    return () => {
      window.removeEventListener("paper-ocean-before-save", flushDraft);
      window.removeEventListener("paper-ocean-before-close", flushDraft);
    };
  }, [flushDraft]);
  useLayoutEffect(() => () => { bufferRef.current!.flush(); }, []);

  return { draft, setDraft, flushDraft };
}
