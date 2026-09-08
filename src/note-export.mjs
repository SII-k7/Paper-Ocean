export const evidenceImageName = (anchor) => `images/${anchor.paperId}-p${anchor.page}.png`;

export function noteMarkdown(note, papers, includeImages = false) {
  const escape = (text) => text.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const imagePages = new Set(note.anchors.map((anchor) => `${anchor.paperId}:${anchor.page}`));
  const body = note.body.replace(/\]\(#paper=([a-f0-9]{24})&page=([1-9]\d{0,3})\)/g, (match, paperId, page) => (
    includeImages && imagePages.has(`${paperId}:${page}`) ? `](${evidenceImageName({ paperId, page })})` : match
  ));
  const result = [`# ${escape(note.title || "未命名笔记")}`, "", body, "", "## 原文证据", ""];
  if (!note.anchors.length) result.push("尚未附加原文证据。", "");
  for (const [index, anchor] of note.anchors.entries()) {
    const paper = papers.find((item) => item.id === anchor.paperId);
    result.push(`### ${index + 1}. ${escape(paper?.title || "资料库中缺失的论文")} · PDF 第 ${anchor.page} 页`, "", `论文内容 ID：\`${anchor.paperId}\``, "");
    if (paper?.sourceUrl && /^https:\/\//i.test(paper.sourceUrl)) result.push(`[论文来源](${encodeURI(paper.sourceUrl).replace(/[()]/g, (value) => encodeURIComponent(value).replace("(", "%28").replace(")", "%29"))})`, "");
    if (anchor.quote) result.push(...anchor.quote.split("\n").map((line) => `> ${line}`), "");
    if (includeImages) result.push(`![PDF 第 ${anchor.page} 页](${evidenceImageName(anchor)})`, "");
  }
  if (note.sourceMessage) result.push("## 笔记来源", "", "由 AI 回答转存，可在 Paper Ocean 中返回原讨论；正文可编辑，原文证据需自行核对。", "", `讨论：\`${note.sourceMessage.scopeKey}\``, "", `消息：\`${note.sourceMessage.messageId}\``, "");
  return result.join("\n");
}
