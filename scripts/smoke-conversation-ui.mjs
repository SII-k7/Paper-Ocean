import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const output = path.resolve("output/playwright/conversation-ui");
await fs.mkdir(output, { recursive: true });
function pdfText(title) {
  const content = `BT /F1 24 Tf 60 720 Td (${title}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(bytes)); bytes += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(bytes);
  return `${bytes}xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}
const papers = [path.join(output, "Control.pdf"), path.join(output, "World.pdf")];
await Promise.all(papers.map((file, index) => fs.writeFile(file, pdfText(index ? "World model fixture" : "Robot control fixture"))));

console.log("conversation-ui: launching isolated Electron fixture");
const app = await electron.launch({ executablePath: electronPath, args: [path.resolve("scripts/fixtures/auxiliary-chat-entry.mjs")], timeout: 30000 });
try {
  const page = await app.firstWindow({ timeout: 30000 });
  console.log("conversation-ui: fixture window ready");
  page.setDefaultTimeout(12000);
  page.on("dialog", dialog => dialog.accept().catch(() => {}));
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error("renderer:", error.stack); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440,920));
  await app.evaluate(() => globalThis.setupAuxTest());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.on("will-prevent-unload", event => event.preventDefault()));
  await page.reload();
  console.log("conversation-ui: loading the two fixture papers");
  for (const file of papers) {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole("button", { name: "本地 PDF", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".paper-titlebar")?.textContent.includes("全文索引就绪"));
  }
  const tabs = page.getByRole("tab", { name: /^阅读论文/ });
  console.log("conversation-ui: testing composer keyboard and local drafts");
  await tabs.first().click();
  const main = page.locator(".chat-panel"), aux = page.getByRole("region", { name: "论文辅助对话", exact: true });
  const mainField = main.getByLabel("向 Codex 提问", { exact: true }), auxField = aux.getByLabel("辅助对话问题", { exact: true });
  assert.equal(await main.getByLabel("搜索对话", { exact: true }).count(), 0);
  assert.equal(await main.getByLabel("讨论标题", { exact: true }).count(), 0);
  await main.getByLabel("更多对话操作", { exact: true }).click();
  await main.getByLabel("讨论标题", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "更多对话操作");

  await mainField.fill("中文输入候选");
  await mainField.dispatchEvent("compositionstart");
  await mainField.press("Enter");
  assert.equal((await app.evaluate(() => globalThis.requests)).length, 0, "IME confirmation must not send");
  await mainField.dispatchEvent("compositionend");
  await mainField.press("Shift+Enter");
  assert.ok((await mainField.inputValue()).includes("\n"));
  await mainField.fill("FAST_CLEAR_MAIN");
  await mainField.press("Enter");
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="向 Codex 提问"]')?.value === "");
  await page.waitForFunction(() => document.querySelector('.chat-topbar__label')?.textContent === "等待模型响应");
  const first = (await app.evaluate(() => globalThis.requests))[0];
  await app.evaluate((_electron,{request}) => { globalThis.emitAux("item/agentMessage/delta",{threadId:request.threadId,turnId:request.turnId,itemId:"main-answer",delta:"回答来自控制论文。"}); globalThis.emitAux("turn/completed",{threadId:request.threadId,turn:{id:request.turnId,status:"completed"}}); },{request:first});
  await main.getByText("回答来自控制论文。", { exact: true }).waitFor();

  await mainField.fill("控制论文尚未发送的草稿");
  await tabs.last().click();
  assert.equal(await mainField.inputValue(), "");
  await mainField.fill("世界模型的另一份草稿");
  await tabs.first().click();
  assert.equal(await mainField.inputValue(), "控制论文尚未发送的草稿");

  await aux.locator(".auxiliary-chat__toggle").click();
  await auxField.fill("辅助草稿折叠后保留");
  await auxField.press("Escape");
  assert.equal(await aux.locator(".auxiliary-chat__toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "auxiliary-chat__toggle");
  await aux.locator(".auxiliary-chat__toggle").click();
  assert.equal(await auxField.inputValue(), "辅助草稿折叠后保留");
  await auxField.dispatchEvent("compositionstart"); await auxField.press("Enter");
  assert.equal((await app.evaluate(() => globalThis.requests)).length, 1);
  await auxField.dispatchEvent("compositionend");
  const auxiliaryDraftAfterIme = await auxField.inputValue();

  await page.locator(".pdf-text-layer span").first().evaluate(span => {
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(span); selection.removeAllRanges(); selection.addRange(range);
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  console.log("conversation-ui: testing source attachment routing");
  await page.getByRole("button", { name: "问辅助对话", exact: true }).click();
  await aux.getByRole("group", { name: "已附加原文", exact: true }).waitFor();
  assert.equal(await main.getByRole("group", { name: "已附加原文", exact: true }).count(), 0);
  await aux.getByLabel("移除原文附件", { exact: true }).click();
  assert.equal(await aux.getByRole("group", { name: "已附加原文", exact: true }).count(), 0);

  await page.locator(".pdf-text-layer span").first().evaluate(span => {
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(span); selection.removeAllRanges(); selection.addRange(range);
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "问主对话", exact: true }).click();
  await main.getByRole("group", { name: "已附加原文", exact: true }).waitFor();
  await mainField.fill("ATTACHED_QUESTION"); await mainField.press("Enter");
  await main.getByRole("group", { name: "已发送选文", exact: true }).waitFor();
  assert.equal(await main.getByRole("group", { name: "已附加原文", exact: true }).count(), 0);
  assert.equal(await mainField.inputValue(), "");
  await main.getByLabel("停止回答", { exact: true }).click();
  await main.getByLabel("发送问题", { exact: true }).waitFor();
  await mainField.fill("关闭前尚未到合并时间的草稿");
  await page.evaluate(async () => {
    const tasks = [];
    window.dispatchEvent(new CustomEvent("paper-ocean-before-close", { detail: { waitUntil: task => tasks.push(task) } }));
    await Promise.all(tasks);
    window.dispatchEvent(new Event("paper-ocean-before-save"));
  });
  await page.waitForFunction(async () => Object.values((await window.paperOcean.library.load()).draftsByScope ?? {}).includes("关闭前尚未到合并时间的草稿"), null, { polling: 100 });
  await page.reload();
  console.log("conversation-ui: verifying saved drafts and source history");
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="向 Codex 提问"]')?.value === "关闭前尚未到合并时间的草稿");
  assert.equal(await auxField.inputValue(), auxiliaryDraftAfterIme);
  assert.equal(await main.getByRole("group", { name: "已发送选文", exact: true }).count(), 1);
  await main.getByLabel("讨论历史", { exact: true }).click();
  await main.getByLabel("选择讨论", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(output, "conversations.png") });

  console.log("conversation-ui: testing auxiliary old-answer note return during new output");
  const waitForRequest = async question => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const request = await app.evaluate((_electron, question) => globalThis.requests.find(item => item.prompt.includes(question)), question);
      if (request) return request;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Missing fixture request: ${question}`);
  };
  const emitAnswer = (request, text, complete = false) => app.evaluate((_electron, { request, text, complete }) => {
    globalThis.emitAux("item/agentMessage/delta", { threadId: request.threadId, turnId: request.turnId, itemId: request.turnId, delta: text });
    if (complete) globalThis.emitAux("turn/completed", { threadId: request.threadId, turn: { id: request.turnId, status: "completed" } });
  }, { request, text, complete });
  await auxField.fill("AUXILIARY_FIRST_NOTE_SOURCE");
  await aux.getByLabel("发送辅助问题", { exact: true }).click();
  const auxiliaryFirstRequest = await waitForRequest("AUXILIARY_FIRST_NOTE_SOURCE");
  const oldAnswer = "第一条辅助回答：用于验证旧消息定位。\n\n" + Array.from({ length: 22 }, (_, index) => `第 ${index + 1} 条控制观察：我们需要结合原文检查反馈信号、目标动作与实验指标，保留证据来源，在多个阅读步骤之间保持当前段落的位置。`).join("\n\n");
  await emitAnswer(auxiliaryFirstRequest, oldAnswer, true);
  const firstAuxiliaryAnswer = aux.locator(".auxiliary-message--assistant").first();
  await firstAuxiliaryAnswer.getByRole("button", { name: "保存为笔记", exact: true }).waitFor();
  const firstAuxiliaryId = await firstAuxiliaryAnswer.getAttribute("data-message-id");
  await auxField.fill("AUXILIARY_SECOND_CONTINUING");
  await aux.getByLabel("发送辅助问题", { exact: true }).click();
  const auxiliarySecondRequest = await waitForRequest("AUXILIARY_SECOND_CONTINUING");
  const secondAnswer = "第二条辅助回答仍在继续。\n\n" + Array.from({ length: 12 }, (_, index) => `后续段落 ${index + 1}：这是另一条回答的输出，不能把已返回笔记来源的读者拉回最新位置。`).join("\n\n");
  await emitAnswer(auxiliarySecondRequest, secondAnswer);
  await aux.getByText("第二条辅助回答仍在继续。", { exact: true }).waitFor();
  const auxiliaryScroller = aux.locator(".auxiliary-chat__messages");
  await auxiliaryScroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const hiddenOldAnswer = await firstAuxiliaryAnswer.evaluate(node => {
    const scroller = node.closest(".auxiliary-chat__messages");
    return { bottom: node.getBoundingClientRect().bottom, viewportTop: scroller.getBoundingClientRect().top };
  });
  assert.ok(hiddenOldAnswer.bottom < hiddenOldAnswer.viewportTop, "the first answer must be wholly outside the viewport before note return");
  await firstAuxiliaryAnswer.getByRole("button", { name: "保存为笔记", exact: true }).click();
  await page.getByText("回答已存入笔记", { exact: true }).waitFor();
  const auxiliarySavedNote = await page.evaluate(async messageId => (await window.paperOcean.library.load()).notes.find(note => note.sourceMessage?.messageId === messageId), firstAuxiliaryId);
  assert.ok(auxiliarySavedNote.sourceMessage.scopeKey.startsWith("auxiliary:"));
  assert.equal(auxiliarySavedNote.body, oldAnswer);
  await page.locator(".note-save-feedback").getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("笔记正文", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("笔记正文", { exact: true }).inputValue(), oldAnswer);
  await auxiliaryScroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await aux.locator(".auxiliary-chat__toggle").click();
  await page.getByRole("button", { name: "返回原回答", exact: true }).click();
  await page.waitForFunction(messageId => document.activeElement?.getAttribute("data-message-id") === messageId, firstAuxiliaryId);
  await page.waitForFunction(messageId => {
    const scroller = document.querySelector(".auxiliary-chat__messages");
    const target = Array.from(scroller?.querySelectorAll("[data-message-id]") ?? []).find(node => node.dataset.messageId === messageId);
    return target && Math.abs(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top) <= 8;
  }, firstAuxiliaryId);
  const returnedTop = await auxiliaryScroller.evaluate(node => node.scrollTop);
  await emitAnswer(auxiliarySecondRequest, "\n\nRETURN_NOTE_NEW_DELTA\n\n" + "新的流式段落仍然留在下方。\n\n".repeat(8));
  await aux.getByText("RETURN_NOTE_NEW_DELTA", { exact: true }).waitFor();
  await aux.getByRole("button", { name: "查看新回答", exact: true }).waitFor();
  await page.waitForTimeout(450);
  const returnPosition = await firstAuxiliaryAnswer.evaluate(node => {
    const scroller = node.closest(".auxiliary-chat__messages");
    return { gap: node.getBoundingClientRect().top - scroller.getBoundingClientRect().top, scrollTop: scroller.scrollTop, focused: document.activeElement === node };
  });
  assert.ok(Math.abs(returnPosition.gap) <= 8, JSON.stringify(returnPosition));
  assert.ok(Math.abs(returnPosition.scrollTop - returnedTop) <= 8, "new streaming output must not move the old answer reading position");
  assert.equal(returnPosition.focused, true, "note return must focus the source article");
  await emitAnswer(auxiliarySecondRequest, "\n\n第二条回答完成。", true);
  await aux.getByLabel("发送辅助问题", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "auxiliary-note-return.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: on-demand tools, Escape focus, Chinese IME and Shift+Enter, rapid send/clear, scope-owned drafts, auxiliary collapse, explicit attachment removal and sent-history provenance, save/restore, auxiliary old-answer note return with focus and stable scroll during new output");
} catch (error) {
  console.error(error);
  const page = app.windows()[0];
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), timeout: 5000 }).catch(() => {});
  throw error;
} finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
