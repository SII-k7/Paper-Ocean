const S2_GRAPH = "https://api.semanticscholar.org/graph/v1";
const S2_RECOMMENDATIONS = "https://api.semanticscholar.org/recommendations/v1";
const OPENALEX_WORKS = "https://api.openalex.org/works";
const OPENALEX_ARXIV_SOURCE = "S4306400194";
const MAX_RECOMMENDATIONS = 8;
const FIELDS = [
  "paperId",
  "title",
  "authors",
  "year",
  "publicationDate",
  "abstract",
  "url",
  "externalIds",
  "citationCount",
  "openAccessPdf",
].join(",");

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "of", "on", "or", "that", "the", "this", "to", "toward", "towards", "using", "via", "with",
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(fetcher, url, label, { retry429 = false } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) return response.json();
      lastError = new Error(`${label} HTTP ${response.status}`);
      const retryable = response.status >= 500 || (retry429 && response.status === 429);
      if (!retryable) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await delay(650 * (attempt + 1));
  }
  throw lastError;
}

function clamp(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function normalizedTitle(value = "") {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokens(value = "") {
  return new Set(
    normalizedTitle(value)
      .split(" ")
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
  );
}

function lexicalOverlap(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return clamp(intersection / Math.sqrt(leftTokens.size * rightTokens.size));
}

function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== "object") return undefined;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions || []) words.push([position, word]);
  }
  words.sort((left, right) => left[0] - right[0]);
  const abstract = words.map((entry) => entry[1]).join(" ").trim();
  return abstract || undefined;
}

function normalizeArxivId(value) {
  return parseArxivReference(String(value || "").replace(/^ARXIV:/i, ""))?.id;
}

function arxivIdFromOpenAlex(work) {
  const direct = normalizeArxivId(work.ids?.arxiv);
  if (direct) return direct;
  const locations = [
    work.primary_location?.landing_page_url,
    work.primary_location?.pdf_url,
    work.best_oa_location?.landing_page_url,
    work.best_oa_location?.pdf_url,
    ...(work.locations || []).flatMap((location) => [location.landing_page_url, location.pdf_url]),
  ];
  for (const value of locations) {
    const id = normalizeArxivId(value);
    if (id) return id;
  }
  return undefined;
}

function reasonForScores(_relevanceScore, _fameScore, relation) {
  if (relation === "reference") return "文献数据库中的引用关系 · 追溯方法来源";
  if (relation === "similar") return "相似论文服务返回 · 相关度优先排序";
  return "主题相关候选 · 根据标题与摘要检索";
}

function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export function normalizeRecommendation(paper) {
  const arxivId = normalizeArxivId(paper.externalIds?.ArXiv);
  const relevanceScore = clamp(paper._sourceRelevance ?? 0.7);
  const fameScore = clamp(Math.log1p(paper.citationCount ?? 0) / Math.log1p(300));
  return {
    paperId: paper.paperId,
    title: paper.title || "Untitled paper",
    authors: (paper.authors || []).slice(0, 5).map((author) => author.name).filter(Boolean),
    year: paper.year ?? undefined,
    publishedAt: publicationDate(paper.publicationDate) || publicationDate(String(paper.year || "")),
    abstract: paper.abstract ?? undefined,
    url: safeUrl(paper.url) ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined),
    pdfUrl: paper.openAccessPdf?.url ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined),
    arxivId,
    citationCount: paper.citationCount ?? undefined,
    relevanceScore,
    fameScore,
    score: 0.78 * relevanceScore + 0.22 * fameScore,
    reason: reasonForScores(relevanceScore, fameScore, paper.relation),
    source: "Semantic Scholar",
    sourceUrl: safeUrl(paper.url),
    relation: paper.relation || "search",
    ...(paper._sourceRelevance !== undefined ? { _sourceRelevance: paper._sourceRelevance } : {}),
  };
}

function normalizeOpenAlexRecommendation(work, index, count, maxRawRelevance) {
  const arxivId = arxivIdFromOpenAlex(work);
  const sourceRelevance = Number.isFinite(work.relevance_score)
    ? clamp(work.relevance_score / Math.max(maxRawRelevance, 1))
    : Math.max(0.45, 1 - index / Math.max(count * 1.35, 1));
  return {
    paperId: work.id?.split("/").pop() || work.id || `openalex-${index}`,
    title: work.display_name || work.title || "Untitled paper",
    authors: (work.authorships || [])
      .slice(0, 5)
      .map((authorship) => authorship.author?.display_name)
      .filter(Boolean),
    year: work.publication_year ?? undefined,
    publishedAt: publicationDate(work.publication_date) || publicationDate(String(work.publication_year || "")),
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : safeUrl(work.primary_location?.landing_page_url) || safeUrl(work.id),
    pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : work.best_oa_location?.pdf_url || work.primary_location?.pdf_url,
    arxivId,
    citationCount: work.cited_by_count ?? 0,
    _sourceRelevance: sourceRelevance,
    source: "OpenAlex",
    sourceUrl: safeUrl(work.id),
    relation: "search",
  };
}

export function rankRecommendations(input, candidates, currentYear = new Date().getFullYear()) {
  const cutoffYear = currentYear - 2;
  const foundations = input.mode === "foundations";
  const seedTitle = normalizedTitle(input.title);
  const filtered = [];
  const seen = new Map();

  for (const candidate of candidates) {
    if (!candidate?.title?.trim() || candidate.title === "Untitled paper") continue;
    if (foundations ? candidate?.relation !== "reference" || (!candidate?.arxivId && !safeUrl(candidate?.url)) : !candidate?.arxivId || !candidate?.year) continue;
    if ((!foundations && candidate.year < cutoffYear) || candidate.year > currentYear) continue;
    if (normalizedTitle(candidate.title) === seedTitle) continue;
    if (input.arxivId && normalizeArxivId(input.arxivId) === normalizeArxivId(candidate.arxivId)) continue;
    const key = (normalizeArxivId(candidate.arxivId) || candidate.paperId || candidate.url).toLowerCase();
    const titleKey = `title:${normalizedTitle(candidate.title)}`;
    const existing = seen.get(key) ?? seen.get(titleKey);
    if (existing !== undefined) {
      if (!filtered[existing].arxivId && candidate.arxivId) filtered[existing] = candidate;
      continue;
    }
    seen.set(key, filtered.length); seen.set(titleKey, filtered.length);
    filtered.push(candidate);
  }

  const rawScores = filtered.map((paper) => Math.max(0, Number(paper._sourceRelevance) || 0));
  const maxRaw = Math.max(...rawScores, 0);
  const seedText = `${input.title || ""} ${String(input.abstract || "").slice(0, 1_600)}`;

  return filtered
    .map((paper, index) => {
      const rankPrior = Math.max(0.42, 1 - index / Math.max(filtered.length * 1.4, 1));
      const semantic = maxRaw > 0 ? clamp((Number(paper._sourceRelevance) || 0) / maxRaw) : rankPrior;
      const lexical = lexicalOverlap(
        seedText,
        `${paper.title || ""} ${String(paper.abstract || "").slice(0, 1_000)}`,
      );
      const relevanceScore = clamp(semantic * 0.82 + lexical * 0.18);
      const age = currentYear - paper.year;
      const notableCitations = foundations ? 2000 : age === 0 ? 80 : age === 1 ? 220 : 500;
      const fameScore = clamp(Math.log1p(paper.citationCount ?? 0) / Math.log1p(notableCitations));
      const score = relevanceScore * 0.78 + fameScore * 0.22;
      return {
        ...paper,
        relevanceScore,
        fameScore,
        score,
        reason: reasonForScores(relevanceScore, fameScore, paper.relation),
      };
    })
    .filter((paper) => paper.relevanceScore >= 0.48 && paper.score >= 0.5)
    .sort((left, right) => (
      right.score - left.score
      || right.relevanceScore - left.relevanceScore
      || (right.citationCount ?? 0) - (left.citationCount ?? 0)
    ))
    .slice(0, MAX_RECOMMENDATIONS)
    .map(({ _sourceRelevance: _ignored, ...paper }) => paper);
}

async function fetchOpenAlexRecommendations(input, fetcher) {
  if (input.mode === "foundations") {
    const seedUrl = new URL(OPENALEX_WORKS);
    seedUrl.searchParams.set("search", input.title); seedUrl.searchParams.set("per-page", "5");
    const result = await fetchJson(fetcher, seedUrl, "OpenAlex");
    const seed = result.results?.find((work) => (input.arxivId && arxivIdFromOpenAlex(work) === normalizeArxivId(input.arxivId)) || normalizedTitle(work.display_name || work.title) === normalizedTitle(input.title));
    const seedId = String(seed?.id || "").match(/^https:\/\/openalex\.org\/(W\d+)$/)?.[1];
    if (!seedId) return [];
    const referenceUrl = new URL(OPENALEX_WORKS);
    referenceUrl.searchParams.set("filter", `cited_by:${seedId}`);
    referenceUrl.searchParams.set("sort", "cited_by_count:desc"); referenceUrl.searchParams.set("per-page", "100");
    const references = await fetchJson(fetcher, referenceUrl, "OpenAlex 参考文献");
    return (references.results || []).map((work, index, works) => ({ ...normalizeOpenAlexRecommendation(work, index, works.length, 1), relation: "reference", _sourceRelevance: .85 }));
  }
  const currentYear = new Date().getFullYear();
  const longContext = input.abstract?.trim();
  const parameter = longContext && longContext.length >= 80 ? "search.semantic" : "search";
  const query = (longContext || input.title).slice(0, 2_000);
  if (!query.trim()) return [];

  const url = new URL(OPENALEX_WORKS);
  url.searchParams.set(parameter, query);
  url.searchParams.set(
    "filter",
    parameter === "search.semantic"
      ? `publication_year:>${currentYear - 3},primary_location.source.id:${OPENALEX_ARXIV_SOURCE}`
      : `from_publication_date:${currentYear - 2}-01-01,to_publication_date:${currentYear}-12-31,primary_location.source.id:${OPENALEX_ARXIV_SOURCE}`,
  );
  url.searchParams.set("per-page", "25");
  const result = await fetchJson(fetcher, url, "OpenAlex");
  const works = result.results || [];
  const maxRawRelevance = Math.max(
    ...works.map((work) => Number.isFinite(work.relevance_score) ? work.relevance_score : 0),
    0,
  );
  return works.map((work, index) => (
    normalizeOpenAlexRecommendation(work, index, works.length, maxRawRelevance)
  ));
}

async function s2Fetch(url, fetcher) {
  const response = await fetcher(url, {
    headers: { "User-Agent": "PaperOcean/0.2 local-reader" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`);
  return response.json();
}

async function resolveSeed({ title, arxivId }, fetcher) {
  if (arxivId) {
    try {
      return await s2Fetch(`${S2_GRAPH}/paper/${encodeURIComponent(`ARXIV:${arxivId}`)}?fields=${FIELDS}`, fetcher);
    } catch {
      // Fall through to title search when the arXiv record is not present yet.
    }
  }

  const query = title.trim();
  if (!query) return null;
  const result = await s2Fetch(
    `${S2_GRAPH}/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=${FIELDS}`,
    fetcher,
  );
  return result.data?.find((paper) => normalizedTitle(paper.title) === normalizedTitle(title)) ?? null;
}

async function fetchSemanticScholarRecommendations(input, fetcher) {
  const currentYear = new Date().getFullYear();
  const seed = await resolveSeed(input, fetcher);
  let candidates = [];
  let relation = "search";

  if (input.mode === "foundations") {
    if (!seed?.paperId) return [];
    const references = await s2Fetch(`${S2_GRAPH}/paper/${encodeURIComponent(seed.paperId)}/references?limit=100&fields=${FIELDS}`, fetcher);
    return (references.data || []).flatMap((item) => item.citedPaper ? [normalizeRecommendation({ ...item.citedPaper, relation: "reference", _sourceRelevance: .85 })] : []);
  }

  if (seed?.paperId) {
    try {
      const result = await s2Fetch(
        `${S2_RECOMMENDATIONS}/papers/forpaper/${encodeURIComponent(seed.paperId)}?limit=24&fields=${FIELDS}`,
        fetcher,
      );
      candidates = result.recommendedPapers ?? [];
      relation = "similar";
    } catch {
      candidates = [];
    }
  }

  if (!candidates.length) {
    const fallbackQuery = [input.title, input.abstract?.slice(0, 240)].filter(Boolean).join(" ");
    const result = await s2Fetch(
      `${S2_GRAPH}/paper/search?query=${encodeURIComponent(fallbackQuery)}&year=${currentYear - 2}-${currentYear}&limit=24&fields=${FIELDS}`,
      fetcher,
    );
    candidates = result.data ?? [];
    relation = "search";
  }

  return candidates.map((paper, index) => normalizeRecommendation({
    ...paper,
    relation,
    _sourceRelevance: Math.max(0.45, 1 - index / Math.max(candidates.length * 1.35, 1)),
  }));
}

export async function fetchRecommendations(input, fetcher = globalThis.fetch) {
  const errors = [];
  const candidates = [];

  try {
    candidates.push(...await fetchOpenAlexRecommendations(input, fetcher));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (rankRecommendations(input, candidates).length < MAX_RECOMMENDATIONS) {
    try {
      candidates.push(...await fetchSemanticScholarRecommendations(input, fetcher));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const ranked = rankRecommendations(input, candidates);
  if (ranked.length || errors.length < 2) return ranked;
  throw new Error(`推荐服务暂时不可用：${errors.join("；")}`);
}
import { parseArxivReference, publicationDate } from "./paper-metadata.mjs";
