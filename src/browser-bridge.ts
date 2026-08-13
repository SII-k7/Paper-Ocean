import type {
  CodexAccount,
  CodexEvent,
  CodexModel,
  ConversationContext,
  LibraryState,
  OpenedPaper,
  PaperRecord,
  PdfPageIndex,
  RateLimitInfo,
  Recommendation,
  RecommendationPreview,
} from "./types";

const CSRF_TOKEN = import.meta.env.VITE_PAPER_OCEAN_CSRF;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_PDF_BYTES = 100 * 1024 * 1024;

type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
};

let sessionPromise: Promise<void> | undefined;

function responseError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(response.ok ? "本地服务返回了无法识别的数据" : `本地服务请求失败（${response.status}）`);
  }
}

function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = fetch("/api/session", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      const payload = await parseResponse(response);
      if (!response.ok) throw new Error(responseError(payload, `本地会话初始化失败（${response.status}）`));
    }).catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
  }
  return sessionPromise;
}

async function api<T>(pathname: string, options: ApiOptions = {}): Promise<T> {
  await ensureSession();
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (MUTATING_METHODS.has(method)) headers.set("X-Paper-Ocean-CSRF", CSRF_TOKEN);

  let body = options.body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    body = JSON.stringify(options.json);
  }

  const response = await fetch(pathname, {
    method,
    headers,
    body,
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(responseError(payload, `本地服务请求失败（${response.status}）`));
  return payload as T;
}

function pickPdf() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.position = "fixed";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}

function safeHttpsUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}无效`);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${label}必须是安全的 HTTPS 地址`);
  return url.href;
}

const eventListeners = new Set<(event: CodexEvent) => void>();
let eventSource: EventSource | undefined;
let eventSourceOpening: Promise<void> | undefined;

function ensureEventSource() {
  if (eventSource || eventSourceOpening) return;
  eventSourceOpening = ensureSession()
    .then(() => {
      if (!eventListeners.size || eventSource) return;
      const source = new EventSource("/api/events", { withCredentials: true });
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as CodexEvent;
          if (!event || typeof event.method !== "string") return;
          for (const listener of eventListeners) listener(event);
        } catch {
          // Ignore a malformed event and let the browser keep the stream alive.
        }
      };
      eventSource = source;
    })
    .catch(() => undefined)
    .finally(() => {
      eventSourceOpening = undefined;
    });
}

function subscribeToEvents(listener: (event: CodexEvent) => void) {
  eventListeners.add(listener);
  ensureEventSource();
  return () => {
    eventListeners.delete(listener);
    if (!eventListeners.size && eventSource) {
      eventSource.close();
      eventSource = undefined;
    }
  };
}

function openLoginWindow() {
  const popup = window.open(
    "about:blank",
    "paper-ocean-codex-login",
    "popup,width=720,height=820,resizable=yes,scrollbars=yes",
  );
  if (popup) {
    popup.opener = null;
    popup.document.title = "连接 ChatGPT";
    const message = popup.document.createElement("p");
    message.textContent = "正在准备安全登录…";
    message.style.cssText = "font:16px system-ui;padding:24px;color:#24342c";
    popup.document.body.append(message);
  }
  return popup;
}

export function installBrowserBridge() {
  const bridge: Window["paperOcean"] = {
    runtime: "web",
    openPdf: async () => {
      const file = await pickPdf();
      if (!file) return null;
      if (file.size > MAX_PDF_BYTES) throw new Error("PDF 不能超过 100 MB");
      return api<OpenedPaper>("/api/papers/import", {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/pdf",
          "X-Paper-Ocean-Filename": encodeURIComponent(file.name || "local-paper.pdf"),
        },
      });
    },
    reopenPdf: (handle) => api<OpenedPaper>("/api/papers/reopen", {
      method: "POST",
      json: { handle },
    }),
    openUrl: (value) => api<OpenedPaper>("/api/papers/open-url", {
      method: "POST",
      json: { value },
    }),
    openExternal: async (value) => {
      const href = safeHttpsUrl(value, "外部链接");
      window.open(href, "_blank", "noopener,noreferrer");
    },
    setTheme: async (theme) => theme,
    saveContext: (input: { paper: PaperRecord; pages: PdfPageIndex[] }) => (
      api<{ paperDir: string; contextPath: string }>("/api/papers/context", {
        method: "POST",
        json: input,
      })
    ),
    savePageImage: async (input) => {
      const result = await api<{ handle: string }>("/api/papers/page-image", {
        method: "POST",
        json: input,
      });
      return result.handle;
    },
    prepareConversation: (input) => api<ConversationContext>("/api/conversations/prepare", {
      method: "POST",
      json: input,
    }),
    codex: {
      status: () => api<CodexAccount>("/api/codex/status"),
      login: async () => {
        const popup = openLoginWindow();
        try {
          const result = await api<{ authUrl?: string; alreadyConnected?: boolean }>("/api/codex/login", {
            method: "POST",
            json: {},
          });
          if (result.authUrl) {
            const href = safeHttpsUrl(result.authUrl, "登录地址");
            if (!popup) throw new Error("Chrome 拦截了登录窗口，请允许此网站打开弹出式窗口后重试");
            popup.location.replace(href);
          } else {
            popup?.close();
          }
          return result;
        } catch (error) {
          popup?.close();
          throw error;
        }
      },
      models: () => api<CodexModel[]>("/api/codex/models"),
      chooseExecutable: async () => null,
      rateLimits: () => api<RateLimitInfo | null>("/api/codex/rate-limits"),
      startThread: async (input) => {
        const result = await api<{ threadId: string }>("/api/codex/threads/start", {
          method: "POST",
          json: input,
        });
        return result.threadId;
      },
      resumeThread: async (input) => {
        const result = await api<{ threadId: string }>("/api/codex/threads/resume", {
          method: "POST",
          json: input,
        });
        return result.threadId;
      },
      sendTurn: (input) => api<{ turnId: string }>("/api/codex/turns/start", {
        method: "POST",
        json: input,
      }),
      interrupt: async (input) => {
        await api("/api/codex/turns/interrupt", { method: "POST", json: input });
      },
      onEvent: subscribeToEvents,
    },
    recommendations: (input) => api<Recommendation[]>("/api/recommendations", {
      method: "POST",
      json: input,
    }),
    prepareRecommendationPreview: (arxivId) => api<RecommendationPreview>("/api/recommendations/preview", {
      method: "POST",
      json: { arxivId },
    }),
    saveRecommendationThumbnail: async (input) => {
      const result = await api<{ imageUrl: string }>("/api/recommendations/thumbnail", {
        method: "POST",
        json: input,
      });
      return result.imageUrl;
    },
    library: {
      load: () => api<LibraryState>("/api/library"),
      save: async (state) => {
        await api("/api/library", { method: "PUT", json: state });
      },
    },
  };

  window.paperOcean = bridge;
}
