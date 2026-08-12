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
  if (!value) return undefined;
  return String(value)
    .replace(/^ARXIV:/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
}

function arxivIdFromOpenAlex(work) {
  const direct = normalizeArxivId(work.ids?.arxiv);
  if (direct) return direct;
  const locations = [
    work.primary_location?.landing_page_url,
    work.primary_location?.pdf_url,
    work.best_oa_location?.landing_page_url,
    work.best_oa_location?.pdf_url,
  ];
  for (const value of locations) {
    const match = String(value || "").match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i);
    if (match) return normalizeArxivId(match[1]);
  }
  return undefined;
}

function reasonForScores(relevanceScore, fameScore) {
  if (relevanceScore >= 0.8 && fameScore >= 0.68) return "高度相关 · 近年高影响";
  if (relevanceScore >= 0.8) return "与当前论文高度相关";
  if (fameScore >= 0.72) return "相关方向的近年代表作";
  return "主题与方法均较相关";
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
    abstract: paper.abstract ?? undefined,
    url: paper.url ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined),
    pdfUrl: paper.openAccessPdf?.url ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined),
    arxivId,
    citationCount: paper.citationCount ?? undefined,
    relevanceScore,
    fameScore,
    score: 0.78 * relevanceScore + 0.22 * fameScore,
    reason: reasonForScores(relevanceScore, fameScore),
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
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : work.primary_location?.landing_page_url || work.id,
    pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : work.best_oa_location?.pdf_url || work.primary_location?.pdf_url,
    arxivId,
    citationCount: work.cited_by_count ?? 0,
    _sourceRelevance: sourceRelevance,
  };
}

export function rankRecommendations(input, candidates, currentYear = new Date().getFullYear()) {
  const cutoffYear = currentYear - 2;
  const seedTitle = normalizedTitle(input.title);
  const filtered = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate?.arxivId || !candidate?.year) continue;
    if (candidate.year < cutoffYear || candidate.year > currentYear) continue;
    if (normalizedTitle(candidate.title) === seedTitle) continue;
    if (input.arxivId && normalizeArxivId(input.arxivId) === normalizeArxivId(candidate.arxivId)) continue;
    const key = normalizeArxivId(candidate.arxivId).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
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
      const notableCitations = age === 0 ? 80 : age === 1 ? 220 : 500;
      const fameScore = clamp(Math.log1p(paper.citationCount ?? 0) / Math.log1p(notableCitations));
      const score = relevanceScore * 0.78 + fameScore * 0.22;
      return {
        ...paper,
        relevanceScore,
        fameScore,
        score,
        reason: reasonForScores(relevanceScore, fameScore),
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
  return result.data?.[0] ?? null;
}

async function fetchSemanticScholarRecommendations(input, fetcher) {
  const currentYear = new Date().getFullYear();
  const seed = await resolveSeed(input, fetcher);
  let candidates = [];

  if (seed?.paperId) {
    try {
      const result = await s2Fetch(
        `${S2_RECOMMENDATIONS}/papers/forpaper/${encodeURIComponent(seed.paperId)}?limit=24&fields=${FIELDS}`,
        fetcher,
      );
      candidates = result.recommendedPapers ?? [];
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
  }

  return candidates.map((paper, index) => normalizeRecommendation({
    ...paper,
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

  if (candidates.filter((paper) => paper.arxivId).length < MAX_RECOMMENDATIONS) {
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
