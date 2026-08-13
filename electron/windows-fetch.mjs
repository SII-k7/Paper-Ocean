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
  MaximumRedirection = 6
  UseBasicParsing = $true
}
if ($payload.method -eq 'GET') { $request.OutFile = [string]$payload.outputPath }
try {
  $response = Invoke-WebRequest @request
  $status = 200
  if ($response -and $response.StatusCode) { $status = [int]$response.StatusCode }
  $contentType = ''
  $contentLength = ''
  if ($response.Headers) { $contentType = [string]$response.Headers['Content-Type'] }
  if ($response.Headers) { $contentLength = [string]$response.Headers['Content-Length'] }
} catch {
  if ($_.Exception.Response) {
    $status = [int]$_.Exception.Response.StatusCode
    $contentType = [string]$_.Exception.Response.ContentType
    $contentLength = [string]$_.Exception.Response.Headers['Content-Length']
  } else {
    throw
  }
}
[Console]::Out.WriteLine((@{ status = $status; contentType = $contentType; contentLength = $contentLength } | ConvertTo-Json -Compress))
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

export async function windowsSystemFetch(input, options = {}) {
  const source = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const url = new URL(source);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`不允许访问该网络地址：${url.hostname}`);
  }

  const method = String(options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`不支持的网络方法：${method}`);
  }

  const tempRoot = path.join(os.tmpdir(), "paper-ocean-network");
  await fs.mkdir(tempRoot, { recursive: true });
  const outputPath = path.join(tempRoot, `${randomUUID()}.bin`);

  try {
    const metadata = await runPowerShell({
      url: url.toString(),
      method,
      outputPath,
      timeoutSec: 60,
    }, options.signal);
    const body = method === "GET" && existsSync(outputPath)
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
