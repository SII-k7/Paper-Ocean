import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAppUpdates, updateCapability } from "./app-updates.mjs";
const require = createRequire(import.meta.url);

export function installDeb(file, spawnProcess = spawn) {
  if (!path.isAbsolute(file) || !file.endsWith(".deb")) return Promise.reject(new Error("安装包路径无效"));
  return new Promise((resolve, reject) => {
    // Fixed executables and separate arguments: no shell, command interpolation or dependency repair.
    const child = spawnProcess("/usr/bin/pkexec", ["/usr/bin/apt-get", "install", "--no-remove", "-y", file], {
      stdio: "ignore", shell: false,
    });
    child.once("error", () => reject(new Error("无法启动系统安装授权，请确认已安装 pkexec。")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(code === 126 || code === 127 ? "安装授权已取消，可再次点击更新。" : "系统安装失败，请检查网络、磁盘空间或是否有其他软件正在安装。")));
  });
}

export function createDesktopUpdates({ app, prepareInstall }) {
  const typeFile = path.join(process.resourcesPath, "package-type");
  const packageType = existsSync(typeFile) ? readFileSync(typeFile, "utf8").trim() : "";
  const capability = updateCapability({ packaged: app.isPackaged, platform: process.platform, arch: process.arch,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE), appImage: Boolean(process.env.APPIMAGE), packageType });
  const updater = capability.supported ? require("electron-updater").autoUpdater : null;
  return createAppUpdates({ updater, capability, currentVersion: app.getVersion(), prepareInstall,
    install: async files => {
      if (capability.mode === "deb") {
        await installDeb(files[0]);
        app.relaunch();
        app.quit();
      } else {
        updater.quitAndInstall(true, true);
      }
    },
  });
}
