import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ALLOWED_HOSTS = new Set([
  "arxiv.org",
  "export.arxiv.org",
  "api.openalex.org",
  "api.crossref.org",
  "api.semanticscholar.org",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const WINDOWS_FETCH_MAX_REDIRECTS = 6;

const POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$request = @{
  Uri = [string]$payload.url
  Method = [string]$payload.method
  Headers = @{ 'User-Agent' = 'PaperOcean/0.2 local-reader' }
  TimeoutSec = [int]$payload.timeoutSec
  MaximumRedirection = 0
  UseBasicParsing = $true
}
if ($payload.method -eq 'GET') {
  $request.OutFile = [string]$payload.outputPath
  $request.PassThru = $true
}
$status = 0
$contentType = ''
$contentLength = ''
$location = ''
try {
  $response = Invoke-WebRequest @request
  $status = 200
  if ($response -and $response.StatusCode) { $status = [int]$response.StatusCode }
  if ($response.Headers) { $contentType = [string]$response.Headers['Content-Type'] }
  if ($response.Headers) { $contentLength = [string]$response.Headers['Content-Length'] }
  if ($response.Headers) { $location = [string]$response.Headers['Location'] }
} catch {
  if ($_.Exception.Response) {
    $response = $_.Exception.Response
    $status = [int]$response.StatusCode
    $contentType = [string]$response.ContentType
    if ($response.Headers) { $contentLength = [string]$response.Headers['Content-Length'] }
    if ($response.Headers) { $location = [string]$response.Headers['Location'] }
  } else {
    throw
  }
}
[Console]::Out.WriteLine((@{
  status = $status
  contentType = $contentType
  contentLength = $contentLength
  location = $location
} | ConvertTo-Json -Compress))
`;

const ENCODED_COMMAND = Buffer.from(POWERSHELL_SOURCE, "utf16le").toString("base64");

function powershellPath() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return existsSync(candidate) ? candidate : "powershell.exe";
}

function runPowerShell(payload, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      ENCODED_COMMAND,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      child.kill();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
      } else if (code !== 0) {
        reject(new Error(stderr.trim() || `Windows 网络请求失败（exit ${code}）`));
      } else {
        const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        try {
          resolve(JSON.parse(lastLine));
        } catch {
          reject(new Error("Windows 网络响应格式无效"));
        }
      }
    });
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}

export function validateWindowsFetchUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new Error("网络地址格式无效");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || !ALLOWED_HOSTS.has(hostname)
    || url.username
    || url.password
  ) {
    throw new Error(`不允许访问该网络地址：${hostname || "未知主机"}`);
  }
  return url;
}

export function resolveWindowsFetchRedirect(currentUrl, location) {
  if (typeof location !== "string" || !location.trim()) {
    throw new Error("网络重定向缺少 Location 地址");
  }

  let redirected;
  try {
    redirected = new URL(location.trim(), currentUrl);
  } catch {
    throw new Error("网络重定向地址格式无效");
  }
  return validateWindowsFetchUrl(redirected);
}

export async function followWindowsFetchRedirects(
  initialUrl,
  method,
  requestOnce,
  signal,
) {
  if (typeof requestOnce !== "function") {
    throw new TypeError("requestOnce 必须是函数");
  }
  const requestMethod = String(method || "GET").toUpperCase();
  if (requestMethod !== "GET" && requestMethod !== "HEAD") {
    throw new Error(`不支持的网络方法：${requestMethod}`);
  }

  let currentUrl = validateWindowsFetchUrl(initialUrl);
  let redirectCount = 0;

  while (true) {
    const metadata = await requestOnce(currentUrl, requestMethod, signal);
    const status = Number(metadata?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("Windows 网络响应状态无效");
    }

    if (!REDIRECT_STATUSES.has(status)) {
      return {
        ...metadata,
        status,
        finalUrl: currentUrl.toString(),
        redirectCount,
      };
    }

    if (redirectCount >= WINDOWS_FETCH_MAX_REDIRECTS) {
      throw new Error(`网络重定向超过 ${WINDOWS_FETCH_MAX_REDIRECTS} 次`);
    }

    currentUrl = resolveWindowsFetchRedirect(currentUrl, metadata.location);
    redirectCount += 1;
  }
}

export async function windowsSystemFetch(input, options = {}) {
  const source = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const url = validateWindowsFetchUrl(source);

  const method = String(options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`不支持的网络方法：${method}`);
  }

  const tempRoot = path.join(os.tmpdir(), "paper-ocean-network");
  await fs.mkdir(tempRoot, { recursive: true });
  const outputPath = path.join(tempRoot, `${randomUUID()}.bin`);

  try {
    const metadata = await followWindowsFetchRedirects(
      url,
      method,
      async (requestUrl, requestMethod, signal) => {
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        return runPowerShell({
          url: requestUrl.toString(),
          method: requestMethod,
          outputPath,
          timeoutSec: 60,
        }, signal);
      },
      options.signal,
    );
    const responseCanHaveBody = metadata.status !== 204
      && metadata.status !== 205
      && metadata.status !== 304;
    const body = method === "GET" && responseCanHaveBody && existsSync(outputPath)
      ? await fs.readFile(outputPath)
      : null;
    const headers = {};
    if (metadata.contentType) headers["Content-Type"] = metadata.contentType;
    if (metadata.contentLength) headers["Content-Length"] = metadata.contentLength;
    return new Response(body, {
      status: metadata.status,
      headers,
    });
  } finally {
    if (path.dirname(path.resolve(outputPath)) === path.resolve(tempRoot)) {
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
    }
  }
}
