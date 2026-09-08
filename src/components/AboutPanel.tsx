import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { version } from "../../package.json";
import { checkRelease, RELEASES_URL, type ReleaseInfo } from "../release-info.mjs";
import type { AppUpdateState } from "../types";

export default function AboutPanel() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [result, setResult] = useState<ReleaseInfo | null>(null), [error, setError] = useState("");
  const [update, setUpdate] = useState<AppUpdateState | null>(null);
  const [opened, setOpened] = useState(false);
  const updating = update?.stage === "downloading" || update?.stage === "installing";
  useEffect(() => {
    if (!opened || !window.paperOcean.updates) return;
    let disposed = false;
    const refresh = () => window.paperOcean.updates!.status().then(value => { if (!disposed) setUpdate(value); }).catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [opened]);
  async function check() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const desktop = await window.paperOcean.updates?.status();
      if (desktop?.supported) setUpdate(await window.paperOcean.updates!.check());
      else { if (desktop) setUpdate(desktop); setResult(await checkRelease(version)); }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (busy || updating || !window.paperOcean.updates) return;
    setBusy(true); setError("");
    try { setUpdate(await window.paperOcean.updates.apply()); }
    catch { setError("更新未完成，请重试或查看发布页面。"); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="settings-button" aria-label="关于 Paper Ocean 与更新" title="关于与更新" onClick={() => { setOpened(true); dialog.current?.showModal(); }}><Info size={17} aria-hidden="true" /></button>
    <dialog className="about-panel" ref={dialog} aria-labelledby="about-heading" onClose={() => setOpened(false)} onCancel={event => { if (updating || busy) event.preventDefault(); }} onClick={(event) => { if (!updating && !busy && event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.current.close(); } }}>
      <h2 id="about-heading">Paper Ocean <small>v{version}</small></h2>
      <p>沉浸阅读、讨论与研究笔记。</p>
      <p>{update?.message || "检查更新后可在支持的安装版中直接下载安装。"}</p>
      <div className="about-actions"><button type="button" disabled={busy || updating} onClick={() => void check()}>{update?.stage === "checking" ? "正在检查…" : "检查更新"}</button>
        {update?.supported && update.canUpdate && ["available", "ready", "error"].includes(update.stage) && <button type="button" disabled={busy} onClick={() => void apply()}>{update.stage === "error" ? "重试更新" : "一键更新并重启"}</button>}
        <button type="button" onClick={() => void window.paperOcean.openExternal(result?.url || RELEASES_URL)}>查看发布页面</button></div>
      {update?.supported && <div role="status" aria-live="polite">
        {update.stage === "available" && <p>发现新版本 v{update.version}</p>}
        {update.stage === "current" && <p>当前已是最新正式版本。</p>}
        {update.stage === "downloading" && <><p>正在下载 v{update.version} · {update.percent}%</p><progress aria-label="更新下载进度" value={update.percent} max={100} /></>}
        {update.stage === "installing" && <p>正在保存并安装更新…{update.mode === "deb" ? "请完成系统安装授权。" : "完成后将自动重启。"}</p>}
        {update.error && <p>{update.error}</p>}
      </div>}
      {!update?.supported && result && <p role="status">{result.newer ? `发现新版本 v${result.version}` : `最新正式版本为 v${result.version}，当前无需更新。`}<br /><small>上次检查：{new Date(result.checkedAt).toLocaleString()}</small></p>}
      {error && <p role="status">{error}</p>}
      <form method="dialog"><button type="submit" disabled={busy || updating}>关闭</button></form>
    </dialog>
  </>;
}
