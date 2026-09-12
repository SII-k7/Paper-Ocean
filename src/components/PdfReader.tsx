import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowLeft, ArrowRight, Minus, Plus, Waves, Search, List, Undo2 } from "lucide-react";
import { pdfjs, pdfResourceOptions } from "../pdf-runtime";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { calculateFitZoom, pdfCanvasSize, MAX_PDF_ZOOM, MIN_PDF_ZOOM } from "../pdf-layout.mjs";
import type { EvidenceRect, PaperHighlight, OpenedPaper, PdfPageIndex, ReadingPosition } from "../types";
import { findTextMatches, pageTextWithRanges, resolvePdfDestination, safePdfUrl, type PdfSearchResult } from "../pdf-navigation.mjs";
import PdfNavigationPanel from "./PdfNavigationPanel";

type PositionedText = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
  start: number;
  end: number;
};

type PdfLink = { id: string; rect: number[]; dest?: unknown; url?: string | null; action?: string };
type SearchTarget = PdfSearchResult & { request: number };
const EMPTY_PAGES: PdfPageIndex[] = [];

type PageSize = {
  width: number;
  height: number;
};

const CURRENT_PAGE_THRESHOLDS = Array.from({ length: 21 }, (_, index) => index / 20);
const READING_LINE = 64;

export type PdfReaderHandle = {
  capturePage(paperId: string, page: number): string | null;
  capturePosition(): ReadingPosition | null;
};

type Props = {
  paper: OpenedPaper | null;
  highlights?: PaperHighlight[];
  cachedPages?: PdfPageIndex[];
  currentPage: number;
  readingPosition?: ReadingPosition;
  destination?: { paperId: string; position: ReadingPosition; requestId: number };
  onPositionChange(paperId: string, position: ReadingPosition): void;
  onPageChange(page: number): void;
  onIndexed(input: {
    pages: PdfPageIndex[];
    inferredTitle?: string;
    inferredAbstract?: string;
    pageCount: number;
  }): void;
  onSelection(text: string, page: number, rects: EvidenceRect[]): void;
};

type PdfPageViewProps = {
  highlights: PaperHighlight[];
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  fallbackSize: PageSize;
  current: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  registerShell(page: number, node: HTMLDivElement | null): void;
  registerCanvas(page: number, node: HTMLCanvasElement | null): void;
  onSelection(text: string, page: number, rects: EvidenceRect[]): void;
  onError(message: string): void;
  searchQuery: string;
  searchTarget: SearchTarget | null;
  onSearchReady(target: SearchTarget, node: HTMLElement): void;
  onLink(link: PdfLink): void;
};

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizePageText(items: Array<{ str?: string; hasEOL?: boolean }>) {
  return pageTextWithRanges(items).text.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
}

function inferMetadata(firstPageItems: Array<Record<string, unknown>>) {
  const candidates = firstPageItems
    .filter((item) => typeof item.str === "string" && String(item.str).trim().length >= 5)
    .map((item) => {
      const transform = item.transform as number[] | undefined;
      return {
        text: String(item.str).replace(/\s+/g, " ").trim(),
        size: transform ? Math.hypot(transform[2] ?? 0, transform[3] ?? 0) : 0,
        y: transform?.[5] ?? 0,
      };
    })
    .filter((item) => !/^(arxiv|doi|abstract|preprint|submitted)/i.test(item.text))
    .sort((a, b) => b.size - a.size || b.y - a.y);

  const maxSize = candidates[0]?.size ?? 0;
  const title = candidates
    .filter((item) => item.size >= maxSize * 0.88)
    .slice(0, 3)
    .sort((a, b) => b.y - a.y)
    .map((item) => item.text)
    .join(" ")
    .slice(0, 300);

  const pageText = normalizePageText(firstPageItems as Array<{ str?: string; hasEOL?: boolean }>);
  const abstractMatch = pageText.match(/(?:^|\n|\s)abstract[\s–—-]+([\s\S]{80,2200}?)(?=\n?\s*(?:1\.?\s+)?introduction\b)/i);
  return {
    inferredTitle: title || undefined,
    inferredAbstract: abstractMatch?.[1]?.replace(/\s+/g, " ").trim(),
  };
}

const PdfPageView = memo(function PdfPageView({
  highlights,
  document,
  pageNumber,
  zoom,
  fallbackSize,
  current,
  stageRef,
  registerShell,
  registerCanvas,
  onSelection,
  onError,
  searchQuery,
  searchTarget,
  onSearchReady,
  onLink,
}: PdfPageViewProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [naturalSize, setNaturalSize] = useState(fallbackSize);
  const [textItems, setTextItems] = useState<PositionedText[]>([]);
  const [pageText, setPageText] = useState("");
  const [links, setLinks] = useState<PdfLink[]>([]);
  const shouldRender = current || nearViewport;
  const matches = useMemo(() => findTextMatches(pageText, searchQuery), [pageText, searchQuery]);

  useEffect(() => {
    registerShell(pageNumber, shellRef.current);
    return () => registerShell(pageNumber, null);
  }, [pageNumber, registerShell]);

  useEffect(() => {
    if (!shouldRender) {
      registerCanvas(pageNumber, null);
      setTextItems([]);
      setPageText(""); setLinks([]);
      return;
    }
    registerCanvas(pageNumber, canvasRef.current);
    return () => registerCanvas(pageNumber, null);
  }, [pageNumber, registerCanvas, shouldRender]);

  useEffect(() => {
    const shell = shellRef.current;
    const stage = stageRef.current;
    if (!shell || !stage) return;

    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { root: stage, rootMargin: "1100px 0px", threshold: 0 },
    );
    observer.observe(shell);
    return () => observer.disconnect();
  }, [stageRef]);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;

    // A document can be disposed between the render and passive effect.
    // Defer the call so a synchronous PDF.js disposal error is also caught.
    Promise.resolve().then(() => cancelled ? null : document.getPage(pageNumber)).then(async (page) => {
      if (!page) return;
      if (cancelled || !canvasRef.current) return;
      const naturalViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: zoom });
      setNaturalSize({ width: naturalViewport.width, height: naturalViewport.height });

      const bitmap = pdfCanvasSize(viewport.width, viewport.height, window.devicePixelRatio);
      const ratio = bitmap.ratio;
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;

      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTask = task;
      const renderPromise = task.promise.catch((reason) => {
        if (reason?.name === "RenderingCancelledException") return;
        throw reason;
      });

      const [content] = await Promise.all([page.getTextContent(), renderPromise]);
      if (cancelled) return;
      const text = pageTextWithRanges(content.items.map((item) => "str" in item ? item : {}));
      const ranges = new Map(text.ranges.map((range) => [range.index, range]));
      setPageText(text.text);
      const positioned = content.items.flatMap((item, index) => {
        if (!("str" in item) || !item.str || !ranges.has(index)) return [];
        const transform = pdfjs.Util.transform(viewport.transform, item.transform);
        const height = Math.max(4, Math.hypot(transform[2], transform[3]));
        return [{
          id: `${pageNumber}-${index}`,
          text: item.str,
          left: transform[4],
          top: transform[5] - height,
          width: Math.max(item.width * zoom, 2),
          height,
          angle: Math.atan2(transform[1], transform[0]),
          start: ranges.get(index)!.start,
          end: ranges.get(index)!.end,
        }];
      });
      setTextItems(positioned);
      const annotations = await page.getAnnotations({ intent: "display" });
      if (!cancelled) setLinks(annotations.flatMap((annotation) => {
        if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect) || annotation.rect.length !== 4 || !annotation.rect.every(Number.isFinite)) return [];
        const url = safePdfUrl(annotation.url);
        const action = ["NextPage", "PrevPage", "FirstPage", "LastPage", "GoBack"].includes(annotation.action) ? annotation.action : undefined;
        if (!annotation.dest && !url && !action) return [];
        const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
        return [{ id: String(annotation.id), rect: [x1, y1, x2, y2], dest: annotation.dest, url, action }];
      }));
    }).catch((reason) => {
      if (!cancelled && reason?.name !== "RenderingCancelledException") {
        onError(reason instanceof Error ? reason.message : String(reason));
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, onError, pageNumber, shouldRender, zoom]);

  useEffect(() => {
    if (searchTarget?.page !== pageNumber || !textItems.length) return;
    const node = shellRef.current?.querySelector<HTMLElement>(`[data-search-occurrence="${searchTarget.occurrence}"]`);
    if (node) onSearchReady(searchTarget, node);
  }, [searchTarget, pageNumber, textItems, matches, onSearchReady]);

  const captureSelection = useCallback(() => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      let text = selection.toString().replace(/\s+/g, " ").trim();
      const page = shellRef.current?.querySelector(".pdf-page");
      if (!page?.contains(selection.anchorNode)) return;
      if (!page.contains(selection.focusNode)) {
        onSelection("", pageNumber, []);
        return;
      }
      if (text.length >= 2 && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        let lastTop: number | undefined;
        let reconstructed = "";
        for (const span of page.querySelectorAll<HTMLElement>(".pdf-text-layer span")) {
          if (!range.intersectsNode(span) || !span.firstChild) continue;
          const node = span.firstChild;
          const part = (node.textContent ?? "").slice(range.startContainer === node ? range.startOffset : 0, range.endContainer === node ? range.endOffset : undefined);
          if (!part) continue;
          const rect = span.getBoundingClientRect();
          if (lastTop !== undefined && Math.abs(lastTop - rect.top) > rect.height * .6) reconstructed += " ";
          reconstructed += part;
          lastTop = rect.top;
        }
        text = reconstructed.replace(/\s+/g, " ").trim() || text;
        const bounds = page.getBoundingClientRect();
        const rects = Array.from(range.getClientRects()).flatMap((rect) => {
          const left = Math.max(rect.left, bounds.left), top = Math.max(rect.top, bounds.top);
          const right = Math.min(rect.right, bounds.right), bottom = Math.min(rect.bottom, bounds.bottom);
          return right > left && bottom > top ? [{ x: (left - bounds.left) / bounds.width, y: (top - bounds.top) / bounds.height, width: (right - left) / bounds.width, height: (bottom - top) / bounds.height }] : [];
        });
        onSelection(text, pageNumber, rects);
      }
    }, 0);
  }, [onSelection, pageNumber]);

  const pageSize = {
    width: naturalSize.width * zoom,
    height: naturalSize.height * zoom,
  };

  return (
    <div
      ref={shellRef}
      className={`pdf-page-shell${current ? " pdf-page-shell--current" : ""}`}
      data-page-number={pageNumber}
      role="document"
      aria-label={`论文第 ${pageNumber} 页`}
      aria-current={current ? "page" : undefined}
    >
      <div className="pdf-page-label" aria-hidden="true">第 {pageNumber} 页</div>
      <div
        className="pdf-page"
        style={{ width: pageSize.width, height: pageSize.height }}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        <div className="pdf-highlights" aria-hidden="true">
          {highlights.flatMap((highlight) => highlight.rects.map((rect, index) => <span key={`${highlight.id}:${index}`} className={`pdf-highlight pdf-highlight--${highlight.color}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />))}
        </div>
        <div className="pdf-search-highlights" aria-hidden="true">{matches.flatMap((match, occurrence) => textItems.flatMap((item) => {
          const start = Math.max(match.start, item.start), end = Math.min(match.end, item.end);
          if (end <= start) return [];
          const fraction = (start - item.start) / (item.end - item.start);
          return [<i key={`${occurrence}:${item.id}`} data-search-occurrence={occurrence} className={searchTarget?.page === pageNumber && searchTarget.occurrence === occurrence ? "active" : ""} style={{ left: item.left + Math.cos(item.angle) * item.width * fraction, top: item.top + Math.sin(item.angle) * item.width * fraction, width: item.width * (end - start) / (item.end - item.start), height: item.height, transform: `rotate(${item.angle}rad)`, transformOrigin: "0 0" }} />];
        }))}</div>
        {shouldRender ? (
          <>
            <canvas ref={canvasRef} />
            <div className="pdf-text-layer" aria-label={`第 ${pageNumber} 页文本层`} role="group">
              {textItems.map((item) => (
                <span
                  key={item.id}
                  style={{
                    left: item.left,
                    top: item.top,
                    width: item.width,
                    height: item.height,
                    fontSize: item.height,
                    transform: `rotate(${item.angle}rad)`,
                    transformOrigin: "0 0",
                  }}
                >{item.text}</span>
              ))}
            </div>
            <div className="pdf-link-layer">{links.map((link) => <button type="button" key={link.id} aria-label={link.url ? `打开链接 ${link.url}` : "跳转到 PDF 引用位置"} title={link.url || "跳转到 PDF 引用位置"} onClick={() => onLink(link)} style={{ left: Math.min(link.rect[0], link.rect[2]), top: Math.min(link.rect[1], link.rect[3]), width: Math.abs(link.rect[2] - link.rect[0]), height: Math.abs(link.rect[3] - link.rect[1]) }} />)}</div>
          </>
        ) : (
          <div
            className="pdf-page__placeholder"
            role="status"
            aria-label={`第 ${pageNumber} 页等待渲染`}
          />
        )}
      </div>
    </div>
  );
});

const PdfReader = forwardRef<PdfReaderHandle, Props>(function PdfReader(
  { paper, highlights = [], cachedPages, currentPage, readingPosition, destination, onPositionChange, onPageChange, onIndexed, onSelection },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const shellRefs = useRef(new Map<number, HTMLDivElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const visiblePagesRef = useRef(new Map<number, { visibleHeight: number; centerDistance: number }>());
  const currentPageObserverRef = useRef<IntersectionObserver | null>(null);
  const currentPageRef = useRef(currentPage);
  const initialPageRef = useRef(1);
  const positionRef = useRef<ReadingPosition | null>(null);
  const onPositionChangeRef = useRef(onPositionChange);
  const initialScrollCompleteRef = useRef(false);
  const suppressScrollSyncRef = useRef(false);
  const lastZoomRef = useRef(1.15);
  const onPageChangeRef = useRef(onPageChange);
  const onIndexedRef = useRef(onIndexed);
  const onSelectionRef = useRef(onSelection);
  const [loadedDocument, setLoadedDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadedPaperKey, setLoadedPaperKey] = useState<string>();
  const [fallbackSize, setFallbackSize] = useState<PageSize>({ width: 612, height: 792 });
  const [zoom, setZoom] = useState(1.15);
  const [fitWidth, setFitWidth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [indexProgress, setIndexProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<"search" | "outline" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const [indexedPages, setIndexedPages] = useState<PdfPageIndex[]>(EMPTY_PAGES);
  const [backPositions, setBackPositions] = useState<ReadingPosition[]>([]);
  const searchRequestRef = useRef(0);
  const appliedSearchRef = useRef(0);
  const linkRequestRef = useRef(0);
  const navigationOpenerRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef({ zoom, fitWidth });
  viewRef.current = { zoom, fitWidth };

  const paperKey = paper?.id;
  const document = loadedPaperKey === paperKey ? loadedDocument : null;
  const displayedPaperRef = useRef<string | undefined>(undefined);
  displayedPaperRef.current = document ? paperKey : undefined;

  onPageChangeRef.current = onPageChange;
  onIndexedRef.current = onIndexed;
  onSelectionRef.current = onSelection;
  onPositionChangeRef.current = onPositionChange;
  currentPageRef.current = currentPage;

  useImperativeHandle(ref, () => ({
    capturePage(paperId, page) {
      if (displayedPaperRef.current !== paperId) return null;
      return canvasRefs.current.get(page)?.toDataURL("image/png") ?? null;
    },
    capturePosition() { return positionRef.current; },
  }), []);

  const paperData = paper?.dataBase64;

  const syncCurrentPageFromVisibility = useCallback(() => {
    if (suppressScrollSyncRef.current || !initialScrollCompleteRef.current) return;

    let bestPage = currentPageRef.current;
    let bestVisibleHeight = -1;
    let nearestCenter = Number.POSITIVE_INFINITY;
    for (const [page, visibility] of visiblePagesRef.current) {
      if (
        visibility.visibleHeight > bestVisibleHeight
        || (
          Math.abs(visibility.visibleHeight - bestVisibleHeight) < 0.5
          && visibility.centerDistance < nearestCenter
        )
      ) {
        bestPage = page;
        bestVisibleHeight = visibility.visibleHeight;
        nearestCenter = visibility.centerDistance;
      }
    }

    if (bestVisibleHeight >= 0 && bestPage !== currentPageRef.current) {
      currentPageRef.current = bestPage;
      onPageChangeRef.current(bestPage);
    }
  }, []);

  const registerShell = useCallback((page: number, node: HTMLDivElement | null) => {
    const previous = shellRefs.current.get(page);
    if (previous && previous !== node) currentPageObserverRef.current?.unobserve(previous);

    if (node) {
      shellRefs.current.set(page, node);
      currentPageObserverRef.current?.observe(node);
    } else {
      shellRefs.current.delete(page);
      visiblePagesRef.current.delete(page);
    }
  }, []);

  const registerCanvas = useCallback((page: number, node: HTMLCanvasElement | null) => {
    if (node) canvasRefs.current.set(page, node);
    else canvasRefs.current.delete(page);
  }, []);

  const handleRenderError = useCallback((message: string) => setError(message), []);
  const handleSelection = useCallback((text: string, page: number, rects: EvidenceRect[]) => {
    onSelectionRef.current(text, page, rects);
  }, []);

  const scrollPageIntoView = useCallback((page: number) => {
    const stage = stageRef.current;
    const shell = shellRefs.current.get(page);
    if (!stage || !shell) return false;
    const stageRect = stage.getBoundingClientRect();
    const shellRect = (shell.querySelector(".pdf-page") ?? shell).getBoundingClientRect();
    stage.scrollTo({
      top: Math.max(0, stage.scrollTop + shellRect.top - stageRect.top - READING_LINE),
      behavior: "auto",
    });
    return true;
  }, []);

  const restorePosition = useCallback((position: ReadingPosition) => {
    const stage = stageRef.current;
    const shell = shellRefs.current.get(position.page);
    if (!stage || !shell || !stage.clientHeight) return;
    const outer = stage.getBoundingClientRect();
    const rect = (shell.querySelector(".pdf-page") ?? shell).getBoundingClientRect();
    stage.scrollTo({
      top: Math.max(0, stage.scrollTop + rect.top - outer.top + rect.height * position.y - READING_LINE),
      left: Math.max(0, stage.scrollLeft + rect.left - outer.left + rect.width * position.x - stage.clientWidth / 2),
      behavior: "auto",
    });
  }, []);

  const readPosition = useCallback((): ReadingPosition | null => {
    const stage = stageRef.current;
    if (!stage || !stage.clientHeight || !initialScrollCompleteRef.current) return null;
    const outer = stage.getBoundingClientRect();
    const shells = [...shellRefs.current.entries()];
    const visible = shells.find(([, shell]) => shell.getBoundingClientRect().bottom > outer.top + READING_LINE);
    if (!visible) return null;
    const [page, shell] = visible;
    const rect = (shell.querySelector(".pdf-page") ?? shell).getBoundingClientRect();
    if (!rect.height || !rect.width) return null;
    return {
      page, y: Math.max(0, Math.min(1, (outer.top + READING_LINE - rect.top) / rect.height)),
      x: Math.max(0, Math.min(1, (outer.left + stage.clientWidth / 2 - rect.left) / rect.width)),
      ...viewRef.current,
    };
  }, []);

  const recordPosition = useCallback(() => {
    if (!paperKey || suppressScrollSyncRef.current) return;
    const next = readPosition();
    if (!next) return;
    positionRef.current = next;
    onPositionChangeRef.current(paperKey, next);
  }, [paperKey, readPosition]);

  useEffect(() => {
    window.addEventListener("paper-ocean-before-save", recordPosition);
    return () => window.removeEventListener("paper-ocean-before-save", recordPosition);
  }, [recordPosition]);

  const goToPage = useCallback((requestedPage: number) => {
    const totalPages = document?.numPages ?? 1;
    const page = Math.min(Math.max(Math.round(requestedPage) || 1, 1), totalPages);
    suppressScrollSyncRef.current = true;
    currentPageRef.current = page;
    onPageChangeRef.current(page);
    scrollPageIntoView(page);
    positionRef.current = { page, y: 0, x: 0.5, zoom, fitWidth };
    if (paperKey) onPositionChangeRef.current(paperKey, positionRef.current);
    window.requestAnimationFrame(() => {
      suppressScrollSyncRef.current = false;
    });
  }, [document, scrollPageIntoView, paperKey, zoom, fitWidth]);

  const rememberNavigation = useCallback(() => {
    const actual = readPosition() ?? positionRef.current;
    if (actual) {
      const current = { ...actual };
      setBackPositions((positions) => [...positions.slice(-19), current]);
    }
  }, [readPosition]);

  const goToPosition = useCallback((position: ReadingPosition) => {
    suppressScrollSyncRef.current = true;
    positionRef.current = position;
    currentPageRef.current = position.page;
    onPageChangeRef.current(position.page);
    restorePosition(position);
    if (paperKey) onPositionChangeRef.current(paperKey, position);
    requestAnimationFrame(() => { suppressScrollSyncRef.current = false; });
  }, [paperKey, restorePosition]);

  const goBack = useCallback(() => {
    const position = backPositions.at(-1);
    if (!position) return;
    linkRequestRef.current++;
    setSearchTarget(null);
    setBackPositions((positions) => positions.slice(0, -1));
    goToPosition({ ...position, ...viewRef.current });
  }, [backPositions, goToPosition]);

  const openDestination = useCallback((destination: unknown) => {
    if (!document) return;
    const request = ++linkRequestRef.current;
    void resolvePdfDestination(document, destination).then((position) => {
      if (request !== linkRequestRef.current) return;
      rememberNavigation(); setSearchTarget(null);
      goToPosition({ ...position, ...viewRef.current });
    }).catch((reason) => { if (request === linkRequestRef.current) setError(reason instanceof Error ? reason.message : String(reason)); });
  }, [document, rememberNavigation, goToPosition]);

  const openExternal = useCallback((url: string) => {
    void window.paperOcean.openExternal(url).catch((reason) => setError(String(reason)));
  }, []);
  const handleLink = useCallback((link: PdfLink) => {
    if (link.dest) openDestination(link.dest);
    else if (link.url) openExternal(link.url);
    else if (link.action === "GoBack") goBack();
    else if (link.action) {
      rememberNavigation();
      goToPage(link.action === "FirstPage" ? 1 : link.action === "LastPage" ? document?.numPages ?? 1 : currentPageRef.current + (link.action === "NextPage" ? 1 : -1));
    }
  }, [openDestination, openExternal, goBack, rememberNavigation, goToPage, document]);

  const handleSearch = useCallback((query: string, result: PdfSearchResult | null) => {
    setSearchQuery(query);
    if (!result) { setSearchTarget(null); return; }
    rememberNavigation();
    goToPage(result.page);
    setSearchTarget({ ...result, request: ++searchRequestRef.current });
  }, [rememberNavigation, goToPage]);

  const handleSearchReady = useCallback((target: SearchTarget, node: HTMLElement) => {
    const stage = stageRef.current;
    if (!stage || appliedSearchRef.current === target.request) return;
    appliedSearchRef.current = target.request;
    const page = node.closest(".pdf-page")?.getBoundingClientRect(), rect = node.getBoundingClientRect();
    if (!page?.width || !page.height) return;
    goToPosition({ page: target.page, y: Math.max(0, Math.min(1, (rect.top - page.top - 24) / page.height)), x: Math.max(0, Math.min(1, (rect.left - page.left + rect.width / 2) / page.width)), ...viewRef.current });
  }, [goToPosition]);

  const closeNavigation = () => { setNavigation(null); setSearchQuery(""); setSearchTarget(null); navigationOpenerRef.current?.focus(); };
  const openNavigation = (mode: "search" | "outline", opener: HTMLElement) => {
    navigationOpenerRef.current = opener;
    if (navigation === mode) closeNavigation(); else setNavigation(mode);
  };

  useEffect(() => {
    if (!paperData || !paperKey) {
      setLoadedDocument(null);
      setLoadedPaperKey(undefined);
      return;
    }

    let cancelled = false;
    // PDF.js transfers the supplied ArrayBuffer to its worker. Build a fresh
    // byte array for every load so React StrictMode can safely rerun effects.
    const task = pdfjs.getDocument({ ...pdfResourceOptions(), data: base64ToBytes(paperData) });
    const savedPosition = readingPosition ?? { page: paper?.lastPage ?? 1, y: 0, x: 0.5, zoom: 1.15, fitWidth: true };
    positionRef.current = savedPosition;
    setFitWidth(savedPosition.fitWidth);
    setZoom(savedPosition.zoom);
    const targetPage = Math.max(savedPosition.page, 1);
    initialPageRef.current = targetPage;
    initialScrollCompleteRef.current = false;
    shellRefs.current.clear();
    canvasRefs.current.clear();
    setLoading(true);
    setError(null);
    setIndexProgress(0);
    setIndexedPages(EMPTY_PAGES); setNavigation(null); setSearchQuery(""); setSearchTarget(null); setBackPositions([]);
    linkRequestRef.current++;

    task.promise
      .then(async (nextDocument) => {
        if (cancelled) return;
        const firstPage = await nextDocument.getPage(1);
        if (cancelled) return;
        const firstViewport = firstPage.getViewport({ scale: 1 });
        const boundedTarget = Math.min(targetPage, nextDocument.numPages);
        setFallbackSize({ width: firstViewport.width, height: firstViewport.height });
        setLoadedPaperKey(paperKey);
        setLoadedDocument(nextDocument);
        currentPageRef.current = boundedTarget;
        onPageChangeRef.current(boundedTarget);

        if (cachedPages?.length === nextDocument.numPages) {
          setIndexedPages(cachedPages);
          setIndexProgress(100);
          onIndexedRef.current({ pages: cachedPages, pageCount: nextDocument.numPages });
          return;
        }

        const pages: PdfPageIndex[] = [];
        let firstPageItems: Array<Record<string, unknown>> = [];
        for (let pageNumber = 1; pageNumber <= nextDocument.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await nextDocument.getPage(pageNumber);
          const content = await page.getTextContent();
          const items = content.items.filter((item) => "str" in item) as Array<Record<string, unknown>>;
          if (pageNumber === 1) firstPageItems = items;
          pages.push({
            page: pageNumber,
            text: normalizePageText(items as Array<{ str?: string; hasEOL?: boolean }>),
          });
          setIndexProgress(Math.round((pageNumber / nextDocument.numPages) * 100));
        }

        if (!cancelled) {
          setIndexedPages(pages);
          onIndexedRef.current({ pages, ...inferMetadata(firstPageItems), pageCount: nextDocument.numPages });
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      linkRequestRef.current++;
      void task.destroy().catch(() => undefined);
    };
  }, [paperData, paperKey]);

  useEffect(() => {
    if (!document || !fitWidth || !stageRef.current) return;
    let cancelled = false;
    let frame = 0;
    const stage = stageRef.current;

    const updateFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        const style = window.getComputedStyle(stage);
        const nextZoom = calculateFitZoom({
          stageWidth: stage.clientWidth,
          paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
          paddingRight: Number.parseFloat(style.paddingRight) || 0,
          pageWidth: fallbackSize.width,
        });
        setZoom((previous) => (Math.abs(previous - nextZoom) >= 0.01 ? nextZoom : previous));
      });
    };

    const observer = new ResizeObserver(updateFit);
    observer.observe(stage);
    updateFit();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [document, fallbackSize.width, fitWidth]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    const frames = new Set<number>();
    const afterLayout = (callback: () => void) => {
      const frame = window.requestAnimationFrame(() => { frames.delete(frame); if (!cancelled) callback(); });
      frames.add(frame);
    };
    afterLayout(() => {
      afterLayout(() => {
        const requested = destination && destination.paperId === paperKey ? destination.position : positionRef.current;
        const target = Math.min(requested?.page ?? initialPageRef.current, document.numPages);
        suppressScrollSyncRef.current = true;
        const next = { ...requested!, page: target, zoom, fitWidth };
        positionRef.current = next;
        restorePosition(next);
        currentPageRef.current = target;
        onPageChangeRef.current(target);
        afterLayout(() => {
          const settled = { ...next, ...viewRef.current };
          positionRef.current = settled;
          restorePosition(settled);
          initialScrollCompleteRef.current = true;
          afterLayout(() => { suppressScrollSyncRef.current = false; });
          if (paperKey) onPositionChangeRef.current(paperKey, settled);
        });
      });
    });
    return () => {
      cancelled = true;
      frames.forEach(frame => window.cancelAnimationFrame(frame));
    };
  }, [document, destination, paperKey, restorePosition]);

  useEffect(() => {
    const pages = stageRef.current?.querySelector(".pdf-pages");
    if (!document || !pages) return;
    const observer = new ResizeObserver(() => {
      if (!initialScrollCompleteRef.current || !positionRef.current) return;
      suppressScrollSyncRef.current = true;
      restorePosition(positionRef.current);
      requestAnimationFrame(() => { suppressScrollSyncRef.current = false; });
    });
    observer.observe(pages);
    return () => observer.disconnect();
  }, [document, restorePosition]);

  useLayoutEffect(() => {
    if (!document) {
      lastZoomRef.current = zoom;
      return;
    }
    if (Math.abs(lastZoomRef.current - zoom) < 0.001) return;
    lastZoomRef.current = zoom;
    if (!initialScrollCompleteRef.current) return;
    suppressScrollSyncRef.current = true;
    const position = positionRef.current;
    if (position) {
      const next = { ...position, zoom, fitWidth };
      positionRef.current = next;
      restorePosition(next);
      if (paperKey) onPositionChangeRef.current(paperKey, next);
    }
    const frame = window.requestAnimationFrame(() => { suppressScrollSyncRef.current = false; });
    return () => window.cancelAnimationFrame(frame);
  }, [document, restorePosition, paperKey, zoom, fitWidth]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !document) return;

    visiblePagesRef.current.clear();
    const observer = new IntersectionObserver((entries) => {
      const fallbackRoot = stage.getBoundingClientRect();
      const rootBounds = entries[0]?.rootBounds ?? fallbackRoot;
      const rootCenter = (rootBounds.top + rootBounds.bottom) / 2;

      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.pageNumber);
        if (!Number.isFinite(page)) continue;
        if (!entry.isIntersecting || entry.intersectionRect.height <= 0) {
          visiblePagesRef.current.delete(page);
          continue;
        }
        visiblePagesRef.current.set(page, {
          visibleHeight: entry.intersectionRect.height,
          centerDistance: Math.abs(
            (entry.boundingClientRect.top + entry.boundingClientRect.bottom) / 2 - rootCenter,
          ),
        });
      }

      syncCurrentPageFromVisibility();
    }, {
      root: stage,
      threshold: CURRENT_PAGE_THRESHOLDS,
    });

    currentPageObserverRef.current = observer;
    for (const shell of shellRefs.current.values()) observer.observe(shell);

    return () => {
      observer.disconnect();
      if (currentPageObserverRef.current === observer) currentPageObserverRef.current = null;
      visiblePagesRef.current.clear();
    };
  }, [document, syncCurrentPageFromVisibility]);

  const updateZoom = (delta: number) => {
    setFitWidth(false);
    setZoom((value) => Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, value + delta)));
  };

  if (!paper) {
    return (
      <section className="empty-reader" aria-label="论文阅读器空状态">
        <div className="empty-reader__icon" aria-hidden="true">
          <Waves size={38} strokeWidth={1.4} />
        </div>
        <h2>从一篇论文出发</h2>
        <p>打开本地 PDF，或在顶部粘贴 arXiv 链接。</p>
      </section>
    );
  }

  const pageNumbers = document
    ? Array.from({ length: document.numPages }, (_, index) => index + 1)
    : [];

  return (
    <section className="pdf-reader" aria-label={`论文阅读器：${paper.title}`} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); navigationOpenerRef.current = event.target as HTMLElement; setNavigation("search"); }
      if (event.key === "Escape" && navigation) { event.preventDefault(); closeNavigation(); }
    }}>
      <div className="panel-toolbar pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具栏">
        <div className="page-controls" role="group" aria-label="翻页与页码跳转">
          <button
            type="button"
            aria-label="上一页"
            title="上一页"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span>
            <input
              aria-label="当前页"
              type="number"
              min={1}
              max={document?.numPages ?? 1}
              value={currentPage}
              onChange={(event) => goToPage(Number(event.target.value))}
            />
            / {document?.numPages ?? "—"}
          </span>
          <button
            type="button"
            aria-label="下一页"
            title="下一页"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= (document?.numPages ?? 1)}
          >
            <ArrowRight size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button type="button" aria-label="查找 PDF" title="全文查找（Ctrl/⌘ F）" aria-pressed={navigation === "search"} onClick={(event) => openNavigation("search", event.currentTarget)}><Search size={14} /></button>
          <button type="button" aria-label="打开 PDF 目录" aria-pressed={navigation === "outline"} onClick={(event) => openNavigation("outline", event.currentTarget)}><List size={14} /></button>
          <button type="button" aria-label="返回 PDF 跳转前的位置" title="返回跳转前的位置" disabled={!backPositions.length} onClick={goBack}><Undo2 size={14} /></button>
        </div>
        <div className="zoom-controls" role="group" aria-label="缩放控制">
          <button
            type="button"
            aria-label="缩小 PDF"
            title="缩小"
            onClick={() => updateZoom(-0.1)}
          >
            <Minus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span aria-live="polite" aria-label={`当前缩放 ${Math.round(zoom * 100)}%`}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className={fitWidth ? "active" : undefined}
            onClick={() => setFitWidth(true)}
            title="适合栏宽"
            aria-label="缩放到适合栏宽"
            aria-pressed={fitWidth}
          >
            适宽
          </button>
          <button
            type="button"
            aria-label="放大 PDF"
            title="放大"
            onClick={() => updateZoom(0.1)}
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        {indexProgress > 0 && indexProgress < 100 && (
          <span
            className="index-progress"
            role="progressbar"
            aria-label="全文索引进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indexProgress}
          >
            索引 {indexProgress}%
          </span>
        )}
      </div>

        {(loading || error) && (
          <div
            className={`reader-status ${error ? "reader-status--error" : ""}`}
            role={error ? "alert" : "status"}
            aria-live="polite"
          >
            {error || "正在解析论文…"}
          </div>
        )}
      <div className="pdf-reader-body">
      {navigation && <PdfNavigationPanel key={paperKey} document={document} pages={indexedPages} mode={navigation} onClose={closeNavigation} onSearch={handleSearch} onDestination={openDestination} onExternal={openExternal} />}
      <div
        ref={stageRef}
        className="pdf-stage"
        role="region"
        aria-label="论文连续滚动阅读区"
        tabIndex={0}
        onScroll={recordPosition}
      >
        <div className="pdf-pages">
          {pageNumbers.map((pageNumber) => (
            <PdfPageView
              highlights={highlights.filter((item) => item.page === pageNumber && !item.archivedAt)}
              key={`${paperKey}-${pageNumber}`}
              document={document!}
              pageNumber={pageNumber}
              zoom={zoom}
              fallbackSize={fallbackSize}
              current={pageNumber === currentPage}
              stageRef={stageRef}
              registerShell={registerShell}
              registerCanvas={registerCanvas}
              onSelection={handleSelection}
              onError={handleRenderError}
              searchQuery={searchQuery}
              searchTarget={searchTarget}
              onSearchReady={handleSearchReady}
              onLink={handleLink}
            />
          ))}
        </div>
      </div>
      </div>
    </section>
  );
});

export default PdfReader;
