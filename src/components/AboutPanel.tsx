import { useRef, useState } from "react";
import { Info } from "lucide-react";
import { version } from "../../package.json";
import { checkRelease, RELEASES_URL, type ReleaseInfo } from "../release-info.mjs";

export default function AboutPanel() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [result, setResult] = useState<ReleaseInfo | null>(null), [error, setError] = useState("");
  async function check() {
    if (busy) return;
    setBusy(true); setError("");
    try { setResult(await checkRelease(version)); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="settings-button" aria-label="关于 Paper Ocean 与更新" title="关于与更新" onClick={() => dialog.current?.showModal()}><Info size={17} aria-hidden="true" /></button>
    <dialog className="about-panel" ref={dialog} aria-labelledby="about-heading" onClick={(event) => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.current.close(); } }}>
      <h2 id="about-heading">Paper Ocean <small>v{version}</small></h2>
      <p>沉浸阅读、讨论与研究笔记。</p>
      <p>点击检查时才访问 GitHub。更新由你决定何时下载和安装。</p>
      <div className="about-actions"><button type="button" disabled={busy} onClick={() => void check()}>{busy ? "正在检查…" : "检查更新"}</button><button type="button" onClick={() => void window.paperOcean.openExternal(result?.url || RELEASES_URL)}>查看发布页面</button></div>
      {result && <p role="status">{result.newer ? `发现新版本 v${result.version}` : `最新正式版本为 v${result.version}，当前无需更新。`}<br /><small>上次检查：{new Date(result.checkedAt).toLocaleString()}</small></p>}
      {error && <p role="status">{error}</p>}
      <form method="dialog"><button type="submit">关闭</button></form>
    </dialog>
  </>;
}
