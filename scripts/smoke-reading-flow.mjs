import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve('output/playwright/reading-flow');
await fs.mkdir(output, { recursive: true });
const input = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-ocean-reading-flow-'));
const pdf = path.join(input, 'reading.pdf');
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', ...[5, 6].map(id => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${id} 0 R >>`), ...['Source selection belongs to this paper.', 'Evidence on the second page.'].map(text => { const content = `BT /F1 18 Tf 60 720 Td (${text}) Tj ET`; return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`; }), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
let bytes = '%PDF-1.4\n', offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(bytes)); bytes += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const start = Buffer.byteLength(bytes); bytes += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
await fs.writeFile(pdf, bytes);
const app = await electron.launch({ executablePath: electronPath, args: [path.resolve('scripts/fixtures/auxiliary-chat-entry.mjs')], timeout: 30_000 });
let page;
try {
  page = await app.firstWindow(); page.on('dialog', dialog => void dialog.accept().catch(() => {}));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(() => globalThis.setupAuxTest()); await page.reload();
  await app.evaluate(({ BrowserWindow, dialog }, pdf) => { BrowserWindow.getAllWindows()[0].setSize(1280, 900); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdf] }); }, pdf);
  await page.getByRole('button', { name: '本地 PDF', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.paper-titlebar')?.textContent.includes('全文索引就绪'));
  await page.waitForFunction(() => document.querySelector('.pdf-text-layer span')?.textContent.length > 4);
  const select = () => page.locator('.pdf-text-layer span').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await select(); await page.getByRole('button', { name: '问主对话', exact: true }).click();
  const composer = page.locator('.conversation-composer');
  await composer.getByRole('group', { name: '已附加原文', exact: true }).waitFor();
  assert.equal(await page.getByLabel('向 Codex 提问', { exact: true }).evaluate(node => node === document.activeElement), true, 'attachment sends focus to chosen composer');
  await page.getByLabel('向 Codex 提问', { exact: true }).fill('解释所选内容并引用第二页');
  await page.getByLabel('发送问题', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chat-topbar__label')?.textContent === '等待模型响应');
  const request = (await app.evaluate(() => globalThis.requests))[0]; assert.ok(request.selectedText.includes('Source selection'));
  await page.waitForFunction(() => !document.querySelector('.save-status'));
  const library = await page.evaluate(() => window.paperOcean.library.load()); const paperId = library.papers[0].id;
  const scope = Object.keys(library.messagesByScope).find(key => key.startsWith('paper:'));
  assert.equal(library.messagesByScope[scope][0].attachment.paperId, paperId);
  assert.equal(library.draftAttachmentsByScope?.[scope], undefined);
  const answer = `这是用于交互测试的模拟回答。选文来自当前论文。\n\n[核对第二页](#paper=${paperId}&page=2)\n\n` + Array.from({ length: 9 }, (_, index) => `第 ${index + 1} 条阅读记录：保留论文来源，并在原文中核对结论。`).join('\n\n');
  await app.evaluate((_unused, { request, answer }) => {
    globalThis.emitAux('item/agentMessage/delta', { threadId: request.threadId, turnId: request.turnId, itemId: 'reading-flow', delta: answer });
    globalThis.emitAux('turn/completed', { threadId: request.threadId, turn: { id: request.turnId, status: 'completed' } });
  }, { request, answer });
  await page.locator('.chat-panel').getByRole('button', { name: '保存为笔记', exact: true }).waitFor();
  const chatScroll = await page.locator('.message-list').evaluate(node => node.scrollTop);
  await page.locator('.chat-panel').getByRole('button', { name: '保存为笔记', exact: true }).click();
  await page.getByText('回答已存入笔记', { exact: true }).waitFor();
  assert.equal(await page.locator('.chat-panel').isVisible(), true, 'saving an answer keeps the conversation open');
  assert.ok(Math.abs(await page.locator('.message-list').evaluate(node => node.scrollTop) - chatScroll) <= 8, 'saving a note preserves answer reading position');
  let saved = await page.evaluate(() => window.paperOcean.library.load());
  assert.equal(saved.notes.length, 1); assert.equal(saved.notes[0].sourceMessage.scopeKey, scope);
  assert.equal(saved.notes[0].anchors[0].page, 2);
  await page.locator('.note-save-feedback').getByRole('button', { name: '查看', exact: true }).click();
  await page.getByLabel('笔记正文', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('笔记正文').inputValue(), answer);
  await page.getByRole('button', { name: '返回原回答', exact: true }).click();
  await page.locator('.chat-panel').getByRole('button', { name: '保存为笔记', exact: true }).waitFor();
  await page.getByRole('button', { name: '核对第二页 ↗', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.page-controls input')?.value === '2');
  await page.getByRole('button', { name: '← 返回引用前的阅读位置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.page-controls input')?.value === '1');
  await page.getByLabel('讨论历史', { exact: true }).click();
  assert.equal(await page.getByLabel('选择讨论', { exact: true }).inputValue(), scope, 'evidence navigation leaves conversation scope unchanged');
  await page.getByLabel('关闭对话工具').click();
  await page.locator('.chat-panel').getByRole('button', { name: '保存为笔记', exact: true }).click();
  await page.getByText('回答已存入笔记', { exact: true }).waitFor();
  await page.locator('.note-save-feedback').getByRole('button', { name: '撤销', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.save-status'));
  saved = await page.evaluate(() => window.paperOcean.library.load()); assert.equal(saved.notes.length, 1, 'undo removes only the newly saved note');
  await page.screenshot({ path: path.join(output, 'reading-flow.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: explicit source attachment, persisted sent source, save note in place with scroll retention, actual note persistence, note-to-answer return, citation jump and reading return, unchanged conversation scope, and targeted undo');
} catch (error) { await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally {
  await app.close();
  if (path.dirname(path.resolve(input)) === path.resolve(os.tmpdir()) && path.basename(input).startsWith('paper-ocean-reading-flow-')) await fs.rm(input, { recursive: true, force: true });
}
