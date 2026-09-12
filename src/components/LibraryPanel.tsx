import { useEffect, useMemo, useRef, useState } from "react";
import type { PaperRecord, PaperArchiveStatus, PaperCategory } from "../types";
import { PAPER_CATEGORIES } from "../../electron/paper-classification.mjs";
import PaperPool from "./PaperPool";

type Props = {
  papers: PaperRecord[];
  opening: boolean;
  onClose(): void;
  onOpen(id: string): Promise<boolean>;
  onStatus(id: string, status: PaperRecord["readingStatus"]): void;
  onRelink(paper: PaperRecord): Promise<boolean>;
};

export default function LibraryPanel({ papers, opening, onClose, onOpen, onStatus, onRelink }: Props) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("recent");
  const [limit, setLimit] = useState(50);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [archive, setArchive] = useState<PaperArchiveStatus>();
  const [archiveWorking, setArchiveWorking] = useState(false);
  const [tab, setTab] = useState("local");
  useEffect(() => {
    let mounted = true;
    const refresh = () => window.paperOcean.archive.status().then(state => { if (mounted) setArchive(state); }).catch(error => { if (mounted) setMessage(String(error)); });
    void refresh(); const timer = setInterval(() => void refresh(), 2500);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  const updateArchive = async (action: () => Promise<PaperArchiveStatus>) => {
    setArchiveWorking(true); setMessage("");
    try { setArchive(await action()); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setArchiveWorking(false); }
  };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    const reserved = new WeakSet<Event>();
    const inspectEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A popover or a true modal above this nonmodal navigation drawer owns
      // its first Escape, even if it closes before our bubble listener runs.
      if (document.querySelector("dialog[open]") || [...document.querySelectorAll('.app-header details[open], .prompt-settings[open], [data-overlay-open="true"]')].some(node => !drawerRef.current?.contains(node))
        || (event.target instanceof Element && event.target.matches('[role="combobox"][aria-expanded="true"]'))) reserved.add(event);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || reserved.has(event)) return;
      event.preventDefault(); closeRef.current();
    };
    window.addEventListener("keydown", inspectEscape, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", inspectEscape, true);
      window.removeEventListener("keydown", escape);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return papers.filter((paper) => {
      const haystack = `${paper.title} ${paper.name} ${paper.arxivId || ""} ${(paper.authors || []).join(" ")} ${paper.abstract || ""}`.toLocaleLowerCase();
      return (status === "all" || (paper.readingStatus ?? "unread") === status) && words.every((word) => haystack.includes(word));
    }).sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : sort === "published" ? (b.publishedAt || "").localeCompare(a.publishedAt || "") || b.openedAt - a.openedAt : b.openedAt - a.openedAt);
  }, [papers, query, status, sort]);
  const run = async (paper: PaperRecord, relink = false) => {
    setWorking(true); setMessage("");
    try {
      const success = await (relink ? onRelink(paper) : onOpen(paper.id));
      if (success && !relink) onClose();
      else if (success) setMessage("原件已重新定位，讨论和笔记仍关联原论文。");
      else if (!relink) setMessage("无法打开原件。请重新定位相同版本的 PDF，已有记录仍保留。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  return <aside ref={drawerRef} className="library-drawer" aria-labelledby="library-title">
    <header><div><h2 id="library-title">资料库</h2><p>{papers.length} 篇论文</p></div><button type="button" aria-label="关闭资料库" onClick={onClose}>×</button></header>
    <nav className="pool-tabs" aria-label="资料库分区"><button type="button" aria-pressed={tab === "local"} onClick={()=>setTab("local")}>本机资料库</button><button type="button" aria-pressed={tab === "pool"} onClick={()=>setTab("pool")}>论文池 · 看过的论文</button></nav>
    {tab === "pool" ? <PaperPool papers={papers} onOpen={async id=>{const success = await onOpen(id); if(success) onClose(); return success;}} /> : <div className="library-drawer__body">
    <div className="library-filters">
      <input ref={searchRef} aria-label="搜索资料库" placeholder="标题、作者、arXiv ID 或摘要…" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} />
      <select aria-label="筛选阅读状态" value={status} onChange={(event) => { setStatus(event.target.value); setLimit(50); }}><option value="all">全部状态</option><option value="unread">待读</option><option value="reading">阅读中</option><option value="done">已读</option></select>
      <select aria-label="资料库排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">最近打开</option><option value="published">首次提交日期</option><option value="title">标题</option></select>
    </div>
    <details className="library-archive" aria-label="对话论文自动归档">
      <summary><strong>自动归档</strong><span>{archive?.busy ? "正在整理…" : archive?.failures.length ? `${archive.failures.length} 篇需处理` : `已保存 ${archive?.entries.filter(entry => !archive.failures.some(failure => failure.paperId === entry.paperId)).length || 0} 篇`}</span></summary>
      <p>有过对话的 PDF 按主题保存；不确定的放入待分类。</p>
      <code>{archive?.directory || "正在读取归档目录…"}</code>
      <div className="archive-actions">
        {window.paperOcean.runtime === "electron" && <button type="button" onClick={() => void window.paperOcean.archive.openFolder().catch(error => setMessage(String(error)))}>打开文件夹</button>}
        <button type="button" disabled={archiveWorking || archive?.busy} onClick={() => void updateArchive(() => window.paperOcean.archive.retry())}>检查并补齐归档</button>
      </div>
      {archive?.error && <p className="archive-error" role="alert">{archive.error}</p>}
      {!!archive?.failures.length && <details><summary>有 {archive.failures.length} 篇归档失败</summary>{archive.failures.map(failure => <p key={failure.paperId}>{failure.title}：{failure.error}</p>)}</details>}
    </details>
    {message && <p role="status" className="library-message">{message}</p>}
    <div className="library-results" aria-label="论文列表">
      {!filtered.length && <p>没有匹配的论文。</p>}
      {filtered.slice(0, limit).map((paper) => <article key={paper.id}>
        <div className="library-paper-heading"><button type="button" className="library-paper-title" disabled={working || opening} onClick={() => void run(paper)}>{paper.title}</button></div>
        {!!paper.authors?.length && <p className="library-authors">{paper.authors.join("、")}</p>}
        <div className="library-paper-overview"><span data-status={paper.readingStatus ?? "unread"}>{paper.readingStatus === "done" ? "已读" : paper.readingStatus === "reading" ? "阅读中" : "待读"}</span>{!!paper.pageCount && <span>{paper.pageCount} 页</span>}{paper.arxivId && <span>arXiv {paper.arxivId}</span>}</div>
        <details className="library-paper-management"><summary>管理与来源</summary>
        <label className="library-reading-status">阅读状态 <select aria-label={`阅读状态：${paper.title}`} value={paper.readingStatus ?? "unread"} onChange={(event) => onStatus(paper.id, event.target.value as PaperRecord["readingStatus"])}><option value="unread">待读</option><option value="reading">阅读中</option><option value="done">已读</option></select></label>
        <div className="library-paper-category">
          <label>归档分类 <select aria-label={`归档分类：${paper.title}`} disabled={archiveWorking || archive?.busy} value={archive?.overrides?.[paper.id] || "auto"} onChange={event => void updateArchive(() => window.paperOcean.archive.setCategory(paper.id, event.target.value as PaperCategory | "auto"))}>
            <option value="auto">自动判断</option>{PAPER_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
          </select></label>
          <span title={archive?.entries.find(entry => entry.paperId === paper.id)?.reason}>{archive?.entries.find(entry => entry.paperId === paper.id)?.category || archive?.overrides?.[paper.id] || "对话后自动保存"}</span>
        </div>
        <div className="library-paper-meta"><span>{paper.pageCount ? `${paper.pageCount} 页` : "尚未索引"}</span><span>{paper.managedOriginal ? "原件已保存在资料库" : "原件待迁入，打开时保存"}</span>{paper.arxivId && <span>arXiv:{paper.arxivId}{paper.arxivVersion ? `v${paper.arxivVersion}` : " · 版本未确认"}</span>}</div>
        <div className="library-paper-meta"><span>首次提交：{paper.publishedAt || "未知"}</span>{paper.revisedAt && <span>此版提交：{paper.revisedAt}</span>}{paper.arxivId && papers.filter((item) => item.id !== paper.id && item.arxivId === paper.arxivId).length > 0 && <button type="button" onClick={() => { setQuery(paper.arxivId!); setStatus("all"); }}>查看资料库中的其他版本</button>}</div>
        <div className="library-source"><p>内容 ID：<code>{paper.id}</code></p><p>阅读文件：<code>{paper.path}</code></p>{paper.originalPath && <p>导入位置：<code>{paper.originalPath}</code></p>}{paper.sourceUrl && <button type="button" onClick={() => void window.paperOcean.openExternal(paper.sourceUrl!).catch((error) => setMessage(String(error)))}>查看论文来源 ↗</button>}<button type="button" disabled={working || opening} onClick={() => void run(paper, true)}>重新定位 PDF</button></div>
        </details>
      </article>)}
      {filtered.length > limit && <button type="button" onClick={() => setLimit(limit + 50)}>再显示 50 篇（共 {filtered.length} 篇）</button>}
    </div>
  </div>}
  </aside>;
}
