import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import path from "node:path";
import { validateWindowsFetchUrl, resolveWindowsFetchRedirect, WINDOWS_FETCH_MAX_REDIRECTS } from "./windows-fetch.mjs";

const SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $request = [System.Net.HttpWebRequest]::Create([string]$payload.url)
  $request.Method = [string]$payload.method
  $request.AllowAutoRedirect = $false
  $request.UserAgent = 'PaperOcean/0.4 local-reader'
  $request.Timeout = 60000
  $request.ReadWriteTimeout = 60000
  $request.AutomaticDecompression = [System.Net.DecompressionMethods]::None
  $request.Headers['Accept-Encoding'] = 'identity'
  if ($payload.range) { $request.AddRange([long]$payload.range) }
  if ($payload.ifRange) { $request.Headers['If-Range'] = [string]$payload.ifRange }
  try { $response = $request.GetResponse() }
  catch { if ($_.Exception.Response) { $response = $_.Exception.Response } else { throw } }
  $headers = @{}
  foreach ($key in @('Content-Type','Content-Length','Content-Range','Content-Encoding','ETag','Last-Modified','Accept-Ranges','Location')) {
    $value = [string]$response.Headers[$key]
    if ($value) { $headers[$key] = $value }
  }
  $metadata = @{ status = [int]$response.StatusCode; headers = $headers } | ConvertTo-Json -Compress
  $output = [Console]::OpenStandardOutput()
  $prefix = [System.Text.Encoding]::UTF8.GetBytes($metadata + [char]10)
  $output.Write($prefix, 0, $prefix.Length)
  $output.Flush()
  if ($payload.method -eq 'GET') {
    $body = $response.GetResponseStream()
    $buffer = New-Object byte[] 65536
    while (($count = $body.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $output.Write($buffer, 0, $count)
      $output.Flush()
    }
    $body.Dispose()
  }
  $response.Dispose()
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;
const COMMAND = Buffer.from(SOURCE, "utf16le").toString("base64");

export function responseFromWindowsProcess(child, method, signal) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough({ highWaterMark: 65536 });
    output.on("error", () => undefined);
    let prefix = Buffer.alloc(0), settled = false, finished = false, stderr = "";
    const fail = (error) => { output.destroy(error); if (!settled) { settled = true; reject(error); } if (!finished) child.kill(); };
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new DOMException("下载已取消", "AbortError"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.once("error", fail);
    child.once("close", (code) => {
      finished = true; signal?.removeEventListener("abort", abort);
      if (code !== 0) fail(new Error(stderr.trim() || "Windows 网络传输中断。"));
      else if (!settled) fail(new Error("Windows 网络响应缺少头部。"));
      else output.end();
    });
    output.once("close", () => { if (!finished) child.kill(); });
    const header = (chunk) => {
      prefix = Buffer.concat([prefix, chunk]);
      const end = prefix.indexOf(10);
      if (end < 0) { if (prefix.length > 32768) fail(new Error("Windows 网络响应头过长。")); return; }
      if (end > 32768) { fail(new Error("Windows 网络响应头过长。")); return; }
      child.stdout.off("data", header);
      try {
        const metadata = JSON.parse(prefix.subarray(0, end).toString("utf8"));
        if (!Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599) throw new Error("Windows 网络响应状态无效。");
        const hasBody = method === "GET" && ![204, 205, 304].includes(metadata.status);
        const response = new Response(hasBody ? Readable.toWeb(output) : null, { status: metadata.status, headers: metadata.headers });
        if (hasBody) { output.write(prefix.subarray(end + 1)); child.stdout.pipe(output, { end: false }); }
        else child.stdout.resume();
        prefix = Buffer.alloc(0); settled = true; resolve(response);
      } catch (error) { fail(error); }
    };
    child.stdout.on("data", header);
  });
}

export async function windowsStreamFetch(input, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) throw new Error(`不支持的网络方法：${method}`);
  const headers = new Headers(options.headers);
  const range = headers.get("range");
  if (range && !/^bytes=\d+-$/.test(range)) throw new Error("续传 Range 格式无效。");
  const ifRange = headers.get("if-range");
  if (ifRange && (ifRange.length > 500 || /[\r\n]/.test(ifRange))) throw new Error("续传校验信息无效。");
  let url = validateWindowsFetchUrl(input);
  for (let redirects = 0; ; redirects++) {
    options.signal?.throwIfAborted();
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", COMMAND], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const promise = responseFromWindowsProcess(child, method, options.signal);
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ url: url.href, method, range: range?.match(/\d+/)?.[0], ifRange }), "utf8");
    const response = await promise;
    if (options.redirect === "manual" || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects >= WINDOWS_FETCH_MAX_REDIRECTS) throw new Error("网络重定向次数过多。");
    url = resolveWindowsFetchRedirect(url, response.headers.get("location"));
  }
}
