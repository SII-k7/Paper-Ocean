import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadProgress, OpenedPaper } from "../types";

const STORAGE = "paper-ocean-pending-download";
function restored(): DownloadProgress | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "null");
    if (!saved || typeof saved.source !== "string" || !saved.source.trim() || saved.source.length > 2000) return null;
    return { id: String(saved.id || ""), source: saved.source, reference: typeof saved.reference === "string" ? saved.reference : undefined,
      received: Number.isFinite(saved.received) && saved.received > 0 ? saved.received : 0,
      total: Number.isFinite(saved.total) && saved.total > 0 ? saved.total : undefined, resumed: false, phase: "paused" };
  } catch { return null; }
}
export default function usePaperDownload() {
  const [progress, setProgress] = useState<DownloadProgress | null>(restored);
  const [busy, setBusy] = useState(false);
  const active = useRef<string | null>(null);
  const current = useRef(progress);
  const mounted = useRef(true);
  const update = useCallback((next: DownloadProgress | null) => {
    current.current = next;
    if (mounted.current) setProgress(next);
    try { if (next && next.phase !== "complete") localStorage.setItem(STORAGE, JSON.stringify(next)); else localStorage.removeItem(STORAGE); } catch { /* Local preferences are optional. */ }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const beforeClose = (event: Event) => {
      if (active.current) (event as CustomEvent).detail?.waitUntil(window.paperOcean.cancelDownload(active.current));
    };
    window.addEventListener("paper-ocean-before-close", beforeClose);
    return () => { mounted.current = false; window.removeEventListener("paper-ocean-before-close", beforeClose); };
  }, []);
  const start = useCallback(async (source: string): Promise<OpenedPaper | null> => {
    if (active.current) return null;
    const id = crypto.randomUUID(); active.current = id; setBusy(true);
    update({ id, source, phase: "metadata", received: 0, resumed: false });
    let finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { const value = await window.paperOcean.downloadStatus(id); if (!finished && value) update(value); }
      catch { /* The main request reports failures; polling may recover. */ }
      if (!finished) timer = setTimeout(() => void poll(), 500);
    };
    timer = setTimeout(() => void poll(), 100);
    try {
      const opened = await window.paperOcean.openUrl(source, id);
      finished = true;
      const status = await window.paperOcean.downloadStatus(id).catch(() => null);
      update({ ...(status ?? current.current!), phase: "complete", error: undefined });
      return opened;
    } catch (error) {
      finished = true;
      const status = await window.paperOcean.downloadStatus(id).catch(() => null);
      update(status?.phase === "paused" || status?.phase === "error" ? status : { ...(status ?? current.current!), phase: "error",
        error: status?.phase === "complete" ? "PDF 已缓存，但打开结果未送达。请继续以重新打开。" : error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      finished = true; clearTimeout(timer); active.current = null;
      if (mounted.current) setBusy(false);
    }
  }, [update]);
  const cancel = useCallback(async () => {
    if (!active.current) return;
    try { await window.paperOcean.cancelDownload(active.current); }
    catch (error) { update({ ...current.current!, error: `暂停请求失败：${error instanceof Error ? error.message : String(error)}` }); }
  }, [update]);
  return { progress, busy, start, cancel, dismiss: () => { if (!active.current) update(null); } };
}
