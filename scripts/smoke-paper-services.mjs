import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadArxivPaper } from "../electron/paper-services.mjs";
import { fetchRecommendations } from "../electron/recommendations.mjs";
import { windowsSystemFetch } from "../electron/windows-fetch.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-paper-smoke-"));

try {
  const paper = await downloadArxivPaper("1706.03762", tempRoot, windowsSystemFetch);
  if (!paper.dataBase64 || !paper.title) throw new Error("arXiv 论文没有完整下载");
  console.log(`PAPER ${paper.arxivId} ${paper.title}`);

  const recommendations = await fetchRecommendations({
    arxivId: paper.arxivId,
    title: paper.title,
    abstract: paper.abstract,
  }, windowsSystemFetch);
  if (!recommendations.length) throw new Error("没有获得相关论文推荐");
  const cutoffYear = new Date().getFullYear() - 2;
  if (recommendations.some((item) => !item.arxivId || !item.year || item.year < cutoffYear)) {
    throw new Error("推荐结果包含不可直接打开或超过近三年范围的论文");
  }
  if (recommendations.some((item, index) => index > 0 && item.score > recommendations[index - 1].score)) {
    throw new Error("推荐结果没有按综合得分降序排列");
  }
  console.log(`RECOMMENDATIONS ${recommendations.length}`);
  console.log(`FIRST ${recommendations[0].year} ${Math.round(recommendations[0].score * 100)} ${recommendations[0].title}`);
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedOsTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolvedTemp.startsWith(resolvedOsTemp)) {
    await fs.rm(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
