export function searchText(value = "") {
  return String(value).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function nearWord(a, b) {
  if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
    }
    beforePrevious = previous;
    previous = row;
  }
  return previous[b.length] <= 1;
}

export function titleMatchScore(query, title) {
  const q = searchText(query), t = searchText(title);
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 80;
  // Paper names often join words differently: OpenVLA / Open VLA / Open-VLA.
  if (q.replaceAll(" ", "").length >= 4 && t.replaceAll(" ", "").includes(q.replaceAll(" ", ""))) return 75;
  const words = t.split(" ");
  const terms = q.split(" ");
  const scores = terms.map(term => words.some(word => word.startsWith(term)) || (/\p{Script=Han}/u.test(term) && t.includes(term)) ? 1 : words.some(word => nearWord(term, word) || (term.length >= 5 && word.length > term.length && nearWord(term, word.slice(0, term.length + 1)))) ? 0.7 : 0);
  return scores.every(Boolean) ? 60 * scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

export function localPaperSuggestions(query, papers) {
  return papers.map(paper => ({ paper, score: Math.max(titleMatchScore(query, paper.title), titleMatchScore(query, paper.arxivId || "")) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.paper.openedAt - a.paper.openedAt).slice(0, 5)
    .map(({ paper }) => ({ key: `local:${paper.id}`, paperId: paper.id, title: paper.title, subtitle: "本地资料库", source: "local", arxivId: paper.arxivId }));
}
