import type { LearnerSnapshot } from "./analytics"
import type { PackageSummary } from "./content-package"
import type { LabPreset } from "./defaults"
import type {
  AiSettings,
  AppState,
  ChangeEntry,
  ChatMessage,
  ChatThread,
  ImportResult,
  InsightReport,
  ItemStatus,
  JobInfo,
  JobKind,
  LabConfig,
  LabContent,
  LabInfo,
  LabKind,
  Lecture,
  McpConnection,
  SkillInfo,
  ModelInfo,
  Section,
  StudyEvent,
  StudyPlan,
} from "./types"

/** The learner model as the renderer needs it (maps flattened to arrays). */
export interface LearnerView {
  kcs: import("./learner").KcState[]
  predicted: import("./learner").LearnerModel["predicted"]
  calibration: import("./learner").LearnerModel["calibration"]
  errors: import("./learner").LearnerModel["errors"]
  rapidRate: number | null
  topicLevel: boolean
  priorities: import("./planner").KcPriority[]
}

export interface LectureHit {
  n: number
  title: string
  sec: string
  snippet: string
}

export interface AdapterInfo {
  id: string
  name: string
  description: string
  pick: "files" | "directory"
  extensions: string[]
}

export interface ImportPreview {
  token: string
  adapter: { id: string; name: string } | null
  packages: PackageSummary[]
  warnings: string[]
}

export interface SourceInfo {
  id: string
  adapter: string
  provider: string
  title: string
  importedAt: number
  stats: { documents: number; items: number }
}

export interface OpenedLab {
  lab: LabInfo
  content: LabContent
  state: AppState
}

/** srsq / srsc / notes send only changed keys; meta is sent whole. */
export type StatePatch = { set?: Record<string, unknown>; del?: string[]; whole?: unknown }

export interface GenerateOptions {
  topics?: string[]
  cards?: number
  questions?: number
  guide?: boolean
  instructions?: string
}

export interface PlanOptions {
  days?: number
  minutesPerDay?: number
  instructions?: string
}

export interface BuildKbOptions {
  /** keep existing topics and only fill gaps */
  keep?: boolean
  cardsPerTopic?: number
  instructions?: string
}

export type JobOptions = GenerateOptions & PlanOptions & BuildKbOptions

/** Everything the renderer can ask the main process. Each method maps to one IPC call. */
export interface Api {
  /* labs */
  listLabs(): Promise<LabInfo[]>
  presets(): Promise<LabPreset[]>
  createLab(input: { name: string; kind?: LabKind; description?: string; preset?: string }): Promise<LabInfo>
  updateLab(id: string, patch: { name?: string; kind?: LabKind; description?: string; config?: Partial<LabConfig> }): Promise<LabInfo>
  deleteLab(id: string): Promise<void>
  openLab(id: string): Promise<OpenedLab>
  getContent(labId: string): Promise<{ lab: LabInfo; content: LabContent }>
  loadState(labId: string): Promise<AppState>

  /* import / export */
  pickFiles(kind: "files" | "dir" | "json", extensions?: string[]): Promise<string[]>
  contentAdapters(): Promise<AdapterInfo[]>
  /** detect the format (or use adapterId), parse, and hold the result until importPreview */
  previewImport(paths: string[], adapterId?: string): Promise<ImportPreview>
  importPreview(labId: string, token: string): Promise<ImportResult>
  sources(labId: string): Promise<SourceInfo[]>
  importProgress(labId: string, path: string): Promise<{ ok: boolean; error?: string }>
  exportLab(labId: string): Promise<string | null>
  importLabFile(path: string): Promise<LabInfo>

  /* progress */
  saveState(labId: string, section: Section, patch: StatePatch): Promise<void>
  addEvents(labId: string, events: StudyEvent[]): Promise<void>
  resetProgress(labId: string): Promise<void>

  /* content you manage yourself */
  setItemStatus(labId: string, kind: "q" | "c", ids: string[], status: ItemStatus): Promise<void>
  deleteItems(labId: string, kind: "q" | "c", ids: string[]): Promise<void>

  /* library */
  getLectures(labId: string): Promise<Lecture[]>
  searchLectures(labId: string, query: string, limit?: number): Promise<LectureHit[]>

  /* analytics */
  snapshot(labId: string): Promise<LearnerSnapshot>

  /* AI settings */
  aiSettings(): Promise<AiSettings>
  setAiKey(key: string | null): Promise<AiSettings>
  /** OAuth PKCE: opens the browser, waits for consent, stores the new key */
  connectOpenRouter(): Promise<AiSettings>
  cancelConnect(): Promise<void>
  updateAiSettings(patch: { model?: string; language?: string; mcp?: { enabled?: boolean; port?: number; rotateToken?: boolean } }): Promise<AiSettings>
  listModels(force?: boolean): Promise<ModelInfo[]>
  /* coach harness: skills and external MCP servers */
  skills(): Promise<SkillInfo[]>
  saveSkill(input: { name: string; description: string; body: string }): Promise<SkillInfo>
  deleteSkill(name: string): Promise<void>
  mcpConnections(): Promise<McpConnection[]>
  saveMcpConnection(c: Omit<McpConnection, "id"> & { id?: string }): Promise<McpConnection>
  deleteMcpConnection(id: string): Promise<void>
  testMcpConnection(id: string): Promise<{ ok: boolean; tools: string[]; error?: string }>
  testAi(): Promise<{ ok: boolean; message: string }>
  usage(): Promise<{ today: number; month: number; total: number; calls: number }>

  /* coach */
  runJob(labId: string, kind: Exclude<JobKind, "chat">, opts?: JobOptions): Promise<string>
  cancelJob(jobId: string): Promise<void>
  jobs(labId: string): Promise<JobInfo[]>
  insights(labId: string): Promise<InsightReport[]>
  deleteInsight(labId: string, id: string): Promise<void>
  plans(labId: string): Promise<StudyPlan[]>
  /** a plan straight from the deterministic planner, no LLM */
  autoPlan(labId: string, days?: number, minutesPerDay?: number): Promise<StudyPlan>
  learner(labId: string): Promise<LearnerView>
  setTaskDone(labId: string, planId: string, taskId: string, done: boolean): Promise<StudyPlan>
  setPlanStatus(labId: string, planId: string, status: StudyPlan["status"]): Promise<void>
  threads(labId: string): Promise<ChatThread[]>
  messages(labId: string, threadId: string): Promise<ChatMessage[]>
  sendChat(labId: string, threadId: string | null, text: string): Promise<{ threadId: string; jobId: string }>
  deleteThread(labId: string, threadId: string): Promise<void>
  changes(labId: string): Promise<ChangeEntry[]>
  undoChange(labId: string, id: number): Promise<{ ok: boolean; error?: string }>

  /* app */
  openExternal(url: string): Promise<void>
  appInfo(): Promise<{ version: string; dataDir: string; dbPath: string }>
}

export const API_METHODS = [
  "listLabs",
  "presets",
  "createLab",
  "updateLab",
  "deleteLab",
  "openLab",
  "getContent",
  "loadState",
  "pickFiles",
  "contentAdapters",
  "previewImport",
  "importPreview",
  "sources",
  "importProgress",
  "exportLab",
  "importLabFile",
  "saveState",
  "addEvents",
  "resetProgress",
  "setItemStatus",
  "deleteItems",
  "getLectures",
  "searchLectures",
  "snapshot",
  "aiSettings",
  "setAiKey",
  "connectOpenRouter",
  "cancelConnect",
  "updateAiSettings",
  "listModels",
  "skills",
  "saveSkill",
  "deleteSkill",
  "mcpConnections",
  "saveMcpConnection",
  "deleteMcpConnection",
  "testMcpConnection",
  "testAi",
  "usage",
  "runJob",
  "cancelJob",
  "jobs",
  "insights",
  "deleteInsight",
  "plans",
  "autoPlan",
  "learner",
  "setTaskDone",
  "setPlanStatus",
  "threads",
  "messages",
  "sendChat",
  "deleteThread",
  "changes",
  "undoChange",
  "openExternal",
  "appInfo",
] as const satisfies readonly (keyof Api)[]

/** Pushed from main to every window. */
export type MainEvent =
  | { type: "job"; job: JobInfo }
  | { type: "chat"; labId: string; threadId: string; message: ChatMessage }
  | { type: "lab-changed"; labId: string; what: ("content" | "config" | "plans" | "insights" | "state")[] }

export interface Bridge {
  api: Api
  onEvent(fn: (e: MainEvent) => void): () => void
}
