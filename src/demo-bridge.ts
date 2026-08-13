import type { CodexEvent, CodexModel, LibraryState, OpenedPaper, Recommendation } from "./types";

const DEMO_PDF_URL = "/output/playwright/1706.03762.pdf";

async function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}

async function demoPaper(source = ""): Promise<OpenedPaper> {
  const response = await fetch(DEMO_PDF_URL);
  if (!response.ok) throw new Error("演示论文尚未准备好");
  const recommendation = DEMO_RECOMMENDATIONS.find((paper) => source.includes(paper.arxivId ?? "--"));
  const id = recommendation ? `demo-${recommendation.paperId}` : "demo-attention-is-all-you-need";
  return {
    id,
    name: `${recommendation?.arxivId ?? "1706.03762"}.pdf`,
    path: `browser-demo/${id}.pdf`,
    sourceUrl: `https://arxiv.org/abs/${recommendation?.arxivId ?? "1706.03762"}`,
    arxivId: recommendation?.arxivId ?? "1706.03762",
    title: recommendation?.title ?? "Attention Is All You Need",
    abstract: recommendation?.abstract ?? "The Transformer replaces recurrence and convolutions with attention mechanisms for sequence transduction.",
    openedAt: Date.now(),
    dataBase64: await blobToBase64(await response.blob()),
  };
}

const DEMO_RECOMMENDATIONS: Recommendation[] = [
  {
    paperId: "demo-1",
    title: "Recent Advances in Efficient Transformer Architectures",
    authors: ["Demo Author"],
    year: new Date().getFullYear(),
    arxivId: "2501.12345",
    citationCount: 180,
    abstract: "A recent overview of efficient Transformer architectures.",
    relevanceScore: 0.93,
    fameScore: 0.81,
    score: 0.9,
    reason: "高度相关 · 近年高影响",
  },
  {
    paperId: "demo-2",
    title: "Long-Context Attention for Scientific Documents",
    authors: ["Demo Author", "Demo Collaborator"],
    year: new Date().getFullYear() - 1,
    arxivId: "2502.12345",
    citationCount: 95,
    abstract: "Studies long-context attention for scientific document understanding.",
    relevanceScore: 0.86,
    fameScore: 0.68,
    score: 0.82,
    reason: "与当前论文高度相关",
  },
  {
    paperId: "demo-3",
    title: "Retrieval-Augmented Reading Across Research Papers",
    authors: ["Demo Researcher"],
    year: new Date().getFullYear() - 2,
    arxivId: "2403.12345",
    citationCount: 42,
    abstract: "Retrieves evidence across multiple research papers for grounded answers.",
    relevanceScore: 0.78,
    fameScore: 0.51,
    score: 0.72,
    reason: "主题与方法均较相关",
  },
];

const DEMO_MODELS: CodexModel[] = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "旗舰能力，适合严谨推导与深度论文分析。",
    defaultEffort: "low",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "质量与速度均衡，适合日常精读。",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    isDefault: false,
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "响应最快，适合快速浏览与提取。",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    isDefault: false,
  },
];

export function installBrowserDemoBridge() {
  let savedLibrary: LibraryState = {
    papers: [],
    messagesByScope: {},
    threadsByScope: {},
    aiSettingsByScope: {},
    openPaperIds: [],
  };
  const listeners = new Set<(event: CodexEvent) => void>();
  const demoTurns = new Map<string, { threadId: string; timers: number[] }>();
  const emit = (event: CodexEvent) => listeners.forEach((listener) => listener(event));

  window.paperOcean = {
    runtime: "demo",
    openPdf: demoPaper,
    reopenPdf: demoPaper,
    openUrl: demoPaper,
    openExternal: async () => undefined,
    setTheme: async (theme) => theme,
    saveContext: async ({ paper }) => ({
      paperDir: `browser-demo/${paper.id}`,
      contextPath: `browser-demo/${paper.id}/PAPER_CONTEXT.md`,
    }),
    savePageImage: async ({ paperId, page }) => `browser-demo/${paperId}/page-${page}.png`,
    prepareConversation: async ({ papers }) => ({
      contextDir: "browser-demo/research-context",
      entries: papers.map((paper) => ({
        key: `paper-${paper.id}`,
        path: `browser-demo/${paper.id}/PAPER_CONTEXT.md`,
        kind: "untrusted" as const,
      })),
      paperCount: papers.length,
      characterCount: 42_000 * papers.length,
    }),
    codex: {
      status: async () => ({ connected: true, accountType: "chatgpt", planType: "pro" }),
      login: async () => ({ alreadyConnected: true }),
      models: async () => DEMO_MODELS,
      chooseExecutable: async () => ({ connected: true, accountType: "chatgpt", planType: "pro" }),
      rateLimits: async () => ({ primary: { usedPercent: 12, windowDurationMins: 300 } }),
      startThread: async () => "demo-thread",
      resumeThread: async ({ threadId }) => threadId,
      sendTurn: async ({ threadId }) => {
        const turnId = crypto.randomUUID();
        const firstTimer = window.setTimeout(() => emit({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            delta: "这篇论文的核心突破是：用自注意力完全替代循环与卷积结构，从而并行处理序列，并更直接地建模长距离依赖。[第 1 页]",
          },
        }), 360);
        const completionTimer = window.setTimeout(() => {
          demoTurns.delete(turnId);
          emit({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, threadId, status: "completed" } },
          });
        }, 760);
        demoTurns.set(turnId, { threadId, timers: [firstTimer, completionTimer] });
        return { turnId };
      },
      interrupt: async ({ threadId, turnId }) => {
        const turn = demoTurns.get(turnId);
        if (!turn) return;
        turn.timers.forEach((timer) => window.clearTimeout(timer));
        demoTurns.delete(turnId);
        emit({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, threadId, status: "interrupted" } },
        });
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    recommendations: async () => DEMO_RECOMMENDATIONS,
    prepareRecommendationPreview: async () => ({ status: "render", pdfUrl: DEMO_PDF_URL }),
    saveRecommendationThumbnail: async ({ dataUrl }) => dataUrl,
    library: {
      load: async () => savedLibrary,
      save: async (state) => { savedLibrary = state; },
    },
  };
}
