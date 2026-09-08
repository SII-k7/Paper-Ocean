import { parseArxivReference, publicationDate } from "./paper-metadata.mjs";
import { searchText, titleMatchScore } from "./paper-search-utils.mjs";
import { classifyPaper } from "./paper-classification.mjs";

const decode = value => String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""; }).replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]).replace(/\s+/g, " ").trim();
export function arxivSuggestions(xml) {
  const seen = new Set();
  return [...String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].flatMap(([, entry]) => {
    const ref = parseArxivReference(decode(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]));
    const title = decode(entry.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/)?.[1]);
    if (!ref || !title || seen.has(ref.id)) return [];
    seen.add(ref.id);
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(([, name]) => decode(name));
    const date = publicationDate(decode(entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]));
    return [{ key: `arxiv:${ref.reference}`, arxivId: ref.reference, title, subtitle: [authors.slice(0, 2).join(", "), date].filter(Boolean).join(" · "), source: "arxiv" }];
  }).slice(0, 8);
}

export function createPaperSearch({ fetcher = globalThis.fetch, minimumDelay = 1000, arxivDelay = 3000, now = Date.now } = {}) {
  const cache = new Map(), inFlight = new Map(), titles = new Map(), resolved = new Map();
  let queue = Promise.resolve(), lastRequest = 0, lastArxiv = 0;
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
  async function response(url) {
    const result = await fetcher(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "PaperOcean/0.4 local-reader" } });
    if (!result.ok) throw new Error(`论文检索服务暂不可用（${result.status}）`);
    return result;
  }
  async function lookup(query) {
    await wait(lastRequest + minimumDelay - now()); lastRequest = now();
    try {
      const json = await (await response(`https://api.semanticscholar.org/graph/v1/paper/autocomplete?query=${encodeURIComponent(query)}`)).json();
      const items = (Array.isArray(json.matches) ? json.matches : []).filter(item => /^[a-f0-9]{40}$/i.test(item.id) && typeof item.title === "string").slice(0, 8)
        .map(item => ({ key: `s2:${item.id}`, semanticId: item.id, title: item.title.slice(0, 600), subtitle: String(item.authorsYear || "").slice(0, 300), source: "semantic-scholar" }));
      if (items.length) {
        for (const item of items) titles.set(item.semanticId, item.title);
        while (titles.size > 800) titles.delete(titles.keys().next().value);
        const scored = items.map(item => ({ item, score: titleMatchScore(query, item.title), topic: classifyPaper(item).category !== "待分类" ? 5 : 0 }));
        const relevant = scored.some(item => item.score >= 60) ? scored.filter(item => item.score > 0) : scored;
        return { items: relevant.sort((a, b) => b.score + b.topic - a.score - a.topic).map(value => value.item) };
      }
    } catch { /* arXiv remains usable without a Semantic Scholar API key. */ }
    return { items: await lookupArxiv(query) };
  }
  async function lookupArxiv(query) {
    await wait(lastArxiv + arxivDelay - now()); lastArxiv = now();
    const terms = searchText(query).split(" ").filter(Boolean).slice(0, 10);
    const expression = terms.map(word => `ti:${word}`).join(" AND ");
    const params = new URLSearchParams({ search_query: expression, start: "0", max_results: "8", sortBy: "relevance" });
    const xml = await (await response(`https://export.arxiv.org/api/query?${params}`)).text();
    if (!/<feed[\s>]/.test(xml) || /<id>[^<]*api\/errors/.test(xml)) throw new Error("论文搜索暂不可用，请稍后重试");
    return arxivSuggestions(xml).sort((a, b) => titleMatchScore(query, b.title) - titleMatchScore(query, a.title));
  }
  return {
    search(input) {
      const query = String(input || "").trim().slice(0, 100), key = searchText(query);
      if (key.length < 2 || parseArxivReference(query)) return Promise.resolve({ items: [] });
      if (cache.has(key) && cache.get(key).expires > now()) return Promise.resolve(cache.get(key).value);
      if (inFlight.has(key)) return inFlight.get(key);
      if (inFlight.size >= 3) return Promise.resolve({ items: [], error: "检索繁忙，请稍后重试" });
      const pending = queue.catch(() => undefined).then(() => lookup(query)).catch(() => ({ items: [], error: "在线论文联想暂不可用，本地匹配仍可使用。请稍后重试。" })).then(value => {
        cache.set(key, { value, expires: now() + (value.error ? 10_000 : 600_000) });
        if (cache.size > 100) cache.delete(cache.keys().next().value);
        return value;
      }).finally(() => inFlight.delete(key));
      queue = pending; inFlight.set(key, pending); return pending;
    },
    async resolve(id) {
      if (!/^[a-f0-9]{40}$/i.test(id || "")) throw new Error("论文检索标识无效");
      if (resolved.has(id)) return resolved.get(id);
      const pending = queue.catch(() => undefined).then(async () => {
        await wait(lastRequest + minimumDelay - now()); lastRequest = now();
        let failed = false;
        try {
          const work = await (await response(`https://api.semanticscholar.org/graph/v1/paper/${id}?fields=externalIds`)).json();
          const reference = parseArxivReference(work.externalIds?.ArXiv);
          if (reference) return { arxivId: reference.reference };
        } catch { failed = true; }
        const title = titles.get(id);
        if (title) {
          try {
            const params = new URLSearchParams({ search: title, 'per-page': '5', select: 'display_name,locations' });
            const data = await (await response(`https://api.openalex.org/works?${params}`)).json();
            for (const work of Array.isArray(data.results) ? data.results : []) {
              if (searchText(work.display_name) !== searchText(title)) continue;
              for (const location of Array.isArray(work.locations) ? work.locations : []) {
                const reference = parseArxivReference(location.pdf_url) || parseArxivReference(location.landing_page_url);
                if (reference) return { arxivId: reference.reference };
              }
            }
          } catch { /* The final fallback uses arXiv's own index. */ }
          try {
            // Only an exact title match can open a different provider's PDF.
            const match = (await lookupArxiv(title)).find(item => searchText(item.title) === searchText(title));
            if (match) return { arxivId: match.arxivId };
          } catch { failed = true; }
        }
        if (failed) throw new Error("论文来源查询暂不可用，请稍后重试；也可以粘贴 arXiv 链接直接打开。");
        return { sourceUrl: `https://www.semanticscholar.org/paper/${id}` };
      });
      queue = pending;
      const result = await pending;
      resolved.set(id, result);
      if (resolved.size > 100) resolved.delete(resolved.keys().next().value);
      return result;
    },
  };
}
