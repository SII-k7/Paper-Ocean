export function publicationDate(value) {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d{4})(?:[-/](\d{2})(?:[-/](\d{2}))?)?(?:T.*)?$/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  if (Number(year) < 1000 || Number(year) > 9999) return undefined;
  if (month && (Number(month) < 1 || Number(month) > 12)) return undefined;
  if (day && (Number(day) < 1 || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate())) return undefined;
  return [year, month, day].filter(Boolean).join("-");
}

export function paperMetadata(value) {
  return {
    arxivVersion: Number.isInteger(value.arxivVersion) && value.arxivVersion > 0 ? value.arxivVersion : undefined,
    authors: Array.isArray(value.authors) ? value.authors.filter((item) => typeof item === "string").map((item) => item.slice(0, 300)).slice(0, 1000) : undefined,
    publishedAt: publicationDate(value.publishedAt),
    revisedAt: publicationDate(value.revisedAt),
    readingStatus: ["unread", "reading", "done"].includes(value.readingStatus) ? value.readingStatus : "unread",
    managedOriginal: value.managedOriginal === true,
  };
}

export function parseArxivReference(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname.toLowerCase()) || url.username || url.password) return null;
      value = decodeURIComponent(url.pathname).replace(/^\/(?:abs|pdf)\//i, "");
    } catch { return null; }
  }
  const match = value.match(/^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v([1-9]\d*))?(?:\.pdf)?$/i);
  if (!match) return null;
  if (match[2] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 100_000)) return null;
  return { id: match[1], version: match[2] ? Number(match[2]) : undefined, reference: `${match[1]}${match[2] ? `v${match[2]}` : ""}` };
}
