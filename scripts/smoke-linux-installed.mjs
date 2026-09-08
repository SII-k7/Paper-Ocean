import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-installed-"));
const application = await electron.launch({ executablePath: "/opt/Paper Ocean/paper-ocean", env: {...process.env, XDG_CONFIG_HOME:root, PAPER_OCEAN_ARCHIVE_DIR:path.join(root,"archive")}, timeout:30000 });
try {
  const page=await application.firstWindow(); const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.getByRole("button",{name:"打开资料库",exact:true}).click();
  await page.getByRole("button",{name:"论文池 · 看过的论文",exact:true}).click();
  await page.getByText("还没有符合条件的论文。打开论文或提问后会自动记入。",{exact:true}).waitFor();
  assert.equal(await application.evaluate(({app})=>app.isPackaged),true);
  assert.equal(await page.evaluate(()=>window.paperOcean.runtime),"electron");
  await page.getByText("同步设置",{exact:true}).click();
  await page.getByLabel("WebDAV 文件夹",{exact:true}).fill("https://example.com/pool/");
  await fs.mkdir("output/linux-smoke",{recursive:true});
  await page.screenshot({path:"output/linux-smoke/installed.png"});
  assert.deepEqual(errors,[]);
  console.log("Installed Ubuntu package: renderer, preload, local pool and settings verified");
} finally {await application.close();}
