// The renderer can request an update, but cannot supply a feed, file or command.
export function updateCapability({ packaged, platform, arch, portable, appImage, packageType }) {
  if (!packaged) return { supported: false, mode: "manual", message: "源码运行时请更新代码；安装版支持应用内更新。" };
  if (platform === "win32" && arch === "x64" && !portable) return { supported: true, mode: "nsis", message: "点击一键更新后，将下载安装包、保存阅读记录并重启。" };
  if (platform === "linux" && arch === "x64" && (appImage || packageType === "deb")) return {
    supported: true, mode: appImage ? "appimage" : "deb",
    message: appImage ? "点击一键更新后，将下载、保存阅读记录并重启。" : "点击一键更新后自动下载安装；系统会请求安装授权，完成后重启。",
  };
  return { supported: false, mode: "manual", message: platform === "win32" ? "便携版请安装 Windows Setup 安装版，之后即可在应用内更新。" : "此安装形式暂不支持应用内安装，请从发布页面下载更新。" };
}

export function createAppUpdates({ updater, capability, currentVersion, prepareInstall, install }) {
  let state = { ...capability, stage: "idle", currentVersion, version: "", percent: 0, error: "", canUpdate: false };
  let checking, applying, downloadedFiles, hasUpdate = false;
  const status = () => ({ ...state });
  const set = values => { state = { ...state, ...values }; };
  const fail = (error, operation) => {
    const detail = String(error?.message || error);
    set({ stage: "error", error: /sha512|checksum|signature|digest/i.test(detail) ? "安装包校验失败，已停止更新，请重试。" : operation === "install" ? `更新未完成：${detail.slice(0, 200)}` : operation === "download" ? "下载未完成，请检查网络后重试；现有应用仍可使用。" : "暂时无法检查更新，请检查网络或查看发布页面。" });
  };
  if (capability.supported) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on("error", error => fail(error, applying ? (state.stage === "installing" ? "install" : "download") : "check"));
    updater.on("download-progress", progress => set({ percent: Math.min(100, Math.max(0, Math.round(progress.percent || 0))) }));
  }
  async function check() {
    if (!capability.supported || applying) return status();
    if (checking) return checking;
    checking = (async () => {
      set({ stage: "checking", error: "", canUpdate: false });
      hasUpdate = false;
      try {
        const result = await updater.checkForUpdates();
        if (!result) throw new Error("No update result");
        // The updater owns the version comparison and excludes prereleases/downgrades.
        const available = Boolean(result.isUpdateAvailable);
        hasUpdate = available;
        if (state.version !== result.updateInfo.version) downloadedFiles = undefined;
        set({ version: result.updateInfo.version, canUpdate: available, stage: available ? (downloadedFiles ? "ready" : "available") : "current", percent: downloadedFiles ? 100 : 0 });
      } catch (error) { fail(error, "check"); }
      return status();
    })().finally(() => { checking = undefined; });
    return checking;
  }
  async function apply() {
    if (!capability.supported) return status();
    if (applying) return applying;
    if (checking) await checking;
    if (applying) return applying;
    if (!hasUpdate || !["available", "ready", "error"].includes(state.stage)) return status();
    applying = (async () => {
      try {
        if (!downloadedFiles) {
          set({ stage: "downloading", percent: 0, error: "" });
          downloadedFiles = await updater.downloadUpdate();
          if (!downloadedFiles?.length) throw new Error("安装包尚未下载完成");
        }
        set({ stage: "installing", percent: 100, error: "" });
        await prepareInstall();
        // A failed save or cancelled system authorization leaves the app open.
        await install(downloadedFiles);
      } catch (error) { fail(error, downloadedFiles ? "install" : "download"); }
      return status();
    })().finally(() => { applying = undefined; });
    return applying;
  }
  return { status, check, apply };
}
