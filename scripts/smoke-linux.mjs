// Run with Electron under a graphical Ubuntu session (or Xvfb in CI).
import { app } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-ocean-linux-smoke-"));
// Virtual CI displays do not provide a real GPU; keep Chromium sandbox enabled.
app.disableHardwareAcceleration();
app.setPath("userData",root);app.setPath("sessionData",path.join(root,"session"));
process.env.PAPER_OCEAN_ARCHIVE_DIR=path.join(root,"archive");
const timeout = setTimeout(()=>{console.error("Linux window smoke test timed out");app.exit(1);},45000);
app.on("browser-window-created",(_event,window)=> {
  window.webContents.on("render-process-gone",()=>app.exit(1));
  window.webContents.on("did-fail-load",()=>app.exit(1));
  window.webContents.once("did-finish-load",async()=> {
    try {
      const result = await window.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<100;i++) {
          const button=document.querySelector('[aria-label="打开资料库"]');
          if(button && !button.disabled) {button.click(); break;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        await new Promise(resolve=>setTimeout(resolve,200));
        const tab=[...document.querySelectorAll('button')].find(button=>button.textContent==='论文池 · 看过的论文');
        if(!tab) throw new Error('Paper pool tab missing');tab.click();
        await new Promise(resolve=>setTimeout(resolve,200));
        const pool=await window.paperOcean.pool.status();
        return {platform:window.paperOcean.runtime, pool:pool.papers, dialog:!!document.querySelector('dialog[open]'), view:!!document.querySelector('[aria-label="共享论文列表"]')};
      })()`);
      if(result.platform !== "electron" || !result.dialog || !result.view || result.pool.length) throw new Error(JSON.stringify(result));
      await fs.mkdir("output/linux-smoke",{recursive:true});
      await fs.writeFile("output/linux-smoke/window.png",(await window.capturePage()).toPNG());
      console.log("Linux renderer, preload, library and paper pool verified",JSON.stringify(result));
      clearTimeout(timeout);app.exit(0);
    } catch(error) {console.error(error);app.exit(1);}
  });
});
await import("../electron/main.mjs");
