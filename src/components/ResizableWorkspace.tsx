import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { DEFAULT_PANE_SIZES, normalizedPaneSizes, paneFractions, resizePanePair, type PaneSizes, type WorkspaceMode } from "../workspace-state.mjs";

type Props = { mode: WorkspaceMode; fontSize: number; reader: ReactNode; chat: ReactNode; recommendations: ReactNode };
type DragState = { divider: 0 | 1; pointerId: number; startX: number; widths: PaneSizes; fractions: PaneSizes; mode: WorkspaceMode };
const STORAGE_KEY = "paper-ocean-pane-widths-v1";

function initialSizes(): PaneSizes {
  try { return normalizedPaneSizes(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")) ?? [...DEFAULT_PANE_SIZES]; }
  catch { return [...DEFAULT_PANE_SIZES]; }
}

export default function ResizableWorkspace({ reader, chat, recommendations, mode, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<PaneSizes | null>(null);
  const frameRef = useRef(0);
  const [sizes, setSizes] = useState<PaneSizes>(initialSizes);
  const sizesRef = useRef(sizes);
  const dirtyRef = useRef(false);
  const [activeDivider, setActiveDivider] = useState<0 | 1 | null>(null);

  const paintWidths = useCallback((fractions: PaneSizes) => {
    if (fractions.every((value, index) => value === sizesRef.current[index])) return;
    sizesRef.current = fractions;
    dirtyRef.current = true;
    const node = containerRef.current;
    if (!node) return;
    node.style.setProperty("--reader-pane-size", `${fractions[0]}fr`);
    node.style.setProperty("--chat-pane-size", `${fractions[1]}fr`);
    node.style.setProperty("--recommendation-pane-size", `${fractions[2]}fr`);
  }, []);
  const flushFrame = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    if (!pendingRef.current) return;
    paintWidths(pendingRef.current);
    pendingRef.current = null;
  }, [paintWidths]);
  const scheduleWidths = (fractions: PaneSizes) => {
    pendingRef.current = fractions;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(flushFrame);
  };
  const commitWidths = useCallback(() => {
    flushFrame();
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const next = [...sizesRef.current] as PaneSizes;
    setSizes(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map(size => Number(size.toFixed(4))))); }
    catch { /* Widths still apply during this session. */ }
  }, [flushFrame]);
  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    commitWidths();
    dragRef.current = null;
    delete document.body.dataset.paperOceanResizing;
    setActiveDivider(null);
  }, [commitWidths]);

  useEffect(() => { endDrag(); }, [mode, endDrag]);
  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current);
    delete document.body.dataset.paperOceanResizing;
  }, []);

  const measuredWidths = (): PaneSizes | null => {
    const widths = paneRefs.map(ref => ref.current?.getBoundingClientRect().width ?? 0) as PaneSizes;
    return widths[0] > 0 && widths[1] > 0 && (mode === "discuss" || widths[2] > 0) ? widths : null;
  };
  const beginResize = (divider: 0 | 1, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const widths = measuredWidths();
    if (!widths) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { divider, pointerId: event.pointerId, startX: event.clientX, widths, fractions: sizesRef.current, mode };
    document.body.dataset.paperOceanResizing = "true";
    setActiveDivider(divider);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    scheduleWidths(paneFractions(resizePanePair(drag.widths, drag.divider, event.clientX - drag.startX), drag.fractions, drag.mode));
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") moveResize(event);
    endDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeFromKeyboard = (divider: 0 | 1, event: KeyboardEvent<HTMLDivElement>) => {
    const widths = measuredWidths();
    if (!widths) return;
    const step = event.shiftKey ? 36 : 12;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : event.key === "Home" ? -Number.MAX_SAFE_INTEGER : event.key === "End" ? Number.MAX_SAFE_INTEGER : 0;
    if (!delta) return;
    event.preventDefault();
    paintWidths(paneFractions(resizePanePair(widths, divider, delta), sizesRef.current, mode));
    setSizes([...sizesRef.current]);
  };
  const resetSizes = () => { paintWidths([...DEFAULT_PANE_SIZES]); commitWidths(); };
  const style = {
    "--reader-pane-size": `${sizes[0]}fr`, "--chat-pane-size": `${sizes[1]}fr`,
    "--recommendation-pane-size": `${sizes[2]}fr`, "--reading-font-size": `${fontSize}px`,
  } as CSSProperties;
  const separator = (divider: 0 | 1, label: string) => <div
    className={`pane-resizer${activeDivider === divider ? " pane-resizer--active" : ""}`}
    role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.round(sizes.slice(0, divider + 1).reduce((sum, size) => sum + size, 0))}
    tabIndex={0} title="拖动调整栏宽；双击恢复默认"
    onPointerDown={event => beginResize(divider, event)} onPointerMove={moveResize}
    onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={endDrag}
    onKeyDown={event => resizeFromKeyboard(divider, event)}
    onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) commitWidths(); }}
    onBlur={() => { if (!dragRef.current) commitWidths(); }} onDoubleClick={resetSizes}
  ><span aria-hidden="true" /></div>;

  return <section className="workspace" style={{ "--reading-font-size": `${fontSize}px` } as CSSProperties}>
    <div ref={containerRef} className="workspace-grid" data-mode={mode} data-resizing={activeDivider !== null} style={style}>
      <div ref={paneRefs[0]} className="workspace-pane reader-pane">{reader}</div>
      {separator(0, "调整论文阅读区与 AI 对话区宽度")}
      <div ref={paneRefs[1]} className="workspace-pane chat-pane">{chat}</div>
      {separator(1, "调整 AI 对话区与论文推荐区宽度")}
      <div ref={paneRefs[2]} className="workspace-pane recommendation-pane">{mode === "explore" ? recommendations : null}</div>
    </div>
  </section>;
}
