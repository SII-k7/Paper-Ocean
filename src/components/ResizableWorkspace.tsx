import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

type PaneSizes = [reader: number, chat: number, recommendations: number];

type Props = {
  reader: ReactNode;
  chat: ReactNode;
  recommendations: ReactNode;
};

type DragState = {
  divider: 0 | 1;
  pointerId: number;
  startX: number;
  widths: PaneSizes;
};

const STORAGE_KEY = "paper-ocean-pane-widths-v1";
const DEFAULT_SIZES: PaneSizes = [46, 31, 23];
const MINIMUM_WIDTHS: PaneSizes = [360, 320, 250];

function normalizedSizes(value: unknown): PaneSizes | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const sizes = value.map(Number) as PaneSizes;
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) return null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return null;
  return sizes.map((size) => (size / total) * 100) as PaneSizes;
}

function initialSizes(): PaneSizes {
  try {
    return normalizedSizes(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null"))
      ?? DEFAULT_SIZES;
  } catch {
    return DEFAULT_SIZES;
  }
}

function clampPair(
  widths: PaneSizes,
  divider: 0 | 1,
  delta: number,
): PaneSizes {
  const next = [...widths] as PaneSizes;
  const leftIndex = divider;
  const rightIndex = divider + 1;
  const pairWidth = widths[leftIndex] + widths[rightIndex];
  const minimumScale = Math.min(
    1,
    pairWidth / (MINIMUM_WIDTHS[leftIndex] + MINIMUM_WIDTHS[rightIndex]),
  );
  const leftMinimum = MINIMUM_WIDTHS[leftIndex] * minimumScale;
  const rightMinimum = MINIMUM_WIDTHS[rightIndex] * minimumScale;
  const leftWidth = Math.min(
    pairWidth - rightMinimum,
    Math.max(leftMinimum, widths[leftIndex] + delta),
  );
  next[leftIndex] = leftWidth;
  next[rightIndex] = pairWidth - leftWidth;
  return next;
}

export default function ResizableWorkspace({ reader, chat, recommendations }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRefs = [
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
  ] as const;
  const dragRef = useRef<DragState | null>(null);
  const [sizes, setSizes] = useState<PaneSizes>(initialSizes);
  const [activeDivider, setActiveDivider] = useState<0 | 1 | null>(null);

  const measuredWidths = useCallback((): PaneSizes | null => {
    const values = paneRefs.map((ref) => ref.current?.getBoundingClientRect().width ?? 0) as PaneSizes;
    return values.every((width) => width > 0) ? values : null;
  }, []);

  const applyPixelWidths = useCallback((widths: PaneSizes) => {
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (!total) return;
    setSizes(widths.map((width) => (width / total) * 100) as PaneSizes);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes.map((size) => Number(size.toFixed(4)))));
    } catch {
      // Resizing still works for the current session when storage is unavailable.
    }
  }, [sizes]);

  useEffect(() => () => {
    delete document.body.dataset.paperOceanResizing;
  }, []);

  const beginResize = (divider: 0 | 1, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const widths = measuredWidths();
    if (!widths) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      divider,
      pointerId: event.pointerId,
      startX: event.clientX,
      widths,
    };
    document.body.dataset.paperOceanResizing = "true";
    setActiveDivider(divider);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyPixelWidths(clampPair(drag.widths, drag.divider, event.clientX - drag.startX));
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    delete document.body.dataset.paperOceanResizing;
    setActiveDivider(null);
  };

  const resizeFromKeyboard = (divider: 0 | 1, event: KeyboardEvent<HTMLDivElement>) => {
    const widths = measuredWidths();
    if (!widths) return;
    const increment = event.shiftKey ? 36 : 12;
    let delta = 0;
    if (event.key === "ArrowLeft") delta = -increment;
    if (event.key === "ArrowRight") delta = increment;
    if (event.key === "Home") delta = -Number.MAX_SAFE_INTEGER;
    if (event.key === "End") delta = Number.MAX_SAFE_INTEGER;
    if (!delta) return;
    event.preventDefault();
    applyPixelWidths(clampPair(widths, divider, delta));
  };

  const resetSizes = () => setSizes(DEFAULT_SIZES);
  const style = {
    "--reader-pane-size": `${sizes[0]}fr`,
    "--chat-pane-size": `${sizes[1]}fr`,
    "--recommendation-pane-size": `${sizes[2]}fr`,
  } as CSSProperties;

  const separator = (divider: 0 | 1, label: string) => (
    <div
      className={`pane-resizer${activeDivider === divider ? " pane-resizer--active" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round((MINIMUM_WIDTHS[divider] / window.innerWidth) * 100)}
      aria-valuemax={85}
      aria-valuenow={Math.round(sizes.slice(0, divider + 1).reduce((sum, size) => sum + size, 0))}
      tabIndex={0}
      title="拖动调整栏宽；双击恢复默认"
      onPointerDown={(event) => beginResize(divider, event)}
      onPointerMove={moveResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={() => {
        dragRef.current = null;
        delete document.body.dataset.paperOceanResizing;
        setActiveDivider(null);
      }}
      onKeyDown={(event) => resizeFromKeyboard(divider, event)}
      onDoubleClick={resetSizes}
    >
      <span aria-hidden="true" />
    </div>
  );

  return (
    <div ref={containerRef} className="workspace-grid" style={style}>
      <div ref={paneRefs[0]} className="workspace-pane reader-pane">{reader}</div>
      {separator(0, "调整论文阅读区与 AI 对话区宽度")}
      <div ref={paneRefs[1]} className="workspace-pane chat-pane">{chat}</div>
      {separator(1, "调整 AI 对话区与论文推荐区宽度")}
      <div ref={paneRefs[2]} className="workspace-pane recommendation-pane">{recommendations}</div>
    </div>
  );
}
