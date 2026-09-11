import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import electronPath from 'electron';
import assert from 'node:assert/strict';
await fs.mkdir('output/playwright/auxiliary-chat',{recursive:true});
const pdf=path.resolve('output/playwright/auxiliary-chat/first.pdf');
const content='BT /F1 24 Tf 60 720 Td (Synthetic robot control paper) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let bytes='%PDF-1.4\n',offsets=[0];
for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(bytes));bytes+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
const start=Buffer.byteLength(bytes);bytes+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;await fs.writeFile(pdf,bytes);
const application=await electron.launch({executablePath:electronPath,args:[path.resolve('scripts/fixtures/auxiliary-chat-entry.mjs')],timeout:30000});
try {
 const page=await application.firstWindow();page.on('dialog',dialog=>dialog.accept().catch(()=>undefined));const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await application.evaluate(()=>globalThis.setupAuxTest());await page.reload();
 await application.evaluate(({dialog},pdf)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pdf]});},pdf);
 await page.getByRole('button',{name:'本地 PDF',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.paper-titlebar')?.textContent.includes('全文索引就绪'));
 const aux=page.getByRole('region',{name:'论文辅助对话'});await aux.locator('.auxiliary-chat__toggle').click();
 await page.getByLabel('向 Codex 提问',{exact:true}).fill('MAIN_SENTINEL');await page.getByLabel('发送问题',{exact:true}).click();
 await aux.getByLabel('辅助对话问题').fill('AUX_SENTINEL');await aux.getByLabel('发送辅助问题').click();
 await page.waitForFunction(()=>!!document.querySelector('button[aria-label="停止辅助回答"]'));
 await new Promise(resolve=>setTimeout(resolve,1200));
 const requests=await application.evaluate(()=>globalThis.requests);assert.equal(requests.length,2,JSON.stringify(requests));
 const main=requests.find(r=>r.prompt.includes('MAIN_SENTINEL'));const secondary=requests.find(r=>r.prompt.includes('AUX_SENTINEL'));
 assert.notEqual(main.threadId,secondary.threadId);assert.notEqual(main.contextDir,secondary.contextDir);
 for(const r of requests){assert.equal(r.model,'gpt-5.6-luna');assert.equal(r.effort,'max');assert.equal(r.serviceTier,'priority');assert.ok(r.entries.length);}
 const emit=async(r,text)=>application.evaluate((_unused,{r,text})=>globalThis.emitAux('item/agentMessage/delta',{threadId:r.threadId,turnId:r.turnId,itemId:'same-id',delta:text}),{r,text});
 await emit(main,'主窗口独立回答。');await emit(secondary,'辅助窗口独立回答。');await emit(main,'主窗口第二段。');
 await aux.getByText('辅助窗口独立回答。',{exact:true}).waitFor();
 assert.ok(!(await aux.innerText()).includes('主窗口独立回答'));
 assert.ok(!(await page.locator('.chat-panel').innerText()).includes('辅助窗口独立回答'));
 await aux.locator('.auxiliary-chat__toggle').click();await emit(secondary,'折叠时继续。');
 await aux.getByText('正在回答…',{exact:true}).waitFor();await aux.locator('.auxiliary-chat__toggle').click();
 await aux.getByLabel('停止辅助回答').click();
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="停止辅助回答"]'));
 assert.equal((await application.evaluate(()=>globalThis.interrupts))[0].threadId,secondary.threadId);
 await emit(main,'辅助停止后主窗口仍在输出。');
 await application.evaluate((_unused,r)=>globalThis.emitAux('turn/completed',{threadId:r.threadId,turn:{id:r.turnId,status:'completed'}}),main);
 await page.waitForFunction(()=>!document.querySelector('.send-button--stop'));
 await aux.getByLabel('辅助对话问题').fill('独立草稿');await page.waitForTimeout(1000);
 await page.screenshot({path:'output/playwright/auxiliary-chat/expanded.png'});
 await page.waitForFunction(()=>!document.querySelector('.save-status'));await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.on('will-prevent-unload',event=>event.preventDefault()));await page.reload({waitUntil:'domcontentloaded'});await page.getByLabel('辅助对话问题').waitFor();
 assert.equal(await page.getByLabel('辅助对话问题').inputValue(),'独立草稿');
 assert.ok((await aux.innerText()).includes('辅助窗口独立回答'));assert.ok(!(await aux.innerText()).includes('主窗口独立回答'));
 const saved=await page.evaluate(()=>window.paperOcean.library.load());const auxKey=Object.keys(saved.threadsByScope).find(k=>k.startsWith('auxiliary:'));assert.ok(auxKey);assert.equal(saved.threadsByScope[auxKey],secondary.threadId);
 await aux.getByLabel('发送辅助问题').click();await page.waitForTimeout(1500);
 assert.equal((await application.evaluate(()=>globalThis.requests)).at(-1).threadId,secondary.threadId);
 await aux.getByLabel('停止辅助回答').click();
 
 await fs.writeFile(path.resolve('output/playwright/auxiliary-chat/second.pdf'),(await fs.readFile(pdf,'utf8')).replaceAll('control','walking'));
 await application.evaluate(({dialog},pdf)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pdf]});},path.resolve('output/playwright/auxiliary-chat/second.pdf'));
 await page.getByRole('button',{name:'本地 PDF',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.paper-tab').length===2);
 assert.equal(await aux.getByLabel('辅助对话问题').inputValue(),'');
 assert.ok(!(await aux.innerText()).includes('辅助窗口独立回答'));
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,768));
 await page.waitForTimeout(700);
 await page.screenshot({path:'output/playwright/auxiliary-chat/narrow.png'});
 const rect=await aux.boundingBox();const reader=await page.locator('.reader-body').boundingBox();
 assert.ok(rect.x>=reader.x&&rect.x+rect.width<=reader.x+reader.width+1);
 assert.ok(rect.y>=reader.y&&rect.y+rect.height<=reader.y+reader.height+1);
 await aux.locator('.auxiliary-chat__toggle').click();await page.screenshot({path:'output/playwright/auxiliary-chat/collapsed.png'});
 assert.ok((await aux.boundingBox()).height<55);
 assert.deepEqual(errors,[]);console.log('PASS: simultaneous sends, unique threads/context, interleaved output isolation, collapse continues, independent interrupt, saved histories/draft and resume');
}finally{await application.close();}



