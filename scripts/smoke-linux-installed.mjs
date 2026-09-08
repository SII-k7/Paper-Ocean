import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-installed-"));
const pdf=path.join(root,"ubuntu-smoke.pdf");
const content="BT /F1 24 Tf 60 720 Td (Ubuntu Paper Ocean Smoke Test) Tj ET";
const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let bytes="%PDF-1.4\n", offsets=[0];
for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(bytes));bytes+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
const start=Buffer.byteLength(bytes);bytes+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value=>String(value).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
await fs.writeFile(pdf,bytes);
const application = await electron.launch({ executablePath: "/opt/Paper Ocean/paper-ocean", args:["--disable-gpu"], env: {...process.env, XDG_CONFIG_HOME:root, PAPER_OCEAN_ARCHIVE_DIR:path.join(root,"archive")}, timeout:30000 });
try {
  const page=await application.firstWindow(); const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},pdf);
  await page.getByRole("button",{name:"本地 PDF",exact:true}).click();
  await page.locator(".pdf-page canvas").first().waitFor();
  await page.waitForFunction(()=>document.querySelector('.paper-titlebar')?.textContent.includes('全文索引就绪'));
  await page.getByRole("button",{name:"打开资料库",exact:true}).click();
  await page.getByRole("button",{name:"论文池 · 看过的论文",exact:true}).click();
  await page.locator(".paper-pool article").first().waitFor();
  const pool=await page.evaluate(()=>window.paperOcean.pool.status());
  assert.equal(pool.papers.length,1);assert.ok(pool.papers[0].seenAt>0);assert.equal(pool.papers[0].askedAt,0);
  assert.equal("path" in pool.papers[0],false);
  assert.equal(await application.evaluate(({app})=>app.isPackaged),true);
  assert.equal(await page.evaluate(()=>window.paperOcean.runtime),"electron");
  await page.getByText("同步设置",{exact:true}).click();
  await page.getByLabel("WebDAV 文件夹",{exact:true}).fill("https://example.com/pool/");
  await fs.mkdir("output/linux-smoke",{recursive:true});
  await page.screenshot({path:"output/linux-smoke/installed.png"});
  assert.deepEqual(errors,[]);
  console.log("Installed Ubuntu package: renderer, PDF canvas and index, preload, seen paper pool and settings verified");
} finally {await application.close();}
