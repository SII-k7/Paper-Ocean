import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { createLibrarySaver, type SaveState } from "../library-saver.mjs";
import { createSaveStateNotifier } from "../save-state-notifier.mjs";
import type { LibraryState } from "../types";

const EMPTY_LIBRARY: LibraryState = {
  papers: [], messagesByScope: {}, threadsByScope: {}, aiSettingsByScope: {}, openPaperIds: [],
};

export default function useLibrary() {
  const [library, setState] = useState<LibraryState>(EMPTY_LIBRARY);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: "saved" });
  const latest = useRef(library);
  const readyRef = useRef(false);
  const notifySaveState = useRef<ReturnType<typeof createSaveStateNotifier> | null>(null);
  if (!notifySaveState.current) notifySaveState.current = createSaveStateNotifier(setSaveState);
  const saver = useRef<ReturnType<typeof createLibrarySaver> | null>(null);
  if (!saver.current) saver.current = createLibrarySaver((state) => window.paperOcean.library.save(state), notifySaveState.current);

  const initialize = useCallback((state: LibraryState) => {
    latest.current = state;
    readyRef.current = true;
    setState(state);
    setReady(true);
    notifySaveState.current!({ status: "saved" });
  }, []);

  const setLibrary = useCallback((update: SetStateAction<LibraryState>) => {
    if (!readyRef.current) return;
    const next = typeof update === "function" ? update(latest.current) : update;
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
    saver.current!.schedule(next);
  }, []);

  const flush = useCallback(() => saver.current!.flush(), []);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      window.dispatchEvent(new Event("paper-ocean-before-save"));
      if (!saver.current!.isDirty()) return;
      void flush().catch(() => undefined);
      // A browser cannot wait for an async save during unload. Keep the page
      // open with its standard unsaved-changes prompt instead of claiming that
      // a keepalive/beacon saved an arbitrarily large library.
      event.preventDefault();
      event.returnValue = "";
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      window.dispatchEvent(new Event("paper-ocean-before-save"));
      void flush().catch(() => undefined);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = window.paperOcean.library.onBeforeClose?.(async requestId => {
      try {
        const tasks: Promise<unknown>[] = [];
        window.dispatchEvent(new CustomEvent("paper-ocean-before-close", {
          detail: { waitUntil: (task: Promise<unknown>) => tasks.push(task) },
        }));
        await Promise.all(tasks);
        window.dispatchEvent(new Event("paper-ocean-before-save"));
        await flush();
        await window.paperOcean.library.finishClose?.({ saved: true, requestId });
      } catch (error) {
        await window.paperOcean.library.finishClose?.({ saved: false, requestId, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe?.();
    };
  }, [flush]);

  return { library, setLibrary, libraryReady: ready, initializeLibrary: initialize, saveState, flushLibrary: flush };
}
