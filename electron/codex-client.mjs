import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { PAPER_READING_BASE_INSTRUCTIONS } from "./paper-prompt.mjs";
import { READING_MODEL, fixedReadingSelection } from "./reading-model.mjs";
import { READING_SESSION_OVERRIDES, readingSessionConfig } from "./reading-session.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_START_TIMEOUT_MS = 10_000;
const MODEL_CACHE_MS = 60_000;
const ADDITIONAL_CONTEXT_CHUNK_BYTES = 800;
export const PAPER_OCEAN_MODEL_IDS = [READING_MODEL];
const MODEL_ID_SET = new Set(PAPER_OCEAN_MODEL_IDS);
export const PAPER_OCEAN_PROVIDER = "paper_ocean_http";

export function codexAppServerArgs() {
  // Recent Codex versions ignore the old responses_websockets feature flags.
  // Use a process-local provider capability instead, retaining OpenAI login and
  // its default endpoint. Never overwrite the user's global provider settings.
  return [
    "-c",
    `model_provider="${PAPER_OCEAN_PROVIDER}"`,
    "-c",
    `model_providers.${PAPER_OCEAN_PROVIDER}={name="Paper Ocean HTTP",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
    ...Object.entries(READING_SESSION_OVERRIDES).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
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

export function unixCodexCandidates(homeDir, env, platform = process.platform) {
  return [
    env.PAPER_OCEAN_CODEX_PATH,
    path.join(homeDir, ".local", "bin", "codex"),
    path.join(homeDir, ".npm-global", "bin", "codex"),
    path.join(homeDir, ".bun", "bin", "codex"),
    path.join(homeDir, ".volta", "bin", "codex"),
    env.NVM_BIN && path.join(env.NVM_BIN, "codex"),
    env.PNPM_HOME && path.join(env.PNPM_HOME, "codex"),
    path.join(homeDir, ".local", "share", "pnpm", "codex"),
    ...(platform === "darwin" ? [path.join(homeDir, "Library", "pnpm", "codex"), "/opt/homebrew/bin/codex"] : []),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
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

  if (platform !== "win32") {
    const discovered = unixCodexCandidates(homeDir, env, platform).find((candidate) => existsSync(candidate));
    if (discovered) return discovered;
  }

  return platform === "win32" ? "codex.cmd" : "codex";
}

export function codexSpawnEnvironment(executable, env = process.env, platform = process.platform) {
  if (platform === "win32") return { ...env };
  const extraDirectories = [
    path.isAbsolute(executable) ? path.dirname(executable) : null,
    ...unixCodexCandidates(os.homedir(), env, platform).map(candidate => path.dirname(candidate)),
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
      serviceTiers: (Array.isArray(row.serviceTiers) ? row.serviceTiers : []).filter(tier => typeof tier?.id === "string" && typeof tier?.name === "string").map(({ id, name }) => ({ id, name })),
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
    this.loadedThreads = new Map();
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
      if (message.method === "thread/closed" || (message.method === "thread/status/changed" && ["notLoaded", "systemError"].includes(message.params?.status?.type))) {
        this.loadedThreads.delete(message.params?.threadId);
      }
      this.emit("event", { method: message.method, params: message.params ?? {} });
    }
  }

  #handleExit(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.proc = null;
    this.loadedThreads.clear();
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
        const error = new Error(`${method} 请求超时`);
        error.code = "CODEX_REQUEST_TIMEOUT";
        error.method = method;
        reject(error);
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
    const result = await this.request("account/read", { refreshToken: false });
    const account = result?.account ?? null;
    return {
      connected: account?.type === "chatgpt",
      accountType: account?.type ?? null,
      planType: account?.planType ?? null,
      codexPath: this.executable,
    };
  }

  async login() {
    const params = {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    };

    const startLogin = async () => {
      await this.start();
      return this.request("account/login/start", params, LOGIN_START_TIMEOUT_MS);
    };

    try {
      return await startLogin();
    } catch (error) {
      if (error?.code !== "CODEX_REQUEST_TIMEOUT") throw error;
      await this.stop();
      return startLogin();
    }
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
      throw new Error("当前 Codex 客户端没有提供 GPT-5.6 Luna 模型");
    }
    this.modelCache = models;
    this.modelCacheAt = Date.now();
    return models;
  }

  async #validatedSelection({ model, effort } = {}) {
    const models = await this.models();
    const selection = fixedReadingSelection(models);
    if (!selection) throw new Error("当前 Codex 无法使用 GPT-5.6 Luna max，请检查 Codex 登录与模型支持情况");
    return selection;
  }

  async readingConfig(contextDir) {
    const [configuration, skills] = await Promise.allSettled([
      this.request("config/read", { includeLayers: false, cwd: contextDir }, 5_000),
      this.request("skills/list", { cwds: [contextDir], forceReload: false }, 5_000),
    ]);
    // Older app-servers may not expose one of these read-only discovery methods.
    // Keep the process-level isolation and allow the paper question to proceed.
    if (configuration.status === "rejected" || skills.status === "rejected") {
      this.emit("diagnostic", { level: "warning", message: "当前 Codex 未能读取全部扩展列表；论文会话继续使用基础精简配置。" });
    }
    return readingSessionConfig(
      configuration.status === "fulfilled" ? configuration.value?.config ?? {} : {},
      skills.status === "fulfilled" ? skills.value?.data ?? [] : [],
    );
  }

  async startThread({ contextDir, title, model, serviceTier }) {
    await this.start();
    const selection = await this.#validatedSelection({ model });
    const config = await this.readingConfig(contextDir);
    const result = await this.request("thread/start", {
      config,
      model: selection.model,
      modelProvider: PAPER_OCEAN_PROVIDER,
      serviceTier: serviceTier === null ? null : selection.serviceTier ?? null,
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
    this.loadedThreads.set(threadId, path.resolve(contextDir));
    return threadId;
  }

  async resumeThread({ threadId, contextDir }) {
    await this.start();
    if (this.loadedThreads.get(threadId) === path.resolve(contextDir)) return threadId;
    const config = await this.readingConfig(contextDir);
    const result = await this.request("thread/resume", {
      config,
      threadId,
      modelProvider: PAPER_OCEAN_PROVIDER,
      cwd: contextDir,
      runtimeWorkspaceRoots: [contextDir],
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "friendly",
      baseInstructions: PAPER_READING_BASE_INSTRUCTIONS,
    });
    const resumedId = result?.thread?.id ?? threadId;
    this.loadedThreads.set(resumedId, path.resolve(contextDir));
    return resumedId;
  }

  async sendTurn({
    threadId,
    contextDir,
    entries = [],
    prompt,
    selectedText,
    pageImagePath,
    pageImages = [],
    model,
    effort,
    serviceTier,
  }) {
    await this.start();
    const selection = await this.#validatedSelection({ model, effort });
    // Use the advertised tier ID (currently "priority"), not the UI label "Fast".
    const selectedTier = serviceTier === null ? null : selection.serviceTier ?? null;
    const input = [{ type: "text", text: prompt, text_elements: [] }];
    if (pageImages.length) {
      for (const image of pageImages.slice(0,3)) {
        input.push({ type: "text", text: `原文页图：论文 ID ${image.paperId}，PDF 第 ${image.page} 页。仅此图属于该页。`, text_elements: [] });
        input.push({ type: "localImage", path: image.path });
      }
    } else if (pageImagePath) input.push({ type: "localImage", path: pageImagePath });

    const additionalContext = {};
    const values = [];
    for (let offset = 0; offset < entries.length; offset += 16) {
      values.push(...await Promise.all(entries.slice(offset, offset + 16).map(entry => fs.readFile(entry.path, "utf8"))));
    }
    for (const [index, entry] of entries.entries()) {
      additionalContext[entry.key] = {
        value: values[index],
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
      serviceTier: selectedTier,
      summary: "concise",
      personality: "friendly",
    });

    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex 没有返回 turnId");
    return { turnId, serviceTier: selectedTier };
  }

  async interrupt({ threadId, turnId }) {
    await this.start();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  stop() {
    this.loadedThreads.clear();
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
