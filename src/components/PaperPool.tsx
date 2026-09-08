import { useEffect, useRef, useState } from "react";
import type { PaperRecord, PoolState } from "../types";
const messageFor = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export default function PaperPool({ papers, onOpen }: { papers: PaperRecord[]; onOpen(id: string): Promise<boolean> }) {
  const [state, setState] = useState<PoolState>(), [query, setQuery] = useState(""), [filter, setFilter] = useState("seen");
  const [url, setUrl] = useState(""), [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const initialized = useRef(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => window.paperOcean.pool?.status().then(result => { if (!alive) return; setState(result); if (!initialized.current) { setUrl(result.url); setUsername(result.username); initialized.current = true; } }).catch(reason => { if(alive) setError(String(reason)); });
    void refresh(); const timer = setInterval(()=>void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  async function run(action: () => Promise<PoolState>) {
    setBusy(true); setError("");
    try { setState(await action()); setPassword(""); } catch(reason) { setError(messageFor(reason)); }
    finally { setBusy(false); }
  }
  if (!window.paperOcean.pool) return <p className="pool-intro">请在桌面版打开论文池；网页预览仍使用独立的本机资料库。</p>;
  const rows = (state?.papers || []).filter(paper => (filter !== "asked" || paper.askedAt > 0) && `${paper.title} ${paper.authors.join(" ")} ${paper.arxivId || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b) => Math.max(b.seenAt,b.askedAt)-Math.max(a.seenAt,a.askedAt));
  return <div className="paper-pool">
    <p className="pool-intro">两台电脑共享看过、问过的论文清单。只同步标题、作者、来源和历史标记，不传 PDF、问答正文或 Codex 登录凭据。</p>
    <div className="library-filters">
      <input aria-label="搜索论文池" placeholder="搜索看过的论文…" value={query} onChange={event=>setQuery(event.target.value)} />
      <select aria-label="论文池筛选" value={filter} onChange={event=>setFilter(event.target.value)}><option value="seen">看过的论文</option><option value="asked">问过的论文</option></select>
      <button type="button" disabled={busy} onClick={()=>void run(()=>window.paperOcean.pool!.sync())}>{busy ? "同步中…" : "立即同步"}</button>
    </div>
    <p className="pool-status" role="status">{error || state?.error || (state?.syncing ? "正在同步，本机阅读不受影响…" : state?.configured ? state.lastSync ? `上次同步：${new Date(state.lastSync).toLocaleString()}` : "已配置，等待同步" : "当前仅本机记录；连接同一 WebDAV 文件夹后可跨设备共享")}</p>
    <details className="pool-settings"><summary>同步设置</summary>
      <form onSubmit={event=>{event.preventDefault();void run(()=>window.paperOcean.pool!.configure({url,username,password}));}}>
        <p>两台设备填写同一个已有的 HTTPS WebDAV 文件夹。密码使用系统密钥环加密保存。应用开启时每分钟同步，离线记录会在恢复连接后补齐。</p>
        <label>WebDAV 文件夹<input type="url" required placeholder="https://…/PaperOcean/" aria-label="WebDAV 文件夹" value={url} onChange={event=>setUrl(event.target.value)} /></label>
        <label>用户名<input required autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)} /></label>
        <label>应用密码<input type="password" autoComplete="new-password" placeholder={state?.configured ? "留空保留原密码" : "WebDAV 应用密码"} value={password} onChange={event=>setPassword(event.target.value)} /></label>
        <div><button disabled={busy} type="submit">保存并同步</button> <button disabled={busy || !state?.configured} type="button" onClick={()=>void run(()=>window.paperOcean.pool!.configure(null))}>断开同步</button></div>
      </form>
    </details>
    <div className="library-results" aria-label="共享论文列表">
      {!rows.length && <p>{state ? "还没有符合条件的论文。打开论文或提问后会自动记入。" : "正在读取论文池…"}</p>}
      {rows.map(paper => { const local = papers.some(item=>item.id===paper.id); const source = paper.sourceUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}${paper.arxivVersion ? `v${paper.arxivVersion}` : ""}` : undefined);
        return <article key={paper.id}><h3>{paper.title}</h3><p>{paper.authors.join("、")}</p><div className="pool-tags"><span>{paper.askedAt ? "问过" : "看过"}</span><span>{local ? "本机有记录" : "仅历史记录 · 本机未导入"}</span></div>
          <div className="pool-actions">{local && <button type="button" disabled={busy} onClick={()=>{setBusy(true);void onOpen(paper.id).then(ok=>{if(!ok)setError("本机原件暂不可用，请在资料库重新定位 PDF。");}).catch(reason=>setError(String(reason))).finally(()=>setBusy(false));}}>打开本机论文</button>}{source && <button type="button" onClick={()=>void window.paperOcean.openExternal(source).catch(reason=>setError(String(reason)))}>论文来源 ↗</button>}</div>
        </article>;
      })}
    </div>
  </div>;
}
