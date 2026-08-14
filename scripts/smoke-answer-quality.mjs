import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexClient } from "../electron/codex-client.mjs";
import { buildPaperTurnPrompt } from "../electron/paper-prompt.mjs";

const client = new CodexClient();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-quality-smoke-"));
let finalText = "";

function waitForTurn(threadId, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待 Codex 深度回答超时"));
    }, timeoutMs);

    const onEvent = (event) => {
      const params = event.params ?? {};
      const eventThreadId = params.threadId ?? params.turn?.threadId;
      if (eventThreadId && eventThreadId !== threadId) return;

      if (event.method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : params.delta?.text;
        if (delta) finalText += delta;
      }
      if (event.method === "item/completed" && params.item?.type === "agentMessage") {
        finalText = params.item.text || finalText;
      }
      if (event.method === "error" && params.willRetry !== true) {
        cleanup();
        reject(new Error(params.error?.message || "Codex 返回错误"));
      }
      if (event.method === "turn/completed") {
        cleanup();
        if (params.turn?.status === "failed") {
          reject(new Error(params.turn?.error?.message || "Codex turn 失败"));
        } else {
          resolve(params.turn);
        }
      }
    };

    function cleanup() {
      clearTimeout(timer);
      client.off("event", onEvent);
    }

    client.on("event", onEvent);
  });
}

try {
  const manifestPath = path.join(tempRoot, "CONTEXT_MANIFEST.md");
  const paperPath = path.join(tempRoot, "paper.md");
  const paperText = [
    "# FactorRoute: Adaptive Expert Routing for Long-Horizon Robot Control",
    "",
    "## 第 1 页",
    "本文研究长时程机器人控制中任务切换导致的策略干扰。输入是最近 16 步观测历史与目标指令，输出是关节动作。核心假设是负载、地形和任务阶段可以由不同潜变量解释。",
    "",
    "## 第 2 页",
    "方法包含共享时序编码器、三个专门化专家、稀疏路由器和安全残差头。编码器先生成状态表示；路由器根据上下文选择两个专家；专家输出经门控加权后进入残差头。训练包含行为克隆损失、动力学预测损失和负载均衡正则项。推理时只激活两个专家。",
    "",
    "## 第 3 页",
    "架构创新是把任务语义路由与动力学语义路由分开，再用交叉门控融合。相较单一混合专家，它减少了任务切换时的表示冲突；相较完全独立策略，它保留共享知识并降低参数量。",
    "",
    "## 第 4 页",
    "实验覆盖四种机器人、六类地形和三种负载。主要基线为单策略 Transformer、标准 MoE 和独立专家。FactorRoute 的平均成功率为 82%，标准 MoE 为 74%，单策略为 68%。去掉分离路由后降至 76%，去掉动力学预测损失后降至 78%。推理延迟比标准 MoE 低 18%。",
    "",
    "## 第 5 页",
    "作者明确指出实验只在仿真和有限的室内真机环境完成，没有验证开放世界地形，也没有评估传感器长期漂移。失败案例集中在高速切换目标和未见过的柔性负载。",
  ].join("\n");

  await Promise.all([
    fs.writeFile(manifestPath, "# Paper Ocean quality smoke\n\n- paper.md\n", "utf8"),
    fs.writeFile(paperPath, paperText, "utf8"),
  ]);

  const account = await client.account();
  if (!account.connected) throw new Error("Codex 尚未连接 ChatGPT 账户");

  const threadId = await client.startThread({
    contextDir: tempRoot,
    title: "Paper Ocean answer quality smoke",
    model: "gpt-5.6-sol",
  });
  const completion = waitForTurn(threadId);
  await client.sendTurn({
    threadId,
    contextDir: tempRoot,
    entries: [
      { key: "manifest", path: manifestPath, kind: "application" },
      { key: "paper", path: paperPath, kind: "untrusted" },
    ],
    prompt: buildPaperTurnPrompt({
      mode: "single",
      characterCount: paperText.length,
      papers: [{ title: "FactorRoute", pageCount: 5 }],
      currentPaperTitle: "FactorRoute",
      currentPage: 1,
      hasSelection: false,
      question: "这篇文章做了什么工作？请按默认深度完整解读。",
    }),
    model: "gpt-5.6-sol",
    effort: "medium",
  });
  await completion;

  const answer = finalText.trim();
  if (answer.length < 700) throw new Error(`回答仍然过短：${answer.length} 字符`);
  for (const section of ["方法", "架构", "创新", "实验", "局限"]) {
    if (!answer.includes(section)) throw new Error(`深度回答缺少“${section}”部分`);
  }
  console.log(`QUALITY_REPLY ${answer.length} characters`);
} finally {
  await client.stop();
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedOsTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolvedTemp.startsWith(resolvedOsTemp)) {
    await fs.rm(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
