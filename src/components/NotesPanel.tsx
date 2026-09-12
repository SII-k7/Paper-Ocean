import { useState } from "react";
import type { EvidenceAnchor, PaperHighlight, PaperRecord, ResearchNote } from "../types";
import MarkdownMessage from "./MarkdownMessage";

type Props = {
  notes: ResearchNote[];
  highlights: PaperHighlight[];
  papers: PaperRecord[];
  selectedId?: string;
  currentPaperId?: string;
  paperIdsByScope?: Record<string, string[]>;
  selection?: EvidenceAnchor;
  onSelect(id: string): void;
  onNew(): void;
  onChange(note: ResearchNote): void;
  onHighlightChange(highlight: PaperHighlight): void;
  onOpenAnchor(anchor: EvidenceAnchor): void;
  onOpenSource(note: ResearchNote): void;
  onExport(note: ResearchNote, images: boolean): Promise<void>;
};

export default function NotesPanel({ notes, highlights, papers, selectedId, currentPaperId, paperIdsByScope = {}, selection, onSelect, onNew, onChange, onHighlightChange, onOpenAnchor, onOpenSource, onExport }: Props) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"current" | "all">("current");
  const [archived, setArchived] = useState(false);
  const [preview, setPreview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const note = notes.find((item) => item.id === selectedId);
  const currentOnly = scope === "current" && Boolean(currentPaperId);
  const belongsToCurrent = (item: ResearchNote) => {
    if (!currentPaperId) return false;
    if (item.anchors.some(anchor => anchor.paperId === currentPaperId)) return true;
    const sourceScope = item.sourceMessage?.scopeKey;
    return Boolean(sourceScope && ((paperIdsByScope[sourceScope] ?? []).includes(currentPaperId)
      || sourceScope === `paper:${currentPaperId}` || sourceScope === `auxiliary:${currentPaperId}`));
  };
  const filtered = notes.filter((item) => (!currentOnly || belongsToCurrent(item)) && Boolean(item.archivedAt) === archived && `${item.title}\n${item.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedOutsideFilter = note && !filtered.some(item => item.id === note.id);
  const filteredHighlights = highlights.filter(item => (!currentOnly || item.paperId === currentPaperId) && Boolean(item.archivedAt) === archived);
  const label = (anchor: EvidenceAnchor) => `${papers.find((paper) => paper.id === anchor.paperId)?.title || "论文缺失"} · 第 ${anchor.page} 页`;
  const append = (anchor: EvidenceAnchor) => {
    if (note && !note.anchors.some((item) => item.id === anchor.id)) onChange({ ...note, anchors: [...note.anchors, anchor] });
  };
  const exportNote = async (images: boolean) => {
    if (!note || exporting) return;
    setExporting(true);
    try { await onExport(note, images); } finally { setExporting(false); }
  };
  return <section className="notes-panel" aria-label="研究笔记">
    <div className="note-scope" role="group" aria-label="笔记范围">
      <button type="button" aria-pressed={currentOnly} disabled={!currentPaperId} onClick={() => setScope("current")}>当前论文</button>
      <button type="button" aria-pressed={!currentOnly} onClick={() => setScope("all")}>全部笔记</button>
      <span>{filtered.length} 条</span>
    </div>
    <div className="notes-toolbar">
      <input aria-label="搜索笔记" placeholder="搜索笔记…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="button" onClick={onNew}>新建笔记</button>
      <label><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />已归档</label>
    </div>
    <select aria-label="选择笔记" value={note ? note.id : ""} onChange={(event) => { onSelect(event.target.value); setPreview(false); }}>
      <option value="" disabled>{filtered.length ? "选择笔记" : "没有匹配的笔记"}</option>
      {filtered.map((item) => <option key={item.id} value={item.id}>{item.title || "未命名笔记"}</option>)}
      {selectedOutsideFilter && <optgroup label="当前打开 · 筛选范围外"><option value={note.id}>{note.title || "未命名笔记"}</option></optgroup>}
    </select>
    {currentOnly && !filtered.length && <div className="notes-scope-message" role="status"><p>{query ? "当前论文没有符合搜索条件的笔记。" : "当前论文还没有关联笔记。"}没有论文来源的旧笔记可在全部笔记中查看。</p><button type="button" onClick={() => { setScope("all"); setQuery(""); }}>查看全部笔记</button></div>}
    {selectedOutsideFilter && <p className="notes-scope-notice" role="status">{currentOnly && !belongsToCurrent(note) ? "当前打开的笔记不属于这篇论文，已保留在下方，仍可继续编辑。" : "当前打开的笔记不在筛选结果中，仍可继续编辑。"}</p>}
    {note ? <div className="note-editor">
      <input aria-label="笔记标题" placeholder="未命名笔记" maxLength={300} value={note.title} onChange={(event) => onChange({ ...note, title: event.target.value })} />
      <div className="notes-toolbar">
        <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "编辑正文" : "预览正文"}</button>
        {note.sourceMessage && <button type="button" onClick={() => onOpenSource(note)}>返回原回答</button>}
        <button type="button" onClick={() => onChange({ ...note, archivedAt: note.archivedAt ? undefined : Date.now() })}>{note.archivedAt ? "恢复笔记" : "归档笔记"}</button>
      </div>
      {note.sourceMessage && <small>由 AI 回答转存 · 可编辑，请核对原文证据</small>}
      {preview ? <div className="note-preview"><MarkdownMessage text={note.body} onOpenEvidence={(paperId, page) => onOpenAnchor({ id: "preview", paperId, page, quote: "", rects: [] })} /></div>
        : <textarea aria-label="笔记正文" placeholder="写下自己的理解，支持 Markdown 和公式…" maxLength={500000} value={note.body} onChange={(event) => onChange({ ...note, body: event.target.value })} />}
      <div className="notes-toolbar"><strong>原文证据 · {note.anchors.length}</strong><button type="button" disabled={!selection || note.anchors.some((item) => item.id === selection.id)} onClick={() => selection && append(selection)}>附加当前选文</button></div>
      {note.anchors.map((anchor) => <div key={anchor.id} className="note-anchor">
        <button type="button" className="evidence-link" onClick={() => onOpenAnchor(anchor)}>{label(anchor)} ↗</button>
        {anchor.quote && <blockquote>{anchor.quote}</blockquote>}
        <button type="button" onClick={() => onChange({ ...note, anchors: note.anchors.filter((item) => item.id !== anchor.id) })}>移除此证据</button>
      </div>)}
      <div className="notes-toolbar">
        <button type="button" disabled={exporting} onClick={() => void exportNote(false)}>导出 Markdown</button>
        <button type="button" disabled={exporting || !note.anchors.length} onClick={() => void exportNote(true)}>{exporting ? "正在导出…" : "导出 Markdown + 页图"}</button>
      </div>
    </div> : <p className="notes-empty">将原文高亮和自己的理解放在一起。每条笔记可附加多篇论文、多页证据。</p>}
    <details className="highlight-library" open>
      <summary>原文高亮 · {filteredHighlights.length}</summary>
      <small>每次选择同一页的文字，可向笔记逐次添加多页证据。</small>
      {filteredHighlights.map((highlight) => <div className="note-anchor" key={highlight.id}>
        <button type="button" className="evidence-link" onClick={() => onOpenAnchor(highlight)}>{label(highlight)} ↗</button>
        <blockquote>{highlight.quote}</blockquote>
        <div className="notes-toolbar">
          <select aria-label={`高亮颜色 ${highlight.id}`} value={highlight.color} onChange={(event) => onHighlightChange({ ...highlight, color: event.target.value as PaperHighlight["color"] })}><option value="yellow">黄色</option><option value="green">绿色</option><option value="pink">粉色</option></select>
          <button type="button" disabled={!note || note.anchors.some((item) => item.id === highlight.id)} onClick={() => append(highlight)}>加入这条笔记</button>
          <button type="button" onClick={() => onHighlightChange({ ...highlight, archivedAt: highlight.archivedAt ? undefined : Date.now() })}>{highlight.archivedAt ? "恢复高亮" : "归档高亮"}</button>
        </div>
      </div>)}
    </details>
  </section>;
}
