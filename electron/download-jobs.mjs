import { randomUUID } from "node:crypto";

const validId = (value) => {
  if (!/^[a-f0-9-]{36}$/i.test(String(value))) throw new Error("下载任务 ID 无效。");
  return value;
};
export function createDownloadJobs() {
  const jobs = new Map();
  const cancelled = new Map();
  const prune = () => { for (const [id, job] of jobs) if (!job.promise && (Date.now() - job.updatedAt > 600000 || jobs.size > 30)) jobs.delete(id); };
  return {
    async run(id = randomUUID(), source, operation) {
      validId(id); prune();
      for (const [key, at] of cancelled) if (Date.now() - at > 60000) cancelled.delete(key);
      if (cancelled.delete(id)) throw new Error("下载已暂停。可以重新开始下载。");
      const previous = jobs.get(id);
      if (previous?.promise) {
        if (previous.source !== source) throw new Error("同一下载任务不能更换论文。");
        return previous.promise;
      }
      if ([...jobs.values()].filter((job) => job.promise).length >= 4) throw new Error("同时下载的论文较多，请稍后重试。");
      const job = { id, source, phase: "metadata", received: 0, resumed: false, updatedAt: Date.now(), controller: new AbortController() };
      jobs.set(id, job);
      job.promise = (async () => {
        try {
          const result = await Promise.resolve().then(() => operation({ signal: job.controller.signal, onProgress: (progress) => { Object.assign(job, progress, { phase: progress.phase === "complete" ? "preparing" : progress.phase, updatedAt: Date.now() }); } }));
          job.phase = "complete"; return result;
        } catch (error) {
          job.phase = job.controller.signal.aborted ? "paused" : "error";
          job.error = job.phase === "paused" ? "下载已暂停。继续时会尝试复用已下载的部分。" : error instanceof Error ? error.message : String(error);
          throw new Error(job.error);
        } finally { delete job.promise; job.updatedAt = Date.now(); }
      })();
      return job.promise;
    },
    status(id) {
      const job = jobs.get(validId(id));
      if (!job) return null;
      const { controller: _controller, promise: _promise, ...state } = job;
      return state;
    },
    cancel(id) {
      const job = jobs.get(validId(id));
      if (job) job.controller.abort(new DOMException("下载已暂停", "AbortError"));
      else { cancelled.set(id, Date.now()); if (cancelled.size > 100) cancelled.delete(cancelled.keys().next().value); }
    },
    hasActive() { return [...jobs.values()].some((job) => job.promise); },
    async close() { const pending = [...jobs.values()].filter((job) => job.promise); pending.forEach((job) => job.controller.abort()); await Promise.allSettled(pending.map((job) => job.promise)); },
  };
}
