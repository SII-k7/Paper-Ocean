const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperOcean", {
  runtime: "electron",
  openPdf: () => ipcRenderer.invoke("paper:open"),
  reopenPdf: (path) => ipcRenderer.invoke("paper:reopen", path),
  openUrl: (url) => ipcRenderer.invoke("paper:open-url", url),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  setTheme: (theme) => ipcRenderer.invoke("app:set-theme", theme),
  saveContext: (input) => ipcRenderer.invoke("paper:save-context", input),
  savePageImage: (input) => ipcRenderer.invoke("paper:save-page-image", input),
  prepareConversation: (input) => ipcRenderer.invoke("paper:prepare-conversation", input),
  codex: {
    status: () => ipcRenderer.invoke("codex:status"),
    login: () => ipcRenderer.invoke("codex:login"),
    models: () => ipcRenderer.invoke("codex:models"),
    chooseExecutable: () => ipcRenderer.invoke("codex:choose-executable"),
    rateLimits: () => ipcRenderer.invoke("codex:rate-limits"),
    startThread: (input) => ipcRenderer.invoke("codex:start-thread", input),
    resumeThread: (input) => ipcRenderer.invoke("codex:resume-thread", input),
    sendTurn: (input) => ipcRenderer.invoke("codex:send-turn", input),
    interrupt: (input) => ipcRenderer.invoke("codex:interrupt", input),
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("codex:event", handler);
      return () => ipcRenderer.removeListener("codex:event", handler);
    },
  },
  recommendations: (input) => ipcRenderer.invoke("recommendations:fetch", input),
  prepareRecommendationPreview: (arxivId) => (
    ipcRenderer.invoke("recommendations:prepare-preview", arxivId)
  ),
  saveRecommendationThumbnail: (input) => (
    ipcRenderer.invoke("recommendations:save-thumbnail", input)
  ),
  library: {
    load: () => ipcRenderer.invoke("library:load"),
    save: (state) => ipcRenderer.invoke("library:save", state),
  },
});
