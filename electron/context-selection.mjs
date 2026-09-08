export const DEFAULT_CONTEXT_BUDGET = 96_000;

function prefixByBytes(text, limit) {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    end += character.length;
  }
  return text.slice(0, end);
}

function termsFor(query) {
  const terms = String(query || "").toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  return [...new Set(terms.flatMap((term) => /^[\p{Script=Han}]+$/u.test(term)
    ? Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))
    : [term]))].slice(0, 100);
}

function splitDocument(document) {
  const boundaries = [...document.content.matchAll(/^## 第 (\d+) 页(?:\r?\n|$)/gm)];
  if (!boundaries.length) return { ...document, header: "", pages: [{ page: 1, text: document.content }] };
  return {
    ...document, header: document.content.slice(0, boundaries[0].index),
    pages: boundaries.map((match, index) => ({ page: Number(match[1]), text: document.content.slice(match.index, boundaries[index + 1]?.index ?? document.content.length) })),
  };
}

export function selectContextDocuments(documents, { question = "", currentPaperId, currentPage, budgetBytes = DEFAULT_CONTEXT_BUDGET } = {}) {
  const budget = Number.isFinite(budgetBytes) ? Math.max(4_000, Math.min(DEFAULT_CONTEXT_BUDGET, Math.floor(budgetBytes))) : DEFAULT_CONTEXT_BUDGET;
  // Leave space for the trusted mapping, which contains IDs and counts only.
  const textBudget = budget - 800 - documents.length * 500;
  if (textBudget < 1_000) throw new Error("本轮论文数量超过上下文预算，请减少同时讨论的论文数量。");
  const parsed = documents.map(splitDocument);
  const complete = documents.reduce((sum, document) => sum + Buffer.byteLength(document.content), 0) <= textBudget;
  const terms = termsFor(question);
  const share = Math.floor(textBudget / Math.max(1, documents.length));

  const selected = parsed.map((document) => {
    if (complete) return { id: document.id, content: document.content, pages: document.pages.map((page) => page.page), totalPages: document.pages.length, excerptPages: [] };
    const header = prefixByBytes(document.header, Math.min(1_500, Math.floor(share / 4)));
    let remaining = share - Buffer.byteLength(header);
    const ranked = document.pages.map((page, index) => {
      const lower = page.text.toLocaleLowerCase();
      const matches = terms.reduce((score, term) => score + (lower.includes(term) ? 8 : 0), 0);
      const distance = document.id === currentPaperId && currentPage ? Math.abs(page.page - currentPage) : Infinity;
      return { ...page, score: matches + (distance === 0 ? 40 : distance === 1 ? 10 : 0) + (index === 0 ? 16 : 0) + (index === document.pages.length - 1 ? 5 : 0) };
    }).sort((a,b) => b.score - a.score || a.page - b.page);
    const included = [];
    const excerptPages = [];
    for (const candidate of ranked) {
      const size = Buffer.byteLength(candidate.text);
      if (size <= remaining) {
        included.push(candidate);
        remaining -= size;
      } else if (included.length === 0 && remaining > 100) {
        // Oversized pages must not exclude the only relevant evidence. Keep a
        // bounded excerpt near the first query match and explicitly label it.
        const lower = candidate.text.toLocaleLowerCase();
        const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
        const start = hits.length ? Math.max(0, Math.min(...hits) - 150) : 0;
        const label = `## 第 ${candidate.page} 页\n\n[本页节选，未提供完整页面]\n`;
        const text = label + prefixByBytes(candidate.text.slice(start), remaining - Buffer.byteLength(label));
        included.push({ ...candidate, text });
        excerptPages.push(candidate.page);
        remaining -= Buffer.byteLength(text);
      }
    }
    included.sort((a,b) => a.page - b.page);
    return { id: document.id, content: header + included.map((page) => page.text).join(""), pages: included.map((page) => page.page), totalPages: document.pages.length, excerptPages };
  });
  return { documents: selected, complete: selected.every((document) => document.pages.length === document.totalPages && !document.excerptPages.length), budgetBytes: budget, textBytes: selected.reduce((sum, document) => sum + Buffer.byteLength(document.content), 0) };
}
