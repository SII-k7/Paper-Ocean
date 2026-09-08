// Exercise the real updater transport and hash verification; never execute the fixture payload.
import { app } from "electron";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createAppUpdates } from "../electron/app-updates.mjs";
const require=createRequire(import.meta.url);
const root=await fs.mkdtemp(path.join(os.tmpdir(),"paper-ocean-update-download-"));
app.disableHardwareAcceleration();app.setPath("userData",root);
process.env.LOCALAPPDATA=root;process.env.XDG_CACHE_HOME=root;
app.getVersion=()=>"1.0.0";
const timeout=setTimeout(()=>app.exit(1),60000);
async function run() {
await app.whenReady();
const payload=Buffer.from("Paper Ocean isolated update verification fixture");
let corrupt=false;
const server=createServer((request,response)=> {
  const extension=process.platform==="win32"?"exe":"deb";
  if(request.url.includes(".yml")) {
    const digest=createHash("sha512").update(corrupt?"different bytes":payload).digest("base64");
    response.end(`version: 1.0.1\nfiles:\n  - url: fixture.${extension}\n    sha512: ${digest}\n    size: ${payload.length}\n`);
  } else {response.setHeader("Content-Length",payload.length);response.end(payload);}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try {
  for (const invalid of [false,true]) {
    corrupt=invalid;
    const {NsisUpdater,DebUpdater}=require("electron-updater");
    const Updater=process.platform==="win32"?NsisUpdater:DebUpdater;
    const updater=new Updater();
    updater.logger=null;updater.forceDevUpdateConfig=true;updater.disableDifferentialDownload=true;
    const config=path.join(root,`${randomUUID()}.yml`);
    await fs.writeFile(config,`provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: ${randomUUID()}\n`);
    updater.updateConfigPath=config;
    let saved=0,installed=0;
    const control=createAppUpdates({updater,capability:{supported:true,mode:"test"},currentVersion:"1.0.0",
      prepareInstall:async()=>{saved++;},install:async files=>{assert.deepEqual(await fs.readFile(files[0]),payload);installed++;}});
    assert.equal((await control.check()).stage,"available");
    const result=await control.apply();
    assert.equal(saved,invalid?0:1);assert.equal(installed,invalid?0:1);
    if(invalid) assert.match(result.error,/校验失败/);
  }
  console.log("Real updater HTTP download, SHA-512 rejection and save-before-install handoff passed");
} catch(error) {console.error(error);process.exitCode=1;}
finally {server.closeAllConnections();server.close();clearTimeout(timeout);app.exit(process.exitCode||0);}
}
void run().catch(error=>{console.error(error);app.exit(1);});
