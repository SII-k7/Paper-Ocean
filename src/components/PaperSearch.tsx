import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Command, LoaderCircle, Search, X } from "lucide-react";
import { parseArxivReference } from "../../electron/paper-metadata.mjs";
import { localPaperSuggestions } from "../../electron/paper-search-utils.mjs";
import type { PaperRecord, PaperSuggestion } from "../types";

type Props = { papers: PaperRecord[]; disabled: boolean; onOpenArxiv(value: string): Promise<boolean>; onOpenLocal(id: string): Promise<boolean>; onError(message: string): void };
export default function PaperSearch({ papers, disabled, onOpenArxiv, onOpenLocal, onError }: Props) {
  const [query, setQuery] = useState(""), [show, setShow] = useState(false), [active, setActive] = useState(-1);
  const [remote, setRemote] = useState<{ query: string; items: PaperSuggestion[]; error?: string }>({ query: "", items: [] });
  const [pending, setPending] = useState(false), [opening, setOpening] = useState(false), [composing, setComposing] = useState(false);
  const composingRef = useRef(false), root = useRef<HTMLDivElement>(null), request = useRef(0), id = useId();
  const suppressSubmit = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "k" || event.isComposing || disabled || opening || document.querySelector("dialog[open]")) return;
      event.preventDefault(); input.current?.focus(); input.current?.select(); setShow(true);
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [disabled, opening]);
  const trimmed = query.trim(), direct = parseArxivReference(trimmed);
  const local = useMemo(() => localPaperSuggestions(query, papers), [query, papers]);
  const items = useMemo(() => [...local, ...(remote.query === trimmed ? remote.items.filter(item => !local.some(localItem => localItem.arxivId && localItem.arxivId.replace(/v\d+$/, "") === item.arxivId?.replace(/v\d+$/, ""))) : [])].slice(0, 10), [local, remote, trimmed]);
  const expanded = show && !direct && Boolean(trimmed);
  useEffect(() => {
    const current = ++request.current;
    setPending(false);
    if (!show || disabled || composing || trimmed.length < 2 || parseArxivReference(trimmed)) return;
    setPending(true);
    const timer = setTimeout(() => {
      window.paperOcean.searchPapers(trimmed).then(result => {
        if (current === request.current) setRemote({ query: trimmed, ...result });
      }).catch(() => { if (current === request.current) setRemote({ query: trimmed, items: [], error: "在线联想暂不可用，本地匹配仍可使用" }); })
        .finally(() => { if (current === request.current) setPending(false); });
    }, 450);
    return () => { clearTimeout(timer); request.current++; };
  }, [trimmed, composing, show, disabled]);
  useEffect(() => { root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  async function choose(item?: PaperSuggestion) {
    if (opening || disabled) return;
    if (!item && !direct) { setShow(true); return; }
    setOpening(true); setShow(false);
    try {
      if (item?.paperId) { if (await onOpenLocal(item.paperId)) setQuery(""); return; }
      let reference = item?.arxivId || direct?.reference;
      if (!reference && item?.semanticId) {
        const resolved = await window.paperOcean.resolvePaperSuggestion(item.semanticId);
        reference = resolved.arxivId;
        if (!reference && resolved.sourceUrl) { await window.paperOcean.openExternal(resolved.sourceUrl); onError("该论文没有可直接导入的 arXiv PDF，已打开来源页；下载后可用“本地 PDF”导入。"); return; }
      }
      if (!reference) throw new Error("暂时无法取得论文 PDF，请稍后重试");
      if (await onOpenArxiv(reference)) setQuery("");
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  }
  return <div ref={root} className="paper-search" onBlur={event => { if (!root.current?.contains(event.relatedTarget)) setShow(false); }}>
    <form className="arxiv-bar" onSubmit={event => { event.preventDefault(); if (!composingRef.current && !suppressSubmit.current) void choose(active >= 0 ? items[active] : undefined); }}>
      <Command className="search-icon" size={17} aria-hidden="true" />
      <input ref={input} role="combobox" aria-keyshortcuts="Control+k Meta+k" aria-label="搜索论文标题、arXiv ID 或链接" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-results`} aria-activedescendant={expanded && active >= 0 && items[active] ? `${id}-option-${active}` : undefined}
        value={query} maxLength={200} autoComplete="off" placeholder="搜索论文标题、arXiv ID 或链接…" disabled={disabled || opening}
        onChange={event => { setQuery(event.target.value); setActive(-1); setShow(true); }} onFocus={() => setShow(true)}
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }} onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
        onKeyDown={event => {
          if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { suppressSubmit.current = true; return; }
          suppressSubmit.current = false;
          if (event.key === "Escape") { event.preventDefault(); setShow(false); setActive(-1); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setShow(true);
            if (items.length) setActive(current => current < 0
              ? event.key === "ArrowDown" ? 0 : items.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
          }
          if (event.key === "Enter" && !direct && active < 0) { event.preventDefault(); setShow(true); if (items.length) setActive(0); }
        }} />
      {query ? <button type="button" className="paper-search-clear" aria-label="清空搜索" disabled={disabled || opening} onClick={() => { setQuery(""); setActive(-1); setRemote({ query: "", items: [] }); input.current?.focus(); }}><X size={14} /></button> : <kbd className="paper-search-shortcut" aria-hidden="true">{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>}
      <button type="submit" onPointerDown={() => { suppressSubmit.current = false; }} disabled={!trimmed || disabled || opening} aria-label={direct ? "打开论文" : "搜索论文"}>{opening ? <LoaderCircle size={14} className="search-spinner" /> : direct ? "打开" : <Search size={16} />}</button>
    </form>
    {expanded && <div className="paper-search-popover">
      <div className="paper-search-heading">{pending ? "正在检索在线论文…" : "论文联想"}<span>↑↓ 选择 · Enter 打开</span></div>
      <ul id={`${id}-results`} role="listbox" aria-label="论文搜索建议">
        {items.map((item, index) => <li key={item.key} id={`${id}-option-${index}`} role="option" aria-selected={active === index} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => void choose(item)}>
          <strong>{item.title}</strong><span>{item.subtitle || "论文"} · {item.source === "local" ? "已保存" : item.source === "arxiv" ? "arXiv" : "Semantic Scholar"}</span>
        </li>)}
      </ul>
      {!items.length && !pending && <p>{trimmed.length < 2 ? "再输入一些标题文字" : "没有找到匹配论文，试试标题中的其他词"}</p>}
      {remote.query === trimmed && remote.error && <p role="status">{remote.error}</p>}
      <small>本地即时匹配；停顿后联网联想</small>
    </div>}
  </div>;
}
