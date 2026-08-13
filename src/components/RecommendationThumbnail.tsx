import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

type Props = {
  arxivId?: string;
  title: string;
  generation: string;
};

type State =
  | { status: "idle" | "loading" | "missing" }
  | { status: "ready"; imageUrl: string };

type PreviewJob = {
  generation: number;
  order: number;
  task: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

const MAX_ACTIVE_PREVIEWS = 2;
const previewJobs: PreviewJob[] = [];
let activePreviews = 0;
let activeGenerationKey = "";
let generationSerial = 0;
let jobSerial = 0;

function drainPreviewQueue() {
  while (activePreviews < MAX_ACTIVE_PREVIEWS && previewJobs.length) {
    previewJobs.sort((left, right) => (
      right.generation - left.generation || left.order - right.order
    ));
    const job = previewJobs.shift();
    if (!job) return;
    activePreviews += 1;
    void job.task().then(job.resolve, job.reject).finally(() => {
      activePreviews -= 1;
      drainPreviewQueue();
    });
  }
}

function enqueuePreview<T>(generationKey: string, task: () => Promise<T>) {
  if (generationKey !== activeGenerationKey) {
    activeGenerationKey = generationKey;
    generationSerial += 1;
  }
  const generation = generationSerial;
  return new Promise<T>((resolve, reject) => {
    previewJobs.push({
      generation,
      order: jobSerial += 1,
      task,
      resolve: (value) => resolve(value as T),
      reject,
    });
    drainPreviewQueue();
  });
}

async function renderFirstPage(pdfUrl: string) {
  const loadingTask = pdfjs.getDocument({
    url: pdfUrl,
    disableAutoFetch: true,
    disableStream: true,
  });
  let document: pdfjs.PDFDocumentProxy | undefined;
  try {
    document = await loadingTask.promise;
    const page = await document.getPage(1);
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1, 280 / original.width) });
    const canvas = window.document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建缩略图画布");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const webp = canvas.toDataURL("image/webp", 0.72);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    await document?.cleanup().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
  }
}

export default function RecommendationThumbnail({ arxivId, title, generation }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });

  useEffect(() => {
    const node = rootRef.current;
    if (!node || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "500px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !arxivId) {
      if (!arxivId) setState({ status: "missing" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    void enqueuePreview(generation, async () => {
      if (cancelled) return;
      try {
        const preview = await window.paperOcean.prepareRecommendationPreview(arxivId);
        if (cancelled) return;
        if (preview.status === "ready") {
          setState({ status: "ready", imageUrl: preview.imageUrl });
          return;
        }
        if (preview.status !== "render") {
          setState({ status: "missing" });
          return;
        }
        const dataUrl = await renderFirstPage(preview.pdfUrl);
        if (cancelled) return;
        const imageUrl = await window.paperOcean.saveRecommendationThumbnail({ arxivId, dataUrl });
        if (!cancelled) setState({ status: "ready", imageUrl });
      } catch {
        if (!cancelled) setState({ status: "missing" });
      }
    });

    return () => { cancelled = true; };
  }, [arxivId, generation, visible]);

  return (
    <div
      ref={rootRef}
      className={`recommendation-thumbnail recommendation-thumbnail--${state.status}`}
      aria-hidden="true"
      title={`${title} 首页预览`}
    >
      {state.status === "ready" ? (
        <img src={state.imageUrl} alt="" loading="lazy" decoding="async" />
      ) : state.status === "missing" ? (
        <FileText size={22} strokeWidth={1.4} />
      ) : (
        <div className="recommendation-thumbnail__skeleton" />
      )}
    </div>
  );
}
