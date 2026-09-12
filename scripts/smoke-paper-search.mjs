import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import path from 'node:path';import {fileURLToPath} from 'node:url';import electronPath from 'electron';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=path.join(root,'output/playwright/paper-search');await fs.mkdir(output,{recursive:true});
const pdf=path.join(output,'fixture.pdf'),content='BT /F1 24 Tf 60 720 Td (Synthetic robot control paper) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let bytes='%PDF-1.4\n';const offsets=[0];
for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(bytes));bytes+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
const start=Buffer.byteLength(bytes);bytes+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;await fs.writeFile(pdf,bytes);
const application=await electron.launch({executablePath:electronPath,args:[path.join(root,'scripts/fixtures/paper-search-entry.mjs')],env:{...process.env,PAPER_OCEAN_SEARCH_FIXTURE:pdf},timeout:30000});
const page=await application.firstWindow();
// Own beforeunload dialogs during teardown; the native window may already
// have closed when Playwright acknowledges the notification.
page.on('dialog', dialog => { void dialog.accept().catch(() => undefined); });
try {
 const errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await application.evaluate(()=>globalThis.setupSearchTest());await page.reload();
 const input=page.getByRole('combobox',{name:'搜索论文标题、arXiv ID 或链接'});await input.waitFor();
 await input.fill('diffu');await page.waitForTimeout(380);await input.fill('openvl');await input.focus();
 await page.getByRole('option',{name:/OpenVLA/}).waitFor();await page.waitForTimeout(900);
 assert.equal(await page.getByRole('option',{name:/Diffusion/}).count(),0);
 await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false');
 await input.press('ArrowUp');assert.ok(await page.locator('[role="option"][aria-selected="true"]').count());
 await input.press('Escape');await input.focus();await input.press('Enter');
 await page.waitForFunction(()=>document.querySelector('.paper-titlebar')?.textContent.includes('全文索引就绪'));
 assert.deepEqual(await application.evaluate(()=>globalThis.openCalls),['2406.09246']);
 assert.deepEqual(await application.evaluate(()=>globalThis.resolveCalls),['W1']);
 await input.fill('open vla');await page.locator('.paper-search-popover').getByRole('option',{name:/OpenVLA/}).waitFor();
 await page.waitForTimeout(400);await page.screenshot({path:output+'/local-fuzzy.png'});
 await input.fill('全身 控');await input.dispatchEvent('compositionstart');await input.press('Enter');
 const before=await application.evaluate(()=>globalThis.openCalls.length);assert.equal(before,1);
 await input.fill('全身 控制');await input.dispatchEvent('compositionend');
 await page.getByRole('option',{name:/机器人全身运动控制/}).waitFor();
 await input.press('Enter');await page.waitForFunction(()=>!document.querySelector('[role="combobox"]').value);
 assert.equal((await application.evaluate(()=>globalThis.openCalls)).length,2);
 await input.fill('retry');await page.getByText('模拟服务暂不可用',{exact:true}).waitFor();
 await page.getByRole('button',{name:'搜索论文',exact:true}).click();
 await page.getByRole('option',{name:/Retry Robot/}).waitFor();
 await page.getByRole('button',{name:'搜索论文',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[role="combobox"]').value);
 assert.equal((await application.evaluate(()=>globalThis.openCalls)).at(-1),'2401.00003');
 await input.fill('https://arxiv.org/abs/2401.00004');await input.press('Enter');
 await page.waitForFunction(()=>!document.querySelector('[role="combobox"]').value);
 assert.equal((await application.evaluate(()=>globalThis.openCalls)).at(-1),'2401.00004');
 assert.deepEqual(errors,[]);
 const result=await application.evaluate(()=>({searchCalls:globalThis.searchCalls,openCalls:globalThis.openCalls,resolveCalls:globalThis.resolveCalls}));
 await fs.writeFile(output+'/checks.json',JSON.stringify(result,null,2));
 console.log('PASS: latest-query response isolation, Escape/ArrowUp, one-Enter open, OpenAlex resolution, typo/local matching, IME guard, failed-search retry, direct arxiv URL import; fixture transport, real Electron/PDF rendering.');
}catch(error){console.log(JSON.stringify({failure:error.message,body:(await page.locator('body').innerText()).slice(0,3000),calls:await application.evaluate(()=>({search:globalThis.searchCalls,open:globalThis.openCalls}))}));await page.screenshot({path:output+'/failure.png'});throw error;}finally{await application.close();}
