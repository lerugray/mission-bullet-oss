// IPC bridge — exposes a narrow API to the renderer without giving it
// Node. The renderer talks to window.missionBullet.*; the main process
// (main.mjs) handles the Node-side work.

const { contextBridge, ipcRenderer } = require("electron");

// Dev-mode signal — renderer uses this to gate surfaces meant only for
// visual-language tuning (TweaksPanel) so regular daily use doesn't see
// the design-time affordances.
const DEV_MODE = process.argv.includes("--dev");

contextBridge.exposeInMainWorld("missionBulletDev", DEV_MODE);

contextBridge.exposeInMainWorld("missionBullet", {
  loadDays: (opts) => ipcRenderer.invoke("mb:loadDays", opts ?? {}),
  knownDates: () => ipcRenderer.invoke("mb:knownDates"),
  readBody: (payload) => ipcRenderer.invoke("mb:readBody", payload ?? {}),
  writeBody: (payload) => ipcRenderer.invoke("mb:writeBody", payload),
  saveEntry: (payload) => ipcRenderer.invoke("mb:saveEntry", payload),
  readMonthly: (payload) => ipcRenderer.invoke("mb:readMonthly", payload ?? {}),
  writeMonthly: (payload) => ipcRenderer.invoke("mb:writeMonthly", payload),
  readReflection: (payload) => ipcRenderer.invoke("mb:readReflection", payload ?? {}),
  readMonthlyReflection: (payload) => ipcRenderer.invoke("mb:readMonthlyReflection", payload ?? {}),
  runReviewWeek: (payload) => ipcRenderer.invoke("mb:runReviewWeek", payload),
  runReviewMonth: (payload) => ipcRenderer.invoke("mb:runReviewMonth", payload),
  saveImage: (payload) => ipcRenderer.invoke("mb:saveImage", payload),
  readImage: (payload) => ipcRenderer.invoke("mb:readImage", payload),
  readSketch: (payload) => ipcRenderer.invoke("mb:readSketch", payload ?? {}),
  writeSketch: (payload) => ipcRenderer.invoke("mb:writeSketch", payload),
  migrateScan: (payload) => ipcRenderer.invoke("mb:migrateScan", payload ?? {}),
  migrateApply: (payload) => ipcRenderer.invoke("mb:migrateApply", payload),
  strikeTask: (payload) => ipcRenderer.invoke("mb:strikeTask", payload),
  syncNow: () => ipcRenderer.invoke("mb:syncNow"),
  syncPull: () => ipcRenderer.invoke("mb:syncPull"),
  getSyncStatus: () => ipcRenderer.invoke("mb:getSyncStatus"),
  onSyncEvent: (cb) => {
    const wrapped = (_e, state) => cb(state);
    ipcRenderer.on("mb:sync-event", wrapped);
    return () => ipcRenderer.removeListener("mb:sync-event", wrapped);
  },
});
