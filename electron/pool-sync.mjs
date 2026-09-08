import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mergePools, poolFromLibrary, validatePool } from "./paper-pool.mjs";

const EMPTY = { version: 1, papers: [] }, MAX_BYTES = 8 * 1024 * 1024;
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch(error) { if(error.code === "ENOENT") return fallback; throw new Error("本地论文池数据无法读取，请保留文件后检查"); }
}
export function poolEndpoint(value, allowHttp = false) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) throw new Error("请填写不带凭据和查询参数的 HTTPS WebDAV 文件夹地址");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("paper-ocean-pool-v1.json", url).href;
}
async function bodyJson(response) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("远端论文池超过 8 MB，未覆盖本地数据");
  const reader = response.body?.getReader(); if (!reader) throw new Error("远端论文池响应为空");
  const chunks = []; let length = 0;
  try { for (;;) { const {value,done} = await reader.read(); if(done) break; length += value.length; if(length > MAX_BYTES) throw new Error("远端论文池超过 8 MB"); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(()=>{}); }
  return validatePool(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
export async function exchangePool(config, local, fetcher = fetch, { allowHttp = false } = {}) {
  const endpoint = poolEndpoint(config.url, allowHttp);
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await fetcher(endpoint, { headers: { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!remote.ok && remote.status !== 404) throw new Error(`无法读取远端论文池（${remote.status}），请检查地址与登录信息`);
    const etag = remote.headers.get("etag");
    if (remote.ok && (!etag || etag.startsWith("W/"))) { await remote.body?.cancel(); throw new Error("此 WebDAV 未提供强版本标识，无法安全合并，请更换支持 ETag 的服务"); }
    const merged = mergePools(local, remote.ok ? await bodyJson(remote) : EMPTY);
    const body = JSON.stringify(merged);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("论文池超过同步容量限制");
    const saved = await fetcher(endpoint, { method: "PUT", headers: { Authorization: authorization, "Content-Type": "application/json", ...(remote.ok ? {"If-Match": etag} : {"If-None-Match": "*"}) }, body, redirect: "error", signal: AbortSignal.timeout(15000) });
    await saved.body?.cancel();
    if (saved.status === 412) continue;
    if (!saved.ok) throw new Error(`无法写入远端论文池（${saved.status}），本地记录已保留`);
    return merged;
  }
  throw new Error("另一台设备正在更新，稍后会重试；本地记录已保留");
}
export function createPoolSync({ directory, loadLibrary, encodeSecret, decodeSecret, fetcher = fetch, allowHttp = false }) {
  let queue = Promise.resolve(), syncing = false, lastSync = 0, error = "", timer, inFlight;
  const dataFile = path.join(directory, "paper-pool.json"), configFile = path.join(directory, "paper-pool-config.json");
  const serial = task => { const result = queue.catch(()=>{}).then(task); queue = result; return result; };
  async function config() { const stored = await readJson(configFile, null); return stored ? { ...stored, password: await decodeSecret(stored.secret) } : null; }
  async function local() { return mergePools(validatePool(await readJson(dataFile, EMPTY)), poolFromLibrary(await loadLibrary())); }
  async function status() {
    const stored = await readJson(configFile, null); const pool = await local(); return { papers: pool.papers, configured: Boolean(stored), url: stored?.url || "", username: stored?.username || "", syncing, lastSync, error };
  }
  async function run() {
    if (inFlight) return inFlight;
    inFlight = serial(async () => {
      syncing = true; error = "";
      try {
        const before = await local(); await atomicJson(dataFile, before);
        const settings = await config();
        if (settings) { const merged = await exchangePool(settings, before, fetcher, { allowHttp }); await atomicJson(dataFile, merged); lastSync = Date.now(); }
      } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
      finally { syncing = false; }
    }).then(status).finally(()=>{inFlight=undefined;});
    return inFlight;
  }
  return {
    status, run,
    configure: async input => { await serial(async () => {
      if (input === null) { await fs.rm(configFile, { force: true }); return; }
      const url = String(input.url || "").trim(), username = String(input.username || "").trim();
      if(url.length > 2000 || username.length > 500 || String(input.password || "").length > 10000) throw new Error("同步设置内容过长");
      poolEndpoint(url, allowHttp);
      if (!username || username.includes(":")) throw new Error("请填写有效的 WebDAV 用户名");
      const old = await readJson(configFile, null);
      const secret = input.password ? await encodeSecret(String(input.password)) : old?.url === url && old?.username === username ? old.secret : null;
      if (!secret) throw new Error("请填写 WebDAV 应用密码");
      await atomicJson(configFile, { url, username, secret });
    }); return run(); },
    schedule: () => { clearTimeout(timer); timer = setTimeout(()=>void run().catch(()=>{}), 2000); timer.unref?.(); },
    stop: async () => { clearTimeout(timer); await queue.catch(()=>{}); },
  };
}
