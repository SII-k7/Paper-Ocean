import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowLeft, ArrowRight, Minus, Plus, Waves } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OpenedPaper, PdfPageIndex } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

type PositionedText = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
};

type PageSize = {
  width: number;
  height: number;
};

const CURRENT_PAGE_THRESHOLDS = Array.from({ length: 21 }, (_, index) => index / 20);

export type PdfReaderHandle = {
  capturePage(): string | null;
};

type Props = {
  paper: OpenedPaper | null;
  cachedPages?: PdfPageIndex[];
  currentPage: number;
  onPageChange(page: number): void;
  onIndexed(input: {
    pages: PdfPageIndex[];
    inferredTitle?: string;
    inferredAbstract?: string;
    pageCount: number;
  }): void;
  onSelection(text: string, page: number): void;
};

type PdfPageViewProps = {
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  fallbackSize: PageSize;
  current: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  registerShell(page: number, node: HTMLDivElement | null): void;
  registerCanvas(page: number, node: HTMLCanvasElement | null): void;
  onSelection(text: string, page: number): void;
  onError(message: string): void;
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
  let result = "";
  for (const item of items) {
    const value = item.str?.trim();
    if (!value) continue;
    result += `${value}${item.hasEOL ? "\n" : " "}`;
  }
  return result.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
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
}: PdfPageViewProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [naturalSize, setNaturalSize] = useState(fallbackSize);
  const [textItems, setTextItems] = useState<PositionedText[]>([]);
  const shouldRender = current || nearViewport;

  useEffect(() => {
    registerShell(pageNumber, shellRef.current);
    return () => registerShell(pageNumber, null);
  }, [pageNumber, registerShell]);

  useEffect(() => {
    if (!shouldRender) {
      registerCanvas(pageNumber, null);
      setTextItems([]);
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

    document.getPage(pageNumber).then(async (page) => {
      if (cancelled || !canvasRef.current) return;
      const naturalViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: zoom });
      setNaturalSize({ width: naturalViewport.width, height: naturalViewport.height });

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
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

      const content = await page.getTextContent();
      if (cancelled) return;
      const positioned = content.items.flatMap((item, index) => {
        if (!("str" in item) || !item.str) return [];
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
        }];
      });
      setTextItems(positioned);
      await renderPromise;
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

  const captureSelection = useCallback(() => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (text.length >= 2 && shellRef.current?.contains(selection.anchorNode)) {
        onSelection(text, pageNumber);
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
      >
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
  { paper, cachedPages, currentPage, onPageChange, onIndexed, onSelection },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const shellRefs = useRef(new Map<number, HTMLDivElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const visiblePagesRef = useRef(new Map<number, { visibleHeight: number; centerDistance: number }>());
  const currentPageObserverRef = useRef<IntersectionObserver | null>(null);
  const currentPageRef = useRef(currentPage);
  const initialPageRef = useRef(1);
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

  const paperKey = paper?.id;
  const document = loadedPaperKey === paperKey ? loadedDocument : null;

  onPageChangeRef.current = onPageChange;
  onIndexedRef.current = onIndexed;
  onSelectionRef.current = onSelection;
  currentPageRef.current = currentPage;

  useImperativeHandle(ref, () => ({
    capturePage() {
      return canvasRefs.current.get(currentPageRef.current)?.toDataURL("image/png") ?? null;
    },
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
  const handleSelection = useCallback((text: string, page: number) => {
    onSelectionRef.current(text, page);
  }, []);

  const scrollPageIntoView = useCallback((page: number) => {
    const stage = stageRef.current;
    const shell = shellRefs.current.get(page);
    if (!stage || !shell) return false;
    const stageRect = stage.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    stage.scrollTo({
      top: Math.max(0, stage.scrollTop + shellRect.top - stageRect.top - 12),
      behavior: "auto",
    });
    return true;
  }, []);

  const goToPage = useCallback((requestedPage: number) => {
    const totalPages = document?.numPages ?? 1;
    const page = Math.min(Math.max(Math.round(requestedPage) || 1, 1), totalPages);
    suppressScrollSyncRef.current = true;
    currentPageRef.current = page;
    onPageChangeRef.current(page);
    scrollPageIntoView(page);
    window.requestAnimationFrame(() => {
      suppressScrollSyncRef.current = false;
    });
  }, [document, scrollPageIntoView]);

  useEffect(() => {
    if (!paperData || !paperKey) {
      setLoadedDocument(null);
      setLoadedPaperKey(undefined);
      return;
    }

    let cancelled = false;
    // PDF.js transfers the supplied ArrayBuffer to its worker. Build a fresh
    // byte array for every load so React StrictMode can safely rerun effects.
    const task = pdfjs.getDocument({ data: base64ToBytes(paperData) });
    const targetPage = Math.max(paper?.lastPage ?? 1, 1);
    initialPageRef.current = targetPage;
    initialScrollCompleteRef.current = false;
    shellRefs.current.clear();
    canvasRefs.current.clear();
    setLoading(true);
    setError(null);
    setIndexProgress(0);

    task.promise
      .then(async (nextDocument) => {
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
          setIndexProgress(100);
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
      void task.destroy();
    };
  }, [paperData, paperKey]);

  useEffect(() => {
    if (!document || !fitWidth || !stageRef.current) return;
    let cancelled = false;
    const stage = stageRef.current;

    const updateFit = () => {
      if (cancelled) return;
      const availableWidth = Math.max(stage.clientWidth - 56, 1);
      const nextZoom = Math.min(1.4, Math.max(0.65, availableWidth / fallbackSize.width));
      setZoom((previous) => (Math.abs(previous - nextZoom) >= 0.01 ? nextZoom : previous));
    };

    const observer = new ResizeObserver(updateFit);
    observer.observe(stage);
    updateFit();
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [document, fallbackSize.width, fitWidth]);

  useEffect(() => {
    if (!document) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = Math.min(initialPageRef.current, document.numPages);
        suppressScrollSyncRef.current = true;
        scrollPageIntoView(target);
        currentPageRef.current = target;
        onPageChangeRef.current(target);
        window.requestAnimationFrame(() => {
          initialScrollCompleteRef.current = true;
          suppressScrollSyncRef.current = false;
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [document, scrollPageIntoView]);

  useEffect(() => {
    if (!document) {
      lastZoomRef.current = zoom;
      return;
    }
    if (Math.abs(lastZoomRef.current - zoom) < 0.001) return;
    lastZoomRef.current = zoom;
    if (!initialScrollCompleteRef.current) return;
    suppressScrollSyncRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      scrollPageIntoView(currentPageRef.current);
      window.requestAnimationFrame(() => {
        suppressScrollSyncRef.current = false;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [document, scrollPageIntoView, zoom]);

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
    setZoom((value) => Math.min(2.4, Math.max(0.65, value + delta)));
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
    <section className="pdf-reader" aria-label={`论文阅读器：${paper.title}`}>
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
          <span className="scroll-mode-badge">连续滚动</span>
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

      <div
        ref={stageRef}
        className="pdf-stage"
        role="region"
        aria-label="论文连续滚动阅读区"
        tabIndex={0}
      >
        {(loading || error) && (
          <div
            className={`reader-status ${error ? "reader-status--error" : ""}`}
            role={error ? "alert" : "status"}
            aria-live="polite"
          >
            {error || "正在解析论文…"}
          </div>
        )}
        <div className="pdf-pages">
          {pageNumbers.map((pageNumber) => (
            <PdfPageView
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
            />
          ))}
        </div>
      </div>
    </section>
  );
});

export default PdfReader;
