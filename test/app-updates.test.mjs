import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAppUpdates, updateCapability } from "../electron/app-updates.mjs";
import { installDeb } from "../electron/update-runtime.mjs";

const supported = { supported: true, mode: "nsis", message: "test" };
function fixture(overrides = {}) {
  const calls = [];
  const updater = Object.assign(new EventEmitter(), {
    async checkForUpdates() { calls.push("check"); return { isUpdateAvailable: true, updateInfo: { version: "1.2.1" } }; },
    async downloadUpdate() { calls.push("download"); this.emit("download-progress", {percent: 42}); return ["verified-installer"]; },
  });
  const controller = createAppUpdates({ updater, capability: supported, currentVersion: "1.2.0",
    async prepareInstall() { calls.push("save"); }, async install(files) { assert.deepEqual(files, ["verified-installer"]); calls.push("install"); }, ...overrides });
  return { controller, updater, calls };
}
test("checking never downloads; one click coalesces work and saves before installation", async () => {
  const {controller, updater, calls} = fixture();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false); assert.equal(updater.allowPrerelease, false);
  await Promise.all([controller.check(),controller.check()]);
  assert.deepEqual(calls,["check"]);
  await Promise.all([controller.apply(),controller.apply()]);
  assert.deepEqual(calls,["check","download","save","install"]);
});
test("checksum failure never saves or installs and permits a fresh download retry", async () => {
  const {controller, updater, calls} = fixture(); await controller.check();
  updater.downloadUpdate = async () => { throw new Error("sha512 checksum mismatch"); };
  assert.match((await controller.apply()).error,/校验失败/);
  assert.deepEqual(calls,["check"]);
  updater.downloadUpdate = async () => ["verified-installer"];
  await controller.apply(); assert.deepEqual(calls,["check","save","install"]);
});
test("a failed save leaves the app open; retry uses the already verified installer", async () => {
  let saves = 0, installed = 0;
  const {controller, calls} = fixture({ prepareInstall: async () => { if (++saves === 1) throw new Error("记录无法保存"); }, install: async () => { installed++; } });
  await controller.check(); assert.match((await controller.apply()).error,/记录无法保存/); assert.equal(installed,0);
  await controller.apply(); assert.equal(installed,1); assert.equal(calls.filter(c=>c==="download").length,1);
});
test("a failed check or unavailable release cannot install a stale or incompatible version", async () => {
  const {controller, updater, calls} = fixture(); await controller.check();
  updater.checkForUpdates = async () => { throw new Error("offline"); };
  await controller.check(); await controller.apply(); assert.deepEqual(calls,["check"]);
  updater.checkForUpdates = async () => ({isUpdateAvailable:false,updateInfo:{version:"0.4.0"}});
  await controller.check(); await controller.apply(); assert.equal(controller.status().stage,"current");assert.deepEqual(calls,["check"]);
});
test("multiple clicks during an in-flight check still install only once", async () => {
  const {controller, updater, calls} = fixture(); let done;
  updater.checkForUpdates = () => new Promise(resolve=> { done=resolve; });
  const checking=controller.check(); const a=controller.apply(),b=controller.apply();
  done({isUpdateAvailable:true,updateInfo:{version:"1.2.1"}});
  await Promise.all([checking,a,b]); assert.deepEqual(calls,["download","save","install"]);
});
test("cancelled installation stays retryable without silently installing on later quit", async () => {
  let attempt=0;
  const {controller,updater}=fixture({install:async()=>{ if(++attempt===1) throw new Error("安装授权已取消"); }});
  await controller.check(); assert.match((await controller.apply()).error,/授权已取消/);
  assert.equal(updater.autoInstallOnAppQuit,false); await controller.apply(); assert.equal(attempt,2);
});
test("only installed supported formats enable automatic installation", () => {
  const base={packaged:true,platform:"win32",arch:"x64"};
  assert.equal(updateCapability(base).mode,"nsis");
  assert.equal(updateCapability({...base,portable:true}).supported,false);
  assert.equal(updateCapability({...base,packaged:false}).supported,false);
  assert.equal(updateCapability({...base,platform:"darwin"}).supported,false);
  assert.equal(updateCapability({...base,platform:"linux",packageType:"deb"}).mode,"deb");
  assert.equal(updateCapability({...base,platform:"linux",appImage:true}).mode,"appimage");
  assert.equal(updateCapability({...base,platform:"linux"}).supported,false);
});
test("Deb installation uses fixed commands and separate arguments; cancelled elevation rejects", async () => {
  const file=process.platform==="win32" ? "C:\\Downloads\\paper's $(touch bad).deb" : "/tmp/paper's $(touch bad).deb";
  await installDeb(file,(command,args,options)=>{
    assert.equal(command,"/usr/bin/pkexec"); assert.deepEqual(args,["/usr/bin/apt-get","install","--no-remove","-y",file]);
    assert.equal(options.shell,false);
    const child=new EventEmitter(); queueMicrotask(()=>child.emit("exit",0));return child;
  });
  await assert.rejects(installDeb(file,()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit("exit",126));return child;}),/授权已取消/);
});
