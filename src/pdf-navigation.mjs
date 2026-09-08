// Keep offsets in the original text, including ligatures and line-end hyphens.
function searchable(value) {
  const text = String(value ?? "");
  let normalized = "";
  const starts = [], ends = [];
  for (let offset = 0; offset < text.length;) {
    const hyphen = /[-\u00ad]/.test(text[offset]) ? text.slice(offset).match(/^[-\u00ad][ \t]*\r?\n[ \t]*/) : null;
    if (hyphen && /\p{L}/u.test(text[offset - 1] || "") && /\p{L}/u.test(text[offset + hyphen[0].length] || "")) {
      offset += hyphen[0].length; continue;
    }
    const character = String.fromCodePoint(text.codePointAt(offset));
    const end = offset + character.length;
    for (const unit of character.normalize("NFKC").toLowerCase()) {
      if (/\s/u.test(unit)) {
        if (normalized.endsWith(" ")) { ends[ends.length - 1] = end; continue; }
        normalized += " "; starts.push(offset); ends.push(end);
      } else {
        normalized += unit;
        // indexOf uses UTF-16 offsets, so supplementary characters need two entries.
        for (let index = 0; index < unit.length; index++) { starts.push(offset); ends.push(end); }
      }
    }
    offset = end;
  }
  return { text: normalized, starts, ends };
}

export function findTextMatches(text, query, limit = 2000) {
  const needle = searchable(query).text.trim();
  if (!needle) return [];
  const source = searchable(text), matches = [];
  let offset = 0;
  while (matches.length < limit) {
    const index = source.text.indexOf(needle, offset);
    if (index < 0) break;
    const start = source.starts[index], end = source.ends[index + needle.length - 1];
    matches.push({ start, end });
    offset = index + needle.length;
  }
  return matches;
}

export function pageTextWithRanges(items) {
  let text = "";
  const ranges = [];
  for (const [index, item] of items.entries()) {
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const start = text.length;
    text += item.str;
    ranges.push({ index, start, end: text.length });
    text += item.hasEOL ? "\n" : " ";
  }
  return { text, ranges };
}

export function searchPdfPages(pages, query, limit = 2000) {
  const results = [];
  for (const item of pages) {
    for (const [occurrence, match] of findTextMatches(item.text, query, limit - results.length).entries()) {
      results.push({ page: item.page, occurrence, snippet: item.text.slice(Math.max(0, match.start - 45), match.end + 90).replace(/\s+/g, " ").trim() });
    }
    if (results.length >= limit) break;
  }
  return results;
}

export function safePdfUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export async function resolvePdfDestination(document, input) {
  const dest = typeof input === "string" ? await document.getDestination(input) : input;
  if (!Array.isArray(dest) || dest.length < 2) throw new Error("PDF 链接的目标无效。");
  const index = Number.isInteger(dest[0]) ? dest[0] : await document.getPageIndex(dest[0]);
  if (!Number.isInteger(index) || index < 0 || index >= document.numPages) throw new Error("PDF 链接指向不存在的页面。");
  const page = await document.getPage(index + 1), viewport = page.getViewport({ scale: 1 });
  const mode = dest[1]?.name;
  let left = null, top = null;
  if (mode === "XYZ") { left = dest[2]; top = dest[3]; }
  else if (["FitH", "FitBH"].includes(mode)) top = dest[2];
  else if (["FitV", "FitBV"].includes(mode)) left = dest[2];
  else if (mode === "FitR") { left = dest[2]; top = dest[5]; }
  const [x, y] = viewport.convertToViewportPoint(Number.isFinite(left) ? left : page.view[0], Number.isFinite(top) ? top : page.view[3]);
  return { page: index + 1, x: Number.isFinite(left) ? Math.max(0, Math.min(1, x / viewport.width)) : .5, y: Math.max(0, Math.min(1, y / viewport.height)) };
}
