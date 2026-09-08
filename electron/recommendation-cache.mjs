import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchRecommendations } from "./recommendations.mjs";
import { parseArxivReference } from "./paper-metadata.mjs";

export function createRecommendationService({ cacheDir, fetcher = globalThis.fetch, load = fetchRecommendations, now = Date.now, ttlMs = 24 * 60 * 60 * 1000, concurrency = 2 } = {}) {
  const tasks = new Map(), failures = new Map(), queue = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift(); active++;
      void job.run().then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  };
  const read = async (file) => {
    try {
      if ((await fs.stat(file)).size > 2 * 1024 * 1024) return null;
      const cached = JSON.parse(await fs.readFile(file, "utf8"));
      return cached.version === 2 && Number.isFinite(cached.fetchedAt) && Array.isArray(cached.items) && cached.items.length <= 8 && cached.items.every((item) => typeof item.title === "string" && typeof item.paperId === "string" && Array.isArray(item.authors)) ? cached : null;
    } catch { return null; }
  };
  const update = (key, input, file) => {
    if (tasks.has(key)) return tasks.get(key);
    if (queue.length >= 32) return Promise.reject(new Error("推荐任务较多，请稍后重试。"));
    const promise = new Promise((resolve, reject) => {
      queue.push({ resolve, reject, run: async () => {
        try {
          const items = await load(input, fetcher);
          if (!Array.isArray(items)) throw new Error("推荐服务返回格式无效。");
          const snapshot = { version: 2, items: items.slice(0, 8), fetchedAt: now() };
          let error;
          const temporary = `${file}.part-${randomUUID()}`;
          try {
            await fs.mkdir(cacheDir, { recursive: true });
            await fs.writeFile(temporary, JSON.stringify(snapshot), { flag: "wx" });
            await fs.rename(temporary, file);
          } catch { error = "推荐已获取，但本地缓存未能保存。"; }
          finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
          failures.delete(key);
          return { ...snapshot, cache: "fresh", pending: false, error };
        } catch (error) {
          failures.set(key, { at: now(), message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      } });
    });
    tasks.set(key, promise);
    void promise.then(() => tasks.delete(key), () => tasks.delete(key));
    drain();
    return promise;
  };
  return {
    async get(value = {}) {
      const input = {
        title: String(value.title || "").trim().slice(0, 500),
        abstract: String(value.abstract || "").trim().slice(0, 8000),
        arxivId: parseArxivReference(value.arxivId)?.id,
        mode: value.mode === "foundations" ? "foundations" : "recent",
      };
      if (!input.title) throw new Error("请先打开有标题的论文。");
      const key = createHash("sha256").update(JSON.stringify({ version: 2, year: new Date(now()).getUTCFullYear(), ...input })).digest("hex");
      const file = path.join(cacheDir, `${key}.json`);
      const cached = await read(file);
      const age = cached ? now() - cached.fetchedAt : Infinity;
      if (cached && age >= 0 && age < ttlMs && !value.refresh) return { ...cached, cache: "cached", pending: tasks.has(key) };
      const failure = failures.get(key);
      if (failure && now() - failure.at < 5 * 60 * 1000 && !value.refresh) {
        if (cached) return { ...cached, cache: "stale", pending: false, error: failure.message };
        throw new Error(failure.message);
      }
      const task = update(key, input, file);
      if (cached && !value.refresh) {
        void task.catch(() => undefined);
        return { ...cached, cache: "stale", pending: true };
      }
      try { return await task; }
      catch (error) {
        if (cached) return { ...cached, cache: "stale", pending: false, error: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    },
  };
}
