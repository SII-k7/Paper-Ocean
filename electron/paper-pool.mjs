// Portable history only: never include file paths, PDF bytes, extracted text or credentials.
const ID = /^[a-f0-9]{24}$/;
const text = (value, length) => typeof value === "string" ? value.slice(0, length) : "";
const time = value => Number.isFinite(value) && value > 0 ? Math.min(value, 8640000000000000) : 0;
function cleanRecord(value) {
  if (!value || !ID.test(value.id) || !text(value.title, 2000).trim()) throw new Error("论文池包含无效记录，未覆盖原数据");
  let sourceUrl;
  try { const url = new URL(value.sourceUrl); if (url.protocol === "https:" && !url.username && !url.password) sourceUrl = url.href; } catch { /* Optional source. */ }
  return {
    id: value.id, title: text(value.title, 2000), authors: Array.isArray(value.authors) ? value.authors.slice(0, 100).map(author => text(author, 200)) : [],
    arxivId: text(value.arxivId, 80), arxivVersion: Number.isInteger(value.arxivVersion) && value.arxivVersion > 0 ? value.arxivVersion : undefined,
    sourceUrl, seenAt: time(value.seenAt), askedAt: time(value.askedAt),
  };
}
export function validatePool(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.papers) || value.papers.length > 20000) throw new Error("论文池格式或版本不受支持，未覆盖原数据");
  return { version: 1, papers: value.papers.map(cleanRecord) };
}
export function poolFromLibrary(library) {
  const asked = new Map();
  for (const [scope, messages] of Object.entries(library.messagesByScope || {})) {
    const latest = messages.reduce((latest, message) => message.role === "user" ? Math.max(latest, time(message.createdAt)) : latest, 0);
    if (!latest) continue;
    const ids = scope.startsWith("paper:") ? [scope.slice(6)] : library.conversations?.[scope]?.paperIds || [];
    for (const id of ids) asked.set(id, Math.max(asked.get(id) || 0, latest));
  }
  return validatePool({ version: 1, papers: (library.papers || []).filter(paper => time(paper.openedAt) || asked.has(paper.id)).map(paper => ({
    id: paper.id, title: paper.title || paper.name, authors: paper.authors, sourceUrl: paper.sourceUrl,
    arxivId: paper.arxivId, arxivVersion: paper.arxivVersion, seenAt: time(paper.openedAt), askedAt: asked.get(paper.id) || 0,
  })) });
}
export function mergePools(...pools) {
  const rows = new Map();
  for (const pool of pools) for (const next of validatePool(pool).papers) {
    const previous = rows.get(next.id);
    if (!previous) { rows.set(next.id, next); continue; }
    // Stable total ordering makes concurrent retries and reverse-direction merges converge.
    const rank = row => JSON.stringify([row.title, row.authors, row.sourceUrl, row.arxivId, row.arxivVersion]);
    const winner = rank(previous) > rank(next) ? previous : next;
    rows.set(next.id, { ...winner,
      seenAt: Math.max(previous.seenAt, next.seenAt), askedAt: Math.max(previous.askedAt, next.askedAt) });
  }
  return { version: 1, papers: [...rows.values()].sort((a,b) => a.id.localeCompare(b.id)) };
}
