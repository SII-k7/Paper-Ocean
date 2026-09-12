import { _electron as electron } from "playwright";
import electronPath from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(repoRoot, "output/playwright/appearance");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-appearance-"));
const pdfPath = path.join(testRoot, "appearance.pdf");
await fs.mkdir(outputDir, { recursive: true });

// Standalone synthetic PDF: this smoke does not depend on another test's files.
const content = "BT /F1 24 Tf 60 720 Td (Clear paper preview) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await fs.writeFile(pdfPath, pdf);

let application;
let page;
try {
  // The existing fixture creates its own fresh userData/sessionData directories.
  application = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, "scripts/fixtures/auxiliary-chat-entry.mjs")],
    cwd: repoRoot,
    env: { ...process.env, PAPER_OCEAN_DEV_URL: "" },
    timeout: 30_000,
  });
  page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept().catch(() => undefined));
  await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none", contrast: "no-preference" });
  await application.evaluate(() => globalThis.setupAuxTest());
  await page.reload();
  await application.evaluate(({ BrowserWindow, dialog }, source) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, pdfPath);
  await page.getByRole("button", { name: "本地 PDF", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".paper-titlebar")?.textContent.includes("全文索引就绪"));
  const aux = page.getByRole("region", { name: "论文辅助对话" });
  const appearance = page.getByLabel("界面效果", { exact: true });
  const glass = page.getByRole("switch", { name: "玻璃质感" });
  const reduceMotion = page.getByRole("switch", { name: "减少动态效果" });
  await aux.locator(".auxiliary-chat__toggle").click();
  await aux.getByLabel("辅助对话问题").waitFor();

  async function setTheme(theme) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) {
      await page.getByRole("button", { name: theme === "light" ? "切换到浅色主题" : "切换到深色主题" }).click();
    }
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected && !document.documentElement.classList.contains("theme-transitioning"), theme);
  }

  async function checkReadingLayout(label) {
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".pdf-page canvas");
      return canvas?.width > 0 && canvas?.height > 0;
    });
    const bounds = await page.evaluate(() => {
      const box = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return { aux: box(".auxiliary-chat"), reader: box(".reader-body"), chat: box(".chat-panel"), width: innerWidth, height: innerHeight };
    });
    for (const [name, rect] of [["reader", bounds.reader], ["chat", bounds.chat]]) {
      assert.ok(rect.width > 0 && rect.height > 0, `${label}: ${name} must remain visible`);
      assert.ok(rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= bounds.width + 1 && rect.y + rect.height <= bounds.height + 1, `${label}: ${name} must fit the viewport`);
    }
    assert.ok(bounds.aux.x >= bounds.reader.x - 1 && bounds.aux.x + bounds.aux.width <= bounds.reader.x + bounds.reader.width + 1, `${label}: auxiliary chat must fit reader width`);
    assert.ok(bounds.aux.y >= bounds.reader.y - 1 && bounds.aux.y + bounds.aux.height <= bounds.reader.y + bounds.reader.height + 1, `${label}: auxiliary chat must fit reader height`);
    assert.match(await aux.evaluate(element => getComputedStyle(element).backdropFilter), /blur\(/, `${label}: rendered glass must blur its backdrop`);
    // An ancestor filter could blur the PDF even when the canvas itself is clear.
    const filters = await page.locator(".pdf-page canvas").first().evaluate(canvas => {
      const result = [];
      for (let element = canvas; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.filter !== "none" || style.backdropFilter !== "none") result.push(element.className || element.tagName);
      }
      return result;
    });
    assert.deepEqual(filters, [], `${label}: PDF and its ancestors must remain unfiltered`);
  }

  await setTheme("light");
  await checkReadingLayout("light");
  if (!await appearance.isVisible()) await page.getByLabel("应用设置", { exact: true }).click();
  await appearance.click();
  await reduceMotion.check();
  await glass.uncheck();
  await page.waitForFunction(() => document.documentElement.dataset.material === "solid" && document.documentElement.dataset.motion === "reduced");
  assert.equal(await aux.evaluate(element => getComputedStyle(element).backdropFilter), "none");
  assert.equal(await aux.evaluate(element => getComputedStyle(element).transitionDuration), "0s");

  // Reload keeps the real origin/localStorage and verifies both non-default values.
  await page.waitForFunction(() => !document.querySelector(".save-status"));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.on("will-prevent-unload", event => event.preventDefault()));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.material === "solid" && document.documentElement.dataset.motion === "reduced");
  if (!await appearance.isVisible()) await page.getByLabel("应用设置", { exact: true }).click();
  await appearance.click();
  assert.equal(await glass.isChecked(), false, "glass opt-out survives reload");
  assert.equal(await reduceMotion.isChecked(), true, "reduced motion survives reload");
  assert.equal(await aux.evaluate(element => getComputedStyle(element).backdropFilter), "none");
  assert.equal(await aux.evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  await glass.check();
  await reduceMotion.uncheck();
  await page.waitForFunction(() => document.documentElement.dataset.material === "glass" && document.documentElement.dataset.motion === "full");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".appearance-settings").evaluate(element => element.open), false);
  assert.equal(await appearance.evaluate(element => element === document.activeElement), true, "Escape returns focus to the effects control");

  await setTheme("dark");
  await checkReadingLayout("dark");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 768));
  await page.waitForFunction(() => innerWidth <= 1180);
  await checkReadingLayout("narrow dark");
  if (!await appearance.isVisible()) await page.getByLabel("应用设置", { exact: true }).click();
  await appearance.click();
  const panel = await page.locator(".appearance-settings__panel").boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width + 1 && panel.y + panel.height <= viewport.height + 1, "effects controls fit a narrow window");
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  assert.equal(await aux.evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  assert.equal(await page.locator(".auxiliary-chat__body").evaluate(element => getComputedStyle(element).animationName), "none");
  assert.equal(await page.evaluate(() => localStorage.getItem("paper-ocean-reduce-motion")), "false", "system preference does not overwrite the manual setting");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "full");
  // Restoring motion restarts the reveal animation; capture the settled UI.
  await page.waitForFunction(() => document.querySelector(".auxiliary-chat__body").getAnimations().every(animation => animation.playState !== "running"));
  assert.match(await page.locator(".auxiliary-chat__body").evaluate(element => getComputedStyle(element).filter), /^(none|blur\(0px\))$/, "settled auxiliary text is clear");
  await page.waitForFunction(() => !document.querySelector(".save-status"));
  await page.screenshot({ path: path.join(outputDir, "appearance.png") });
  assert.deepEqual(errors, []);
  await fs.rm(path.join(outputDir, "failure.png"), { force: true });
  console.log("PASS: rendered glass, unfiltered PDF, light/dark/narrow layouts, solid and reduced-motion switches, reload persistence, Escape focus, and live system reduced-motion preference");
} catch (error) {
  await page?.screenshot({ path: path.join(outputDir, "failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await application?.close();
  // Only the uniquely generated test input directory is removed.
  if (path.dirname(path.resolve(testRoot)) === path.resolve(os.tmpdir()) && path.basename(testRoot).startsWith("paper-ocean-appearance-")) {
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
