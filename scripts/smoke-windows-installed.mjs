import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const version=JSON.parse(await fs.readFile("package.json","utf8")).version;
const root=await fs.mkdtemp(path.join(os.tmpdir(),"paper-ocean-installed-"));
const installDir=path.join(root,"Paper Ocean");
await promisify(execFile)(path.resolve(`release/Paper-Ocean-${version}-win-x64-Setup.exe`),["/S",`/D=${installDir}`],{timeout:120000});
const application=await electron.launch({executablePath:path.join(installDir,"Paper Ocean.exe"),args:["--disable-gpu"],timeout:30000});
try {
  const page=await application.firstWindow();
  await page.locator(".brand-mark").waitFor();
  assert.equal(await application.evaluate(({app})=>app.isPackaged),true);
  const status=await page.evaluate(()=>window.paperOcean.updates.status());
  assert.equal(status.supported,true);assert.equal(status.mode,"nsis");assert.equal(status.currentVersion,version);
  await page.getByLabel("应用设置",{exact:true}).click();
  await page.getByRole("button",{name:"关于 Paper Ocean 与更新",exact:true}).click();
  await page.getByText("点击一键更新后，将下载安装包、保存阅读记录并重启。",{exact:true}).waitFor();
  await fs.mkdir("output/windows-smoke",{recursive:true});
  await page.screenshot({path:"output/windows-smoke/installed.png"});
  console.log("Installed Windows Setup: bundled updater, preload, version and update panel passed");
} finally {await application.close();}
