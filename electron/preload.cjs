const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperOcean", {
  runtime: "electron",
  searchPapers: (query) => ipcRenderer.invoke("papers:search", query),
  resolvePaperSuggestion: (id) => ipcRenderer.invoke("papers:resolve-suggestion", id),
  archive: {
    status: () => ipcRenderer.invoke("archive:status"),
    retry: () => ipcRenderer.invoke("archive:retry"),
    setCategory: (paperId, category) => ipcRenderer.invoke("archive:set-category", { paperId, category }),
    openFolder: () => ipcRenderer.invoke("archive:open-folder"),
  },
  openPdf: (expectedId) => ipcRenderer.invoke("paper:open", expectedId),
  reopenPdf: (path, expectedId) => ipcRenderer.invoke("paper:reopen", path, expectedId),
  openUrl: (url, requestId) => ipcRenderer.invoke("paper:open-url", url, requestId),
  downloadStatus: (id) => ipcRenderer.invoke("paper:download-status", id),
  cancelDownload: (id) => ipcRenderer.invoke("paper:download-cancel", id),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  setTheme: (theme) => ipcRenderer.invoke("app:set-theme", theme),
  saveContext: (input) => ipcRenderer.invoke("paper:save-context", input),
  savePageImage: (input) => ipcRenderer.invoke("paper:save-page-image", input),
  cachedPageImage: (paperId, page) => ipcRenderer.invoke("paper:cached-page-image", { paperId, page }),
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
    recover: () => ipcRenderer.invoke("library:recover"),
    onBeforeClose: (listener) => {
      const handler = () => { void listener(); };
      ipcRenderer.on("library:before-close", handler);
      return () => ipcRenderer.removeListener("library:before-close", handler);
    },
    finishClose: (result) => ipcRenderer.invoke("library:finish-close", result),
  },
});
