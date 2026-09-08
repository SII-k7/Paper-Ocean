export const RELEASES_URL = "https://github.com/SII-k7/Paper-Ocean/releases";
const ENDPOINT = "https://api.github.com/repos/SII-k7/Paper-Ocean/releases/latest";
function stableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
  return match ? match.slice(1).map(Number) : null;
}
export function newerRelease(candidate, current) {
  const next = stableVersion(candidate), installed = stableVersion(current);
  if (!next || !installed) return null;
  for (let i = 0; i < 3; i++) if (next[i] !== installed[i]) return next[i] > installed[i];
  return false;
}
export async function checkRelease(current, fetcher = globalThis.fetch) {
  let response;
  try { response = await fetcher(ENDPOINT, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", signal: AbortSignal.timeout(12000), redirect: "error" }); }
  catch { throw new Error("暂时无法连接 GitHub，请稍后重试或查看发布页面。"); }
  if (response.status === 404) throw new Error("尚未找到公开正式版本。可以在发布页面查看。");
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "GitHub 暂时限制了检查请求，请稍后重试。" : "暂时无法检查更新，可以直接查看发布页面。");
  const data = await response.json();
  const newer = newerRelease(data?.tag_name, current);
  if (newer === null || data.draft || data.prerelease) throw new Error("版本信息无法比较，请查看发布页面。");
  // Construct the official link ourselves rather than trusting a response URL.
  return { version: data.tag_name.replace(/^v/, ""), newer, checkedAt: Date.now(), url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}` };
}
