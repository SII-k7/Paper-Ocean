import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const output = path.resolve("output/playwright/workspace-ui");
await fs.mkdir(output, { recursive: true });
const pdf = path.join(output, "workspace-paper.pdf");
const content = "BT /F1 24 Tf 60 720 Td (Workspace reading fixture) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let bytes = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(bytes)); bytes += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const start = Buffer.byteLength(bytes);
bytes += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
await fs.writeFile(pdf, bytes);

const app = await electron.launch({ executablePath: electronPath, args: [path.resolve("scripts/fixtures/auxiliary-chat-entry.mjs")], timeout: 30000 });
let page;
const errors = [];
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on("dialog", dialog => dialog.accept().catch(() => {}));
  page.on("pageerror", error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  await app.evaluate(() => globalThis.setupAuxTest());
  await page.locator(".workspace-grid").waitFor();
  await page.evaluate(() => {
    localStorage.setItem("paper-ocean-workspace-mode", "explore");
    localStorage.setItem("paper-ocean-reading-font-size", "16");
    localStorage.setItem("paper-ocean-pane-widths-v1", "[50,30,20]");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.workspace-grid[data-mode="explore"]').waitFor();
  assert.equal(await page.locator(".workspace-controls").count(), 0);
  for (const width of [1180, 1440]) {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value, 920), width);
    await page.waitForTimeout(120);
    for (const [title, mode, visiblePanes] of [["专注阅读", "read", 1], ["并排讨论", "discuss", 2], ["论文探索", "explore", 3]]) {
      await page.getByLabel("阅读布局", { exact: true }).click();
      await page.getByRole("button", { name: title, exact: true }).click();
      await page.locator(`.workspace-grid[data-mode="${mode}"]`).waitFor();
      const geometry = await page.locator(".workspace-grid").evaluate(grid => {
        const outer = grid.getBoundingClientRect();
        const panes = [...grid.querySelectorAll(":scope > .workspace-pane")].map(pane => pane.getBoundingClientRect()).filter(pane => pane.width > 0);
        return { count: panes.length, contained: panes.every(pane => pane.x >= outer.x - 1 && pane.right <= outer.right + 1 && pane.height >= outer.height - 1) };
      });
      assert.equal(geometry.count, visiblePanes, `${mode} exposes the expected panes at ${width}px`);
      assert.ok(geometry.contained, `${mode} panes fit the native window at ${width}px`);
    }
  }
  await page.getByLabel("阅读布局", { exact: true }).click();
  assert.equal(await page.getByLabel("对话文字大小", { exact: true }).inputValue(), "16");
  await page.getByLabel("对话文字大小", { exact: true }).selectOption("18");
  await page.getByRole("button", { name: "并排讨论", exact: true }).click();
  await page.locator('.workspace-grid[data-mode="discuss"]').waitFor();
  await page.evaluate(() => {
    window.__widthWrites = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === "paper-ocean-pane-widths-v1") window.__widthWrites.push(value); return original.call(this, key, value); };
  });
  const divider = page.getByRole("separator", { name: "调整论文阅读区与 AI 对话区宽度", exact: true });
  const before = await page.locator(".reader-pane").boundingBox();
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + 100, { steps: 8 });
  await page.waitForTimeout(80);
  assert.equal((await page.evaluate(() => window.__widthWrites)).length, 0, "dragging does not write preferences on every pointer move");
  assert.ok((await page.locator(".reader-pane").boundingBox()).width > before.width + 40);
  await page.mouse.up();
  await page.waitForFunction(() => window.__widthWrites.length === 1);
  await divider.focus(); await divider.press("ArrowLeft");
  assert.equal((await page.evaluate(() => window.__widthWrites)).length, 2);

  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, pdf);
  await page.getByRole("button", { name: "本地 PDF", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".paper-titlebar")?.textContent.includes("全文索引就绪"));
  await page.getByLabel("打开资料库", { exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "资料库", exact: true });
  await drawer.waitFor();
  await page.waitForTimeout(260);
  const bounds = await drawer.boundingBox();
  assert.ok(bounds.width >= 340 && bounds.width <= 380);
  assert.equal(await page.locator("dialog[open]").count(), 0, "library navigation must not make the reader inert");
  assert.equal(await drawer.locator(".library-archive").getAttribute("open"), null);
  await page.screenshot({ path: path.join(output, "library-drawer.png") });
  await drawer.locator(".library-archive > summary").click();
  assert.ok(await drawer.getByRole("button", { name: "检查并补齐归档", exact: true }).isVisible());
  await drawer.locator(".library-paper-management > summary").first().click();
  assert.ok(await drawer.getByRole("button", { name: "重新定位 PDF", exact: true }).isVisible());
  await page.getByLabel("阅读布局", { exact: true }).click();
  await page.keyboard.press("Escape");
  assert.ok(await drawer.isVisible(), "Escape closes the layout popover before the library drawer");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "打开资料库");

  await page.waitForFunction(() => !document.querySelector(".save-status"));
  const seededLibrary = await page.evaluate(async () => {
    const state = await window.paperOcean.library.load();
    const id = state.lastPaperId;
    const other = "b".repeat(24);
    const base = { body: "Saved research note", createdAt: 1, updatedAt: 2 };
    state.notes = [
      { ...base, id: "current-anchor", title: "Current anchor note", anchors: [{ id: "anchor", paperId: id, page: 1, quote: "fixture", rects: [] }] },
      { ...base, id: "current-source", title: "Current source note", anchors: [], sourceMessage: { scopeKey: `paper:${id}`, messageId: "source" } },
      { ...base, id: "foreign-note", title: "Other paper note", anchors: [{ id: "foreign", paperId: other, page: 1, quote: "other", rects: [] }] },
      { ...base, id: "legacy-note", title: "Legacy unlinked note", anchors: [] },
    ];
    return state;
  });
  assert.ok(seededLibrary.lastPaperId);
  // Load the deterministic legacy-note fixture after reload. The native unload
  // guard saves reading position, so bypass it only inside this isolated test.
  await app.evaluate(({ ipcMain, BrowserWindow }, state) => {
    ipcMain.removeHandler("library:load");
    ipcMain.handle("library:load", () => state);
    BrowserWindow.getAllWindows()[0].webContents.on("will-prevent-unload", event => event.preventDefault());
  }, seededLibrary);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^(研究笔记|笔记)$/ }).first().click();
  const notes = page.getByRole("region", { name: "研究笔记", exact: true });
  await notes.waitFor();
  const select = notes.getByLabel("选择笔记", { exact: true });
  const currentOptions = await select.locator("option").allTextContents();
  assert.ok(currentOptions.includes("Current anchor note") && currentOptions.includes("Current source note"));
  assert.ok(!currentOptions.includes("Other paper note") && !currentOptions.includes("Legacy unlinked note"));
  await notes.getByRole("button", { name: "全部笔记", exact: true }).click();
  await select.selectOption("legacy-note");
  await notes.getByRole("button", { name: "当前论文", exact: true }).click();
  assert.equal(await notes.getByLabel("笔记标题", { exact: true }).inputValue(), "Legacy unlinked note");
  assert.ok(await notes.locator(".notes-scope-notice").isVisible());
  assert.equal(await select.inputValue(), "legacy-note");
  await page.screenshot({ path: path.join(output, "notes-scope.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: legacy workspace preferences, all three layouts at native 1180/1440px, frame-based resizing with release-time persistence, keyboard resize, nonmodal drawer and Escape order, retained archive controls, current/all note provenance and selected-note preservation");
} catch (error) {
  console.error("Workspace renderer errors:", errors);
  if (page && !page.isClosed()) {
    console.error(await page.locator("body").innerText().catch(() => "Body unavailable"));
    await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  }
  throw error;
} finally { await app.close(); }
