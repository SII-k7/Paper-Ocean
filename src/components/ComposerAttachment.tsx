import { FileText, X } from "lucide-react";
import type { EvidenceAnchor } from "../types";

export type ComposerAttachmentData = EvidenceAnchor & { paperTitle: string };

export default function ComposerAttachment({ attachment, onRemove, onOpenEvidence, label = "已附加原文" }: {
  attachment: ComposerAttachmentData;
  onRemove?(): void;
  label?: string;
  onOpenEvidence(paperId: string, page: number): void;
}) {
  return <div className="composer-attachment" role="group" aria-label={label}>
    <div className="composer-attachment__header">
      <button type="button" className="composer-attachment__source" onClick={() => onOpenEvidence(attachment.paperId, attachment.page)} title={attachment.paperTitle}>
        <FileText size={14} aria-hidden="true" /><span>{attachment.paperTitle}</span><small>第 {attachment.page} 页</small>
      </button>
      {onRemove && <button type="button" className="conversation-icon-button" aria-label="移除原文附件" onClick={onRemove}><X size={14} aria-hidden="true" /></button>}
    </div>
    <details className="composer-attachment__quote">
      <summary><span>{attachment.quote}</span><small className="composer-attachment__expand">展开选文</small><small className="composer-attachment__collapse">收起选文</small></summary>
      <blockquote>{attachment.quote}</blockquote>
    </details>
  </div>;
}
