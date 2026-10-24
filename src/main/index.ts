import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { join } from "node:path"
import { API_METHODS, type Api, type MainEvent } from "@shared/api"
import { LANGUAGES, PRESETS } from "@shared/defaults"
import type { AiSettings } from "@shared/types"
import { runAnalyze, runChat, runGenerate, runPlan, chatTitle } from "./agent"
import { runBuildKb } from "./buildkb"
import { getSetting, openDb, setSetting } from "./db"
import * as importers from "./importers"
import { cancelJob, emit, isBusy, listJobs, setBroadcaster, startJob } from "./jobs"
import { undo } from "./journal"
import { applyMcp, mcpConfig, mcpStatus, saveMcpConfig } from "./mcp"
import { chat, currentModel, keyHint, listModels, readKey, saveKey } from "./openrouter"
import * as repo from "./repo"

let win: BrowserWindow | null = null
let dbPath = ""

function aiSettings(): AiSettings {
  const mcp = mcpConfig()
  return {
    hasKey: !!readKey(),
    keyHint: keyHint(),
    model: currentModel(),
    language: getSetting("ai.language", LANGUAGES[0]),
    mcp: { ...mcp, ...mcpStatus() },
  }
}

const api: Api = {
  /* labs */
  listLabs: async () => repo.listLabs(),
  presets: async () => PRESETS,
  createLab: async (input) => repo.createLab(input),
  updateLab: async (id, patch) => repo.updateLab(id, patch),
  deleteLab: async (id) => repo.deleteLab(id),
  openLab: async (id) => {
    repo.touchLab(id)
    return { lab: repo.getLab(id), content: repo.readContent(id), state: repo.readState(id) }
  },
  getContent: async (id) => ({ lab: repo.getLab(id), content: repo.readContent(id) }),
  loadState: async (id) => repo.readState(id),

  /* import / export */
  pickFiles: async (kind) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: kind === "dir" ? ["openDirectory"] : kind === "md" ? ["openFile", "multiSelections"] : ["openFile"],
      filters: kind === "md" ? [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }] : kind === "json" ? [{ name: "JSON", extensions: ["json"] }] : undefined,
    })
    return r.canceled ? [] : r.filePaths
  },
  importUdemy: async (labId, paths) => importers.importUdemy(labId, paths),
  importBundle: async (labId, dir) => importers.importBundle(labId, dir),
  importProgress: async (labId, path) => importers.importProgress(labId, path),
  exportLab: async (labId) => {
    const lab = repo.getLab(labId)
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `${lab.name.replace(/[^\w\- ]+/g, "").trim() || "lab"}.studylab.json`,
      filters: [{ name: "Study Lab export", extensions: ["json"] }],
    })
    if (r.canceled || !r.filePath) return null
    await importers.exportLab(labId, r.filePath)
    return r.filePath
  },
  importLabFile: async (path) => importers.importLabFile(path),

  /* progress */
  saveState: async (labId, section, patch) => repo.saveState(labId, section, patch),
  addEvents: async (labId, events) => repo.addEvents(labId, events),
  resetProgress: async (labId) => repo.resetProgress(labId),

  /* content */
  setItemStatus: async (labId, kind, ids, status) => repo.setItemStatus(labId, kind, ids, status),
  deleteItems: async (labId, kind, ids) => {
    for (const id of ids) {
      if (kind === "q") repo.deleteQuestion(labId, id)
      else repo.deleteCard(labId, id)
    }
  },

  /* library */
  getLectures: async (labId) => repo.getLectures(labId),
  searchLectures: async (labId, q, limit) => repo.searchLectures(labId, q, limit),

  /* analytics */
  snapshot: async (labId) => repo.snapshot(labId),

  /* AI settings */
  aiSettings: async () => aiSettings(),
  setAiKey: async (key) => {
    saveKey(key)
    return aiSettings()
  },
  updateAiSettings: async (patch) => {
    if (patch.model) setSetting("ai.model", patch.model.trim())
    if (patch.language) setSetting("ai.language", patch.language)
    if (patch.mcp) {
      saveMcpConfig(patch.mcp)
      await applyMcp()
    }
    return aiSettings()
  },
  listModels: async (force) => listModels(force),
  testAi: async () => {
    try {
      const r = await chat({ messages: [{ role: "user", content: "Reply with the single word: ready" }], task: "test", maxTokens: 20 })
      return { ok: true, message: `${r.model} answered “${(r.message.content ?? "").trim().slice(0, 40)}”.` }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  },
  usage: async () => repo.usageSummary(),

  /* coach */
  runJob: async (labId, kind, opts = {}) => {
    if (isBusy(labId, kind)) throw new Error("That task is already running for this lab.")
    const titles = { analyze: "Analysing your learning", plan: "Building your study plan", generate: "Creating study material", "build-kb": "Building the knowledge base" }
    return startJob(labId, kind, titles[kind], (job) => {
      if (kind === "analyze") return runAnalyze(labId, job)
      if (kind === "plan") return runPlan(labId, job, opts)
      if (kind === "generate") return runGenerate(labId, job, opts)
      return runBuildKb(labId, job, opts)
    })
  },
  cancelJob: async (id) => cancelJob(id),
  jobs: async (labId) => listJobs(labId),
  insights: async (labId) => repo.listInsights(labId),
  deleteInsight: async (labId, id) => repo.deleteInsight(labId, id),
  plans: async (labId) => repo.listPlans(labId),
  setTaskDone: async (labId, planId, taskId, done) => {
    const p = repo.getPlan(labId, planId)
    if (!p) throw new Error("That plan is gone.")
    for (const d of p.days) for (const t of d.tasks) if (t.id === taskId) t.done = done ? Date.now() : undefined
    repo.savePlan(labId, p)
    return p
  },
  setPlanStatus: async (labId, planId, status) => {
    const p = repo.getPlan(labId, planId)
    if (!p) return
    if (status === "active") for (const other of repo.listPlans(labId)) if (other.status === "active") repo.savePlan(labId, { ...other, status: "archived" })
    repo.savePlan(labId, { ...p, status })
  },
  threads: async (labId) => repo.listThreads(labId),
  messages: async (_labId, threadId) => repo.listMessages(threadId),
  sendChat: async (labId, threadId, text) => {
    const t = threadId ?? repo.createThread(labId, chatTitle(text)).id
    const jobId = startJob(labId, "chat", "Coach is thinking", (job) => runChat(labId, t, text, job))
    return { threadId: t, jobId }
  },
  deleteThread: async (labId, threadId) => repo.deleteThread(labId, threadId),
  changes: async (labId) => repo.listChanges(labId),
  undoChange: async (labId, id) => {
    const r = undo(labId, id)
    if (r.ok) emit({ type: "lab-changed", labId, what: r.touched as ("content" | "config" | "plans" | "state")[] })
    return { ok: r.ok, error: r.error }
  },

  /* app */
  openExternal: async (url) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url)
  },
  appInfo: async () => ({ version: app.getVersion(), dataDir: app.getPath("userData"), dbPath }),
}

function registerIpc() {
  ipcMain.handle("api", async (_e, method: string, ...args: unknown[]) => {
    if (!(API_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown API method ${method}`)
    const fn = api[method as keyof Api] as (...a: unknown[]) => Promise<unknown>
    return fn(...args)
  })
  setBroadcaster((e: MainEvent) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("event", e)
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Study Lab",
    backgroundColor: "#f3f5f7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once("ready-to-show", () => win?.show())
  // Links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "file://")) e.preventDefault()
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, "../renderer/index.html"))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(async () => {
    dbPath = process.env.STUDY_LAB_DB ?? join(app.getPath("userData"), "study-lab.db")
    openDb(dbPath)
    registerIpc()
    await applyMcp().catch(() => undefined)
    createWindow()
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
