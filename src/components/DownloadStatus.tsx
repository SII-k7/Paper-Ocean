import type { DownloadProgress } from "../types";
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export default function DownloadStatus({ progress, busy, onCancel, onResume, onDismiss }: { progress: DownloadProgress; busy: boolean; onCancel(): void; onResume(): void; onDismiss(): void }) {
  const labels = { metadata: "读取论文信息…", downloading: progress.resumed ? "正在续传" : "正在下载", verifying: "校验 PDF…", preparing: "准备阅读…", complete: "下载完成", paused: "下载已暂停", error: "下载未完成" };
  return <section className="download-status" aria-label="论文下载">
    <div><strong>{labels[progress.phase]}</strong><span>{progress.reference || progress.source}</span><span>{size(progress.received)}{progress.total ? ` / ${size(progress.total)}` : ""}</span></div>
    {busy && <progress aria-label="PDF 下载进度" max={progress.total || 1} value={progress.total ? progress.received : undefined} />}
    {progress.error && <p role="status">{progress.error}</p>}
    <div className="download-actions">{busy ? <button type="button" onClick={onCancel}>暂停下载</button> : <>{progress.phase !== "complete" && <button type="button" onClick={onResume}>继续下载</button>}<button type="button" aria-label="关闭下载提示" onClick={onDismiss}>关闭</button></>}</div>
  </section>;
}
