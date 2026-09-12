// Run after npm run build. Uses an isolated Electron fixture, never a model API.
import { _electron as electron } from "playwright";
import electronPath from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(repoRoot, "output/playwright/workspace-response", runId);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-response-"));
const pdfPath = path.join(testRoot, "response-fixture.pdf");
const chunkCount = 180;
const intervalMs = 40;
await fs.mkdir(outputDir, { recursive: true });

const content = "BT /F1 20 Tf 60 720 Td (Synthetic robot control paper for renderer measurement) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await fs.writeFile(pdfPath, pdf);

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2)) : null;
  return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.length ? Number(sorted.at(-1).toFixed(2)) : null };
}

let application;
let page;
try {
  application = await electron.launch({ executablePath: electronPath, args: [path.join(repoRoot, "scripts/fixtures/auxiliary-chat-entry.mjs")], cwd: repoRoot, env: { ...process.env, PAPER_OCEAN_DEV_URL: "" }, timeout: 30_000 });
  page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept().catch(() => undefined));
  await application.evaluate(() => globalThis.setupAuxTest());
  await page.reload();
  await application.evaluate(({ BrowserWindow, dialog }, source) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, pdfPath);
  await page.getByRole("button", { name: "本地 PDF", exact: true }).click();
  await page.locator(".reader-paper-header__index.index-ready").waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".pdf-page canvas")].some(canvas => canvas.width > 0 && canvas.height > 0));
  await page.getByLabel("阅读布局", { exact: true }).click();
  await page.getByRole("button", { name: /并排讨论/ }).click();
  const aux = page.getByRole("region", { name: "论文辅助对话" });
  await aux.locator(".auxiliary-chat__toggle").click();
  const mainInput = page.getByLabel("向 Codex 提问", { exact: true });
  const auxInput = aux.getByLabel("辅助对话问题");
  await mainInput.fill("MEASURE_MAIN");
  await page.getByLabel("发送问题", { exact: true }).click();
  await auxInput.fill("MEASURE_AUX");
  await aux.getByLabel("发送辅助问题").click();
  const requests = await application.evaluate(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = setInterval(() => {
      if (globalThis.requests.length >= 2) { clearInterval(poll); resolve(globalThis.requests); }
      else if (Date.now() > deadline) { clearInterval(poll); reject(new Error("Mock turns did not start")); }
    }, 25);
  }));
  const main = requests.find(request => request.prompt.includes("MEASURE_MAIN"));
  const secondary = requests.find(request => request.prompt.includes("MEASURE_AUX"));
  assert.ok(main && secondary);
  assert.notEqual(main.threadId, secondary.threadId);
  for (const request of requests) {
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.effort, "max");
    assert.equal(request.serviceTier, "priority");
    assert.ok(request.entries.length, "the normal full-paper preparation path must run");
  }
  // Prime moderately long Markdown before timing to avoid measuring an empty UI.
  const seed = Array.from({ length: 14 }, (_, index) => `### 方法 ${index + 1}\n\n论文通过状态观测、运动控制和实验对照解释方法。这里保留已完成段落与 **关键术语**，观察持续回答时的界面更新。\n\n`).join("");
  await application.evaluate((_electron, { main, secondary, seed }) => {
    for (const request of [main, secondary]) globalThis.emitAux("item/agentMessage/delta", { threadId: request.threadId, turnId: request.turnId, itemId: "measurement-answer", delta: seed });
  }, { main, secondary, seed });
  await page.locator(".chat-panel .markdown-body").getByText("方法 14", { exact: true }).waitFor();
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    const samples = [], inputs = [], frames = [], longTasks = [];
    const pending = new Map();
    const panels = { main: document.querySelector(".chat-panel"), auxiliary: document.querySelector(".auxiliary-chat") };
    let active = true;
    let lastFrame;
    const start = performance.now();
    const frame = now => { if (!active) return; if (lastFrame !== undefined) frames.push(now - lastFrame); lastFrame = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    const longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime >= start) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    const supportsLongTasks = PerformanceObserver.supportedEntryTypes.includes("longtask");
    if (supportsLongTasks) longTaskObserver.observe({ type: "longtask", buffered: false });
    const findMarkerRect = (root, marker) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent.indexOf(marker);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index); range.setEnd(node, index + marker.length);
        return range.getBoundingClientRect();
      }
      return null;
    };
    const observeText = () => {
      for (const [id, sample] of pending) {
        const panel = panels[sample.lane];
        if (!panel.textContent.includes(sample.marker)) continue;
        sample.domAt = performance.now();
        pending.delete(id);
        // Two frame callbacks leave a paint opportunity after the DOM mutation.
        // This is an observable visibility proxy, not a GPU presentation timestamp.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          sample.frameAt = performance.now();
          const markerRect = findMarkerRect(panel, sample.marker);
          const viewport = panel.querySelector(sample.lane === "main" ? ".message-list" : ".auxiliary-chat__messages").getBoundingClientRect();
          sample.inViewport = Boolean(markerRect?.width && markerRect.bottom > viewport.top && markerRect.top < viewport.bottom && markerRect.right > viewport.left && markerRect.left < viewport.right);
        }));
      }
    };
    const mutations = new MutationObserver(observeText);
    for (const panel of Object.values(panels)) mutations.observe(panel, { childList: true, subtree: true, characterData: true });
    const unsubscribe = window.paperOcean.codex.onEvent(event => {
      const metadata = event.params?.workspaceMeasurement;
      if (!metadata) return;
      const sample = { ...metadata, receivedAt: performance.now(), receivedWallTime: Date.now() };
      samples.push(sample); pending.set(metadata.id, sample);
    });
    const inputListener = event => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      const field = event.target;
      const lane = field.closest(".auxiliary-chat") ? "auxiliary" : field.closest(".chat-panel") ? "main" : null;
      if (!lane) return;
      const sample = { lane, inputAt: performance.now(), expected: field.value };
      inputs.push(sample);
      requestAnimationFrame(() => { sample.frameAt = performance.now(); sample.valueMatched = field.value === sample.expected; });
    };
    document.addEventListener("input", inputListener, true);
    window.workspaceResponseMeasurement = {
      finish() {
        active = false; unsubscribe(); mutations.disconnect(); longTaskObserver.disconnect(); document.removeEventListener("input", inputListener, true);
        return { durationMs: performance.now() - start, samples, inputs, frames, longTasks, supportsLongTasks, pending: pending.size, visibilityState: document.visibilityState, viewport: { width: innerWidth, height: innerHeight } };
      },
    };
  });
  await application.evaluate((_electron, { main, secondary, chunkCount, intervalMs }) => {
    globalThis.workspaceResponseFinished = false;
    let index = 0;
    globalThis.workspaceResponseTimer = setInterval(() => {
      index++;
      for (const [lane, request] of [["main", main], ["auxiliary", secondary]]) {
        const marker = `«${lane === "main" ? "M" : "A"}${String(index).padStart(4, "0")}»`;
        globalThis.emitAux("item/agentMessage/delta", {
          threadId: request.threadId, turnId: request.turnId, itemId: "measurement-answer",
          delta: `控制依据 ${marker}。\n\n`,
          workspaceMeasurement: { id: `${lane}:${index}`, lane, marker, sentWallTime: Date.now() },
        });
      }
      if (index >= chunkCount) { clearInterval(globalThis.workspaceResponseTimer); globalThis.workspaceResponseFinished = true; }
    }, intervalMs);
  }, { main, secondary, chunkCount, intervalMs });
  // Native text insertion goes through Electron's real renderer input events.
  for (const input of [mainInput, auxInput]) {
    await input.focus();
    for (let index = 0; index < 36; index++) {
      await page.keyboard.insertText(index % 2 ? "问" : "题");
      await page.waitForTimeout(65);
    }
  }
  await application.evaluate(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 12_000;
    const poll = setInterval(() => {
      if (globalThis.workspaceResponseFinished) { clearInterval(poll); resolve(); }
      else if (Date.now() > deadline) { clearInterval(poll); reject(new Error("Streaming workload timed out")); }
    }, 25);
  }));
  await page.waitForTimeout(500);
  const measured = await page.evaluate(() => window.workspaceResponseMeasurement.finish());
  await application.evaluate((_electron, { main, secondary }) => {
    for (const request of [main, secondary]) globalThis.emitAux("turn/completed", { threadId: request.threadId, turn: { id: request.turnId, status: "completed" } });
  }, { main, secondary });
  assert.equal(measured.samples.length, chunkCount * 2);
  assert.equal(measured.pending, 0);
  assert.ok(measured.samples.every(sample => Number.isFinite(sample.frameAt)));
  assert.equal(measured.inputs.length, 72);
  assert.ok(measured.inputs.every(sample => sample.valueMatched));
  assert.deepEqual(errors, []);
  const lanes = {};
  for (const lane of ["main", "auxiliary"]) {
    const samples = measured.samples.filter(sample => sample.lane === lane);
    lanes[lane] = {
      mainIpcToRendererMs: distribution(samples.map(sample => sample.receivedWallTime - sample.sentWallTime)),
      rendererToDomMs: distribution(samples.map(sample => sample.domAt - sample.receivedAt)),
      rendererToVisibleFrameMs: distribution(samples.filter(sample => sample.inViewport).map(sample => sample.frameAt - sample.receivedAt)),
      mainIpcToVisibleFrameMs: distribution(samples.filter(sample => sample.inViewport).map(sample => sample.receivedWallTime - sample.sentWallTime + sample.frameAt - sample.receivedAt)),
      outsideViewportAtFrame: samples.filter(sample => !sample.inViewport).length,
      inputEventToAnimationFrameMs: distribution(measured.inputs.filter(sample => sample.lane === lane).map(sample => sample.frameAt - sample.inputAt)),
    };
  }
  const report = {
    recordedAt: new Date().toISOString(),
    description: "Controlled Electron renderer measurement; synthetic PDF + mock dual-lane chunks + real renderer text insertion. Not model response latency.",
    environment: { platform: process.platform, arch: process.arch, node: process.versions.node, electron: await application.evaluate(() => process.versions.electron), hardwareAcceleration: "disabled by shared isolated fixture", viewport: measured.viewport, visibilityState: measured.visibilityState },
    workload: { chunkCountPerLane: chunkCount, intervalMs, initialMarkdownCharactersPerLane: seed.length, inputEventsPerLane: 36, durationMs: Number(measured.durationMs.toFixed(2)) },
    methodology: { ipcClock: "Date.now across processes (1ms resolution); renderer durations use performance.now", visibleFrame: "Two requestAnimationFrame callbacks after marker enters DOM, plus marker/scroll-viewport intersection. Proxy for paint opportunity; actual GPU presentation is not measured.", instrumentation: "Extra IPC observer, MutationObserver, bounded text-range lookup and frame/longtask observers add measurement overhead." },
    lanes,
    frameIntervals: { ...distribution(measured.frames), over33ms: measured.frames.filter(value => value > 33).length, over50ms: measured.frames.filter(value => value > 50).length },
    longTasks: { supported: measured.supportsLongTasks, count: measured.longTasks.length, totalMs: Number(measured.longTasks.reduce((sum, entry) => sum + entry.duration, 0).toFixed(2)), ...distribution(measured.longTasks.map(entry => entry.duration)) },
    rendererErrors: errors,
  };
  await fs.writeFile(path.join(outputDir, "measurement.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outputDir, "samples.json"), JSON.stringify(measured, null, 2));
  await page.screenshot({ path: path.join(outputDir, "workspace.png") });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Measurement artifacts: ${outputDir}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDir, "failure.png") }).catch(() => undefined);
  throw error;
} finally {
  if (application) {
    await application.evaluate(() => { clearInterval(globalThis.workspaceResponseTimer); }).catch(() => undefined);
    await application.close();
  }
}
