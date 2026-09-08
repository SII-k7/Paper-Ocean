import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { searchPdfPages, safePdfUrl, type PdfSearchResult } from "../pdf-navigation.mjs";
import type { PdfPageIndex } from "../types";

type OutlineItem = { title: string; dest: unknown; url?: string | null; items?: OutlineItem[] };
type Props = {
  document: PDFDocumentProxy | null;
  pages: PdfPageIndex[];
  mode: "search" | "outline";
  onClose(): void;
  onSearch(query: string, result: PdfSearchResult | null): void;
  onDestination(dest: unknown): void;
  onExternal(url: string): void;
};

export default function PdfNavigationPanel({ document, pages, mode, onClose, onSearch, onDestination, onExternal }: Props) {
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [selected, setSelected] = useState(0);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [outlineStatus, setOutlineStatus] = useState("正在读取目录…");
  const results = useMemo(() => searchPdfPages(pages, search), [pages, search]);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  useEffect(() => { setSelected(0); onSearchRef.current(search, results[0] ?? null); }, [search, results]);
  useEffect(() => {
    let cancelled = false;
    setOutline([]); setOutlineStatus("正在读取目录…");
    if (document) void document.getOutline().then((items) => {
      if (!cancelled) { setOutline(items || []); setOutlineStatus(items?.length ? "" : "这份 PDF 没有内嵌目录。"); }
    }).catch(() => { if (!cancelled) setOutlineStatus("无法读取 PDF 目录，仍可通过页码或全文查找定位。"); });
    return () => { cancelled = true; };
  }, [document]);
  const entries = useMemo(() => {
    const items: Array<OutlineItem & { depth: number }> = [];
    const walk = (nodes: OutlineItem[], depth: number) => {
      for (const node of nodes) {
        if (items.length >= 2000 || depth > 20) return;
        items.push({ ...node, depth });
        if (Array.isArray(node.items)) walk(node.items, depth + 1);
      }
    };
    walk(outline, 0); return items;
  }, [outline]);
  const choose = (index: number) => {
    if (!results.length) return;
    const next = (index + results.length) % results.length;
    setSelected(next); onSearch(search, results[next]);
  };
  return <aside className="pdf-navigation" aria-label={mode === "search" ? "PDF 全文查找" : "PDF 目录"}>
    <header><strong>{mode === "search" ? "全文查找" : "文档目录"}</strong><button type="button" aria-label="关闭 PDF 导航" onClick={onClose}>×</button></header>
    {mode === "search" ? <>
      <input autoFocus aria-label="查找 PDF 文本" placeholder="输入关键词…" value={query} maxLength={300} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); choose(selected + (event.shiftKey ? -1 : 1)); } }} />
      <div className="pdf-search-controls"><span role="status">{search.trim() ? `${results.length ? selected + 1 : 0} / ${results.length}${results.length === 2000 ? "+" : ""}` : "支持跨行词组"}</span><button type="button" aria-label="上一个 PDF 匹配" disabled={!results.length} onClick={() => choose(selected - 1)}>↑</button><button type="button" aria-label="下一个 PDF 匹配" disabled={!results.length} onClick={() => choose(selected + 1)}>↓</button></div>
      {search.trim() && !results.length && <p>{pages.length < (document?.numPages ?? 0) ? "正在建立全文索引…" : "未找到匹配。扫描页尚不支持 OCR 查找。"}</p>}
      <ol className="pdf-navigation-list">{results.map((result, index) => <li key={`${result.page}:${result.occurrence}`}><button type="button" className={selected === index ? "active" : ""} aria-current={selected === index ? "true" : undefined} onClick={() => choose(index)}><b>第 {result.page} 页</b><span>{result.snippet}</span></button></li>)}</ol>
    </> : <>{outlineStatus && <p role="status">{outlineStatus}</p>}<ol className="pdf-navigation-list">{entries.map((item, index) => <li key={index} style={{ paddingLeft: Math.min(item.depth, 6) * 10 }}><button type="button" disabled={!item.dest && !safePdfUrl(item.url)} onClick={() => { if (item.dest) onDestination(item.dest); else { const url = safePdfUrl(item.url); if (url) onExternal(url); } }}>{item.title || "未命名章节"}{item.url ? " ↗" : ""}</button></li>)}</ol></>}
  </aside>;
}
