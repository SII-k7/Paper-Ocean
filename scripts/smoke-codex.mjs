import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexClient } from "../electron/codex-client.mjs";

const client = new CodexClient();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-smoke-"));
let finalText = "";

function waitForTurn(threadId, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待 Codex 回复超时"));
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

      if (event.method === "error") {
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
  const firstPaperPath = path.join(tempRoot, "paper-a.md");
  const secondPaperPath = path.join(tempRoot, "paper-b.md");
  await Promise.all([
    fs.writeFile(manifestPath, "# 两篇论文全文测试\n\n- paper-a.md\n- paper-b.md\n", "utf8"),
    fs.writeFile(firstPaperPath, "# Paper A\n\n## 第 1 页\n\n开头。\n\n## 第 17 页\n\n验证代号是珊瑚-731。\n", "utf8"),
    fs.writeFile(secondPaperPath, "# Paper B\n\n## 第 1 页\n\n开头。\n\n## 第 9 页\n\n第二验证代号是海星-204。\n", "utf8"),
  ]);

  const account = await client.account();
  if (!account.connected) throw new Error("Codex 尚未连接 ChatGPT 账户");
  console.log(`ACCOUNT ${account.accountType}/${account.planType}`);

  const threadId = await client.startThread({ contextDir: tempRoot, title: "Full context smoke" });
  const completion = waitForTurn(threadId);
  const { turnId } = await client.sendTurn({
    threadId,
    contextDir: tempRoot,
    entries: [
      { key: "manifest", path: manifestPath, kind: "application" },
      { key: "paper-a", path: firstPaperPath, kind: "untrusted" },
      { key: "paper-b", path: secondPaperPath, kind: "untrusted" },
    ],
    prompt: "根据本轮注入的两篇完整论文，只回复两个验证代号，用竖线分隔。",
  });
  await completion;

  if (!finalText.trim()) throw new Error(`Turn ${turnId} 完成但没有收到文本`);
  if (!finalText.includes("珊瑚-731") || !finalText.includes("海星-204")) {
    throw new Error(`全文上下文未被正确读取：${finalText}`);
  }
  console.log(`REPLY ${finalText.trim()}`);
} finally {
  await client.stop();
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedOsTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolvedTemp.startsWith(resolvedOsTemp)) {
    await fs.rm(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
