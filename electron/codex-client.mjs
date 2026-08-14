import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { PAPER_READING_BASE_INSTRUCTIONS } from "./paper-prompt.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_CACHE_MS = 60_000;
const ADDITIONAL_CONTEXT_CHUNK_BYTES = 800;
export const PAPER_OCEAN_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];
const MODEL_ID_SET = new Set(PAPER_OCEAN_MODEL_IDS);

export function codexAppServerArgs() {
  return [
    "--disable",
    "responses_websockets",
    "--disable",
    "responses_websockets_v2",
    "app-server",
  ];
}

export function splitAdditionalContextValue(value, maximumBytes = ADDITIONAL_CONTEXT_CHUNK_BYTES) {
  const text = String(value || "");
  if (!text) return [];
  const chunks = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const nextBytes = Buffer.byteLength(text.slice(index, index + width), "utf8");
    if (bytes && bytes + nextBytes > maximumBytes) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += nextBytes;
    index += width;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

function macCodexCandidates(homeDir, env) {
  return [
    env.PAPER_OCEAN_CODEX_PATH,
    path.join(homeDir, ".local", "bin", "codex"),
    path.join(homeDir, ".npm-global", "bin", "codex"),
    path.join(homeDir, ".bun", "bin", "codex"),
    path.join(homeDir, ".volta", "bin", "codex"),
    path.join(homeDir, "Library", "pnpm", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
}

export function resolveCodexExecutable(
  env = process.env,
  { platform = process.platform, homeDir = os.homedir() } = {},
) {
  if (env.PAPER_OCEAN_CODEX_PATH && existsSync(env.PAPER_OCEAN_CODEX_PATH)) {
    return env.PAPER_OCEAN_CODEX_PATH;
  }

  if (platform === "win32" && env.APPDATA) {
    const npmBinary = path.join(
      env.APPDATA,
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    if (existsSync(npmBinary)) return npmBinary;
  }

  if (platform === "darwin") {
    const discovered = macCodexCandidates(homeDir, env).find((candidate) => existsSync(candidate));
    if (discovered) return discovered;
  }

  return platform === "win32" ? "codex.cmd" : "codex";
}

export function codexSpawnEnvironment(executable, env = process.env) {
  if (process.platform !== "darwin") return { ...env };
  const extraDirectories = [
    path.isAbsolute(executable) ? path.dirname(executable) : null,
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".npm-global", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".volta", "bin"),
    path.join(os.homedir(), "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  const existing = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  return { ...env, PATH: [...new Set([...extraDirectories, ...existing])].join(path.delimiter) };
}

export function normalizeModelCatalog(result) {
  const rows = Array.isArray(result?.data)
    ? result.data
    : Array.isArray(result?.models)
      ? result.models
      : [];

  return rows.flatMap((row) => {
    const id = String(row?.id ?? row?.model ?? row?.slug ?? "");
    if (!MODEL_ID_SET.has(id) || row?.hidden === true) return [];

    const rawEfforts = row?.supportedReasoningEfforts
      ?? row?.supportedEfforts
      ?? row?.reasoningEfforts
      ?? [];
    const supportedEfforts = [...new Set(rawEfforts.map((entry) => (
      typeof entry === "string"
        ? entry
        : entry?.reasoningEffort ?? entry?.effort ?? entry?.value
    )).filter(Boolean))];
    const defaultEffort = row?.defaultReasoningEffort
      ?? row?.defaultEffort
      ?? supportedEfforts[0];

    return [{
      id,
      displayName: String(row?.displayName ?? row?.name ?? id),
      description: String(row?.description ?? ""),
      defaultEffort,
      supportedEfforts,
      isDefault: Boolean(row?.isDefault),
    }];
  }).sort((left, right) => (
    PAPER_OCEAN_MODEL_IDS.indexOf(left.id) - PAPER_OCEAN_MODEL_IDS.indexOf(right.id)
  ));
}

export class CodexClient extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.executable = resolveCodexExecutable();
    this.modelCache = null;
    this.modelCacheAt = 0;
  }

  async setExecutable(executable) {
    const resolved = path.resolve(String(executable || ""));
    if (!existsSync(resolved)) throw new Error("所选 Codex 可执行文件不存在");
    await this.stop();
    this.executable = resolved;
    this.modelCache = null;
    this.modelCacheAt = 0;
    return this.executable;
  }

  async start() {
    if (this.proc && !this.proc.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    const useShell = this.executable.toLowerCase().endsWith(".cmd");
    this.proc = spawn(this.executable, codexAppServerArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
      env: codexSpawnEnvironment(this.executable),
    });

    this.proc.on("error", (error) => this.#handleExit(error));
    this.proc.on("exit", (code, signal) => {
      this.#handleExit(new Error(`Codex App Server 已退出（code=${code}, signal=${signal}）`));
    });

    const output = readline.createInterface({ input: this.proc.stdout });
    output.on("line", (line) => this.#handleLine(line));

    this.proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text && /error|failed|panic/i.test(text)) {
        this.emit("diagnostic", { level: "error", message: text.slice(0, 800) });
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "paper_ocean",
        title: "Paper Ocean",
        version: "0.4.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex 请求失败"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit("event", { method: message.method, params: message.params ?? {} });
    }
  }

  #handleExit(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.proc = null;
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.emit("event", {
      method: "paperOcean/serverExited",
      params: { message: error.message },
    });
    this.emit("diagnostic", { level: "error", message: error.message });
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server 尚未启动"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async account() {
    await this.start();
    const result = await this.request("account/read", { refreshToken: true });
    const account = result?.account ?? null;
    return {
      connected: account?.type === "chatgpt",
      accountType: account?.type ?? null,
      planType: account?.planType ?? null,
      codexPath: this.executable,
    };
  }

  async login() {
    await this.start();
    const account = await this.account();
    if (account.connected) return { alreadyConnected: true };
    return this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
  }

  async rateLimits() {
    await this.start();
    const result = await this.request("account/rateLimits/read", {});
    return result?.rateLimits ?? null;
  }

  async models({ force = false } = {}) {
    await this.start();
    if (!force && this.modelCache && Date.now() - this.modelCacheAt < MODEL_CACHE_MS) {
      return this.modelCache;
    }
    const result = await this.request("model/list", {
      limit: 100,
      includeHidden: false,
    });
    const models = normalizeModelCatalog(result);
    if (!models.length) {
      throw new Error("当前 Codex 账户没有可用的 GPT-5.6 Sol、Terra 或 Luna 模型");
    }
    this.modelCache = models;
    this.modelCacheAt = Date.now();
    return models;
  }

  async #validatedSelection({ model, effort } = {}) {
    const models = await this.models();
    const selected = models.find((item) => item.id === model)
      ?? models.find((item) => item.isDefault)
      ?? models[0];
    if (model && selected.id !== model) throw new Error(`模型 ${model} 当前不可用`);

    const selectedEffort = effort ?? selected.defaultEffort;
    if (!selectedEffort || !selected.supportedEfforts.includes(selectedEffort)) {
      throw new Error(`${selected.displayName} 不支持思考强度 ${selectedEffort || "未知"}`);
    }
    return { model: selected.id, effort: selectedEffort };
  }

  async startThread({ contextDir, title, model }) {
    await this.start();
    const selection = await this.#validatedSelection({ model });
    const result = await this.request("thread/start", {
      model: selection.model,
      cwd: contextDir,
      runtimeWorkspaceRoots: [contextDir],
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "friendly",
      serviceName: "paper_ocean",
      baseInstructions: PAPER_READING_BASE_INSTRUCTIONS,
      ephemeral: false,
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error(`无法为《${title}》创建 Codex 对话`);
    return threadId;
  }

  async resumeThread({ threadId, contextDir }) {
    await this.start();
    const result = await this.request("thread/resume", {
      threadId,
      cwd: contextDir,
      runtimeWorkspaceRoots: [contextDir],
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "friendly",
      baseInstructions: PAPER_READING_BASE_INSTRUCTIONS,
    });
    return result?.thread?.id ?? threadId;
  }

  async sendTurn({
    threadId,
    contextDir,
    entries = [],
    prompt,
    selectedText,
    pageImagePath,
    model,
    effort,
  }) {
    await this.start();
    const selection = await this.#validatedSelection({ model, effort });
    const input = [{ type: "text", text: prompt, text_elements: [] }];
    if (pageImagePath) input.push({ type: "localImage", path: pageImagePath });

    const additionalContext = {};
    for (const entry of entries) {
      additionalContext[entry.key] = {
        value: await fs.readFile(entry.path, "utf8"),
        kind: entry.kind,
      };
    }
    for (const [index, chunk] of splitAdditionalContextValue(selectedText).entries()) {
      additionalContext[`paper-ocean-selection-${String(index + 1).padStart(4, "0")}`] = {
        value: chunk,
        kind: "untrusted",
      };
    }

    const result = await this.request("turn/start", {
      threadId,
      input,
      additionalContext,
      cwd: contextDir,
      runtimeWorkspaceRoots: [contextDir],
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      model: selection.model,
      effort: selection.effort,
      summary: "concise",
      personality: "friendly",
    });

    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex 没有返回 turnId");
    return { turnId };
  }

  async interrupt({ threadId, turnId }) {
    await this.start();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.killed || proc.exitCode !== null) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.once("exit", finish);
      proc.once("error", finish);
      proc.kill();
      const timer = setTimeout(finish, 2_000);
      timer.unref?.();
    });
  }
}
