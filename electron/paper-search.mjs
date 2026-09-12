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

function openAlexReference(work) {
  const candidates = [work.external_id, ...(Array.isArray(work.locations) ? work.locations.flatMap(location => [location.pdf_url, location.landing_page_url]) : [])];
  return candidates.map(value => parseArxivReference(value)?.reference).find(Boolean);
}

export function openAlexSuggestions(data) {
  return (Array.isArray(data.results) ? data.results : []).flatMap(work => {
    const id = /^https:\/\/openalex\.org\/(W\d{1,15})$/i.exec(work.id || "")?.[1];
    if (!id || typeof work.display_name !== "string" || !work.display_name.trim()) return [];
    return [{ key: `oa:${id}`, openAlexId: id, arxivId: openAlexReference(work), title: work.display_name.slice(0, 600),
      subtitle: String(work.hint || work.publication_year || "").slice(0, 300), source: "openalex" }];
  });
}

export function createPaperSearch({ fetcher = globalThis.fetch, minimumDelay = 1000, arxivDelay = 3000, now = Date.now } = {}) {
  const cache = new Map(), inFlight = new Map(), titles = new Map(), resolved = new Map();
  const nextRequest = new Map();
  let running = 0, queued;
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
  async function throttle(provider, delay) {
    const start = Math.max(now(), nextRequest.get(provider) || 0);
    nextRequest.set(provider, start + delay);
    await wait(start - now());
  }
  async function response(url, timeout = 5000) {
    const result = await fetcher(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "PaperOcean local-reader" } });
    if (!result.ok) throw new Error(`论文检索服务暂不可用（${result.status}）`);
    return result;
  }
  function rank(query, items) {
    const seen = new Set();
    return items.map(item => ({ item, score: titleMatchScore(query, item.title), topic: classifyPaper(item).category !== "待分类" ? 5 : 0 }))
      .filter(({ item, score }) => {
        const key = searchText(item.title);
        if (!score || seen.has(key)) return false;
        seen.add(key); return true;
      }).sort((a, b) => b.score + b.topic - a.score - a.topic).slice(0, 8).map(({ item }) => {
        if (item.semanticId || item.openAlexId) titles.set(item.semanticId || item.openAlexId, item.title);
        while (titles.size > 800) titles.delete(titles.keys().next().value);
        return item;
      });
  }
  async function lookup(query) {
    await throttle("semantic-scholar", minimumDelay);
    try {
      const json = await (await response(`https://api.semanticscholar.org/graph/v1/paper/autocomplete?query=${encodeURIComponent(query)}`)).json();
      const items = (Array.isArray(json.matches) ? json.matches : []).filter(item => /^[a-f0-9]{40}$/i.test(item.id) && typeof item.title === "string").slice(0, 8)
        .map(item => ({ key: `s2:${item.id}`, semanticId: item.id, title: item.title.slice(0, 600), subtitle: String(item.authorsYear || "").slice(0, 300), source: "semantic-scholar" }));
      if (items.length) {
        const matches = rank(query, items);
        if (matches.length) return { items: matches };
      }
    } catch { /* A second typeahead provider also supports unfinished titles. */ }
    try {
      await throttle("openalex", minimumDelay);
      const data = await (await response(`https://api.openalex.org/autocomplete/works?q=${encodeURIComponent(query)}`)).json();
      const items = rank(query, openAlexSuggestions(data));
      if (items.length) return { items };
      // Autocomplete is prefix-based. The title index also supports one-edit typos.
      const terms = searchText(query).split(" ").filter(Boolean).slice(0, 8);
      if (terms.some(term => term.length >= 4)) {
        await throttle("openalex", minimumDelay);
        const params = new URLSearchParams({ filter: `title.search:${terms.map(term => term.length >= 4 ? `${term}~1` : term).join(" AND ")}`, "per-page": "50", select: "id,display_name,publication_year,locations" });
        const fuzzy = rank(query, openAlexSuggestions(await (await response(`https://api.openalex.org/works?${params}`, 7000)).json()));
        if (fuzzy.length) return { items: fuzzy };
      }
    } catch { /* arXiv is a final fallback for complete title words. */ }
    return { items: rank(query, await lookupArxiv(query)) };
  }
  async function lookupArxiv(query) {
    await throttle("arxiv", arxivDelay);
    const terms = searchText(query).split(" ").filter(Boolean).slice(0, 10);
    const expression = terms.map(word => `ti:${word}`).join(" AND ");
    const params = new URLSearchParams({ search_query: expression, start: "0", max_results: "8", sortBy: "relevance" });
    const xml = await (await response(`https://export.arxiv.org/api/query?${params}`)).text();
    if (!/<feed[\s>]/.test(xml) || /<id>[^<]*api\/errors/.test(xml)) throw new Error("论文搜索暂不可用，请稍后重试");
    return arxivSuggestions(xml).sort((a, b) => titleMatchScore(query, b.title) - titleMatchScore(query, a.title));
  }
  function run(job) {
    running++;
    lookup(job.query).catch(() => ({ items: [], error: "在线论文联想暂不可用，本地匹配仍可使用。请点击搜索重试。" })).then(value => {
      // Never cache outages: an explicit retry should reach the service immediately.
      if (!value.error) cache.set(job.key, { value, expires: now() + (value.items.length ? 600_000 : 15_000) });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      inFlight.delete(job.key); running--;
      if (queued) { const next = queued; queued = undefined; run(next); }
      job.resolve(value);
    });
  }
  return {
    search(input) {
      const query = String(input || "").trim().slice(0, 100), key = searchText(query);
      if (key.length < 2 || parseArxivReference(query)) return Promise.resolve({ items: [] });
      if (cache.has(key) && cache.get(key).expires > now()) return Promise.resolve(cache.get(key).value);
      if (inFlight.has(key)) return inFlight.get(key);
      let resolve;
      const pending = new Promise(done => { resolve = done; });
      const job = { query, key, resolve };
      inFlight.set(key, pending);
      if (running < 2) run(job);
      else {
        // Keep the latest typed query instead of dropping it behind obsolete prefixes.
        if (queued) { inFlight.delete(queued.key); queued.resolve({ items: [] }); }
        queued = job;
      }
      return pending;
    },
    async resolve(id) {
      const isOpenAlex = /^W\d{1,15}$/i.test(id || "");
      if (!isOpenAlex && !/^[a-f0-9]{40}$/i.test(id || "")) throw new Error("论文检索标识无效");
      if (resolved.has(id)) return resolved.get(id);
      const pending = (async () => {
        await throttle(isOpenAlex ? "openalex" : "semantic-scholar", minimumDelay);
        let failed = false;
        try {
          const work = await (await response(isOpenAlex ? `https://api.openalex.org/works/${id}?select=id,display_name,locations` : `https://api.semanticscholar.org/graph/v1/paper/${id}?fields=externalIds`)).json();
          if (isOpenAlex && work.id !== `https://openalex.org/${id}`) throw new Error("论文来源标识不一致");
          const reference = parseArxivReference(isOpenAlex ? openAlexReference(work) : work.externalIds?.ArXiv);
          if (reference) return { arxivId: reference.reference };
        } catch { failed = true; }
        const title = titles.get(id);
        if (title) {
          try {
            await throttle("openalex", minimumDelay);
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
        return { sourceUrl: isOpenAlex ? `https://openalex.org/${id}` : `https://www.semanticscholar.org/paper/${id}` };
      })();
      const result = await pending;
      resolved.set(id, result);
      if (resolved.size > 100) resolved.delete(resolved.keys().next().value);
      return result;
    },
  };
}
