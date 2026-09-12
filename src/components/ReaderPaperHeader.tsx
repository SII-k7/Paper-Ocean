import { Check, FileText, X } from "lucide-react";
import type { PaperRecord } from "../types";

export default function ReaderPaperHeader({ paper, onTitle, onClose }: { paper: PaperRecord | null; onTitle(title: string): void; onClose(): void }) {
  return <div className="paper-titlebar reader-paper-header">
    <div className="paper-titlebar__title"><FileText size={16} className="document-icon" aria-hidden="true" />
      {paper ? <input value={paper.title} onChange={event => onTitle(event.target.value)} aria-label="论文标题" title={paper.title} /> : <span>阅读，从一篇论文开始</span>}
    </div>
    {paper && <>
      <span className={`reader-paper-header__index${paper.paperDir ? " index-ready" : ""}`} title={paper.paperDir ? "全文索引就绪" : "正在索引全文"}>{paper.paperDir ? <Check size={14} aria-hidden="true" /> : <span className="reader-paper-header__progress" />}<span>{paper.paperDir ? "全文索引就绪" : "正在索引全文"}</span></span>
      <button type="button" className="reader-paper-header__close" aria-label={`关闭 ${paper.title}`} title="关闭当前论文" onClick={onClose}><X size={15} /></button>
    </>}
  </div>;
}
