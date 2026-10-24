/* ---------- content ---------- */

/** Domain number. 0 is reserved for "exam strategy"-style topics that carry no exam weight. */
export type DomainId = number

/** Where an item came from. Built-in values: "course" (imported), "lab" (bundled lab questions), "agent" (written by the coach). */
export type SourceId = string

/** active: in rotation · suspended: paused by you or the coach · archived: retired as learned */
export type ItemStatus = "active" | "suspended" | "archived"

export interface Question {
  id: string
  src: SourceId
  src_name: string
  set: string
  kind: "exam" | "quiz"
  n: number
  d: DomainId
  stem: string
  opts: string[]
  ans: number[]
  why: string[]
  explanation: string
  multi: boolean
  status?: ItemStatus
  /** epoch ms when created in this app */
  created?: number
}

export type CardKind = "fact" | "concept" | "compare" | "scenario" | "list" | "trigger"

export interface Card {
  id: string
  t: string
  f: string
  b: string
  k: CardKind
  /** trigger only: why the answer fits the cue */
  x?: string
  /** origin: L = lectures, Q = practice-exam explanations, A = the AI coach */
  s: "L" | "Q" | "A"
  status?: ItemStatus
  created?: number
}

export interface NoteSet {
  keyPoints: string[]
  examTips: string[]
  pitfalls: string[]
}

export interface NoteTable {
  title: string
  head: string[]
  rows: string[][]
}

/** A study guide the coach wrote for a topic, in Markdown. */
export interface Guide {
  id: string
  title: string
  md: string
  at: number
  model?: string
}

export interface Topic {
  id: string
  d: number
  title: string
  covers: string
  summary: string[]
  lec: NoteSet
  exam: NoteSet
  mnemonics: string[]
  tables: NoteTable[]
  lectures: number[]
  guides?: Guide[]
  /** topics you must know first */
  prereq?: string[]
  /** topics that are easy to mix up with this one */
  confusable?: string[]
}

export interface KB {
  topics: Topic[]
  cards: Card[]
  tags: Record<string, string[]>
  conflicts: string[]
  builtAt: string
}

export interface Lecture {
  n: number
  title: string
  sec: string
  p: string[]
}

/* ---------- labs ---------- */

export interface Domain {
  n: number
  name: string
  short: string
  /** exam weight in percent */
  w: number
}

export interface ExamConfig {
  code: string
  questions: number
  scored: number
  minutes: number
  /** pass mark on the reported scale */
  pass: number
  /** reported scale, e.g. 100–1000 */
  min: number
  max: number
  /** optional accommodation (e.g. ESL +30 minutes) */
  extraMinutes?: number
  extraLabel?: string
}

export type LabKind = "certification" | "language" | "course" | "other"

export interface Collection {
  id: string
  name: string
  why?: string
  items: { kind: "q" | "c"; id: string }[]
  at: number
}

export interface LabConfig {
  domains: Domain[]
  exam: ExamConfig | null
  /** label per question source id */
  sources: Record<string, string>
  /** what the coach should remember about this lab and the learner (you and the coach both write it) */
  memory: string
  /** topics pinned to the top of Today */
  focus: string[]
  /** custom practice sets */
  collections: Collection[]
}

export interface LabInfo {
  id: string
  name: string
  kind: LabKind
  description: string
  config: LabConfig
  createdAt: number
  openedAt: number
  counts: { questions: number; cards: number; topics: number; lectures: number }
  progress: { seen: number; attempts: number; accuracy: number | null; examDate: string | null; lastStudied: number | null }
}

export interface LabContent {
  questions: Question[]
  kb: KB
}

/* ---------- progress ---------- */

/** Spaced-repetition record. Times are minutes since the Unix epoch. */
export interface SrsRec {
  /** due */
  d: number
  /** interval in days */
  i: number
  /** ease ×100 */
  e: number
  /** successful reps in a row */
  r: number
  /** lapses */
  l: number
  /** times seen */
  s: number
  /** last grade 1–4 */
  g?: number
  /** last review */
  t: number
}

export interface QRec extends SrsRec {
  /** correct attempts */
  c: number
  /** wrong attempts */
  w: number
  /** first attempt correct (1) or wrong (0) */
  f: 0 | 1
  /** confidently-wrong count */
  h: number
  /** latest attempt correct */
  la: 0 | 1
  /** latest confidence 0 guess, 1 unsure, 2 sure */
  cf: number
  /** latest picked options (original indexes) */
  lp?: number[]
}

export type Confidence = 0 | 1 | 2

export interface Settings {
  examDate: string | null
  newCards: number
  newQs: number
  sessionMax: number
  shuffle: boolean
  highlight: boolean
  confidence: boolean
  typeAnswer: boolean
  esl: boolean
  theme: "system" | "light" | "dark"
}

export interface DayLog {
  /** new items */
  n: number
  /** reviews of seen items */
  r: number
  ok: number
  bad: number
  /** active seconds */
  sec: number
}

export interface Mistake {
  at: number
  cat?: string
  note?: string
}

export interface ExamResult {
  at: number
  mode: string
  label: string
  ids: string[]
  picks: number[][]
  flags: string[]
  correct: number
  total: number
  score: number
  sec: number
  limitMin: number
  perD: Record<string, [number, number]>
  /** ms spent on each question, same order as ids */
  ms?: number[]
}

export interface ActiveExam {
  mode: string
  label: string
  ids: string[]
  order: Record<string, number[]>
  picks: Record<string, number[]>
  flags: string[]
  cur: number
  /** ms of exam time used before the current running stretch */
  used: number
  /** epoch ms when the current running stretch started, or 0 when paused */
  since: number
  limitMin: number
  u: number
  /** ms spent on each question so far */
  qms?: Record<string, number>
  /** epoch ms when the current question was opened (0 while paused) */
  qSince?: number
  /** how many times the pick changed, per question */
  changes?: Record<string, number>
  /** first pick per question */
  first?: Record<string, number[]>
}

export interface Meta {
  settings: Settings
  log: Record<string, DayLog>
  exams: ExamResult[]
  active: ActiveExam | null
  mistakes: Record<string, Mistake>
  flags: Record<string, { on: boolean; at: number }>
  au: number
}

export interface NoteEntry {
  t: string
  at: number
}

export interface AppState {
  srsq: Record<string, QRec>
  srsc: Record<string, SrsRec>
  meta: Meta
  notes: Record<string, NoteEntry>
}

export type Section = keyof AppState

/**
 * One attempt, kept in an append-only log. The aggregates in AppState answer "what is due";
 * the log answers "how am I learning" (time, repeated picks, answer changes, calibration).
 */
export interface StudyEvent {
  at: number
  kind: "q" | "c"
  item: string
  /** where it happened: review, practice, drill, cards, exam, mistakes… */
  mode: string
  correct: 0 | 1
  /** SRS grade 1–4 */
  grade: number
  conf?: Confidence
  picks?: number[]
  ms: number
  /** times the selection changed before submitting */
  changes?: number
  /** first selection, before any change */
  first?: number[]
}

/* ---------- AI coach ---------- */

export interface ModelInfo {
  id: string
  name: string
  context: number
  /** USD per million tokens */
  inPrice: number
  outPrice: number
  tools: boolean
  structured: boolean
}

export interface AiSettings {
  hasKey: boolean
  keyHint: string
  model: string
  language: string
  mcp: { enabled: boolean; port: number; token: string; running: boolean; error?: string }
}

export interface Usage {
  model: string
  tokensIn: number
  tokensOut: number
  cost: number
}

export interface InsightItem {
  title: string
  detail: string
  severity: "high" | "medium" | "low" | "positive"
  kind: "time" | "repeat" | "confusion" | "calibration" | "forgetting" | "coverage" | "habit" | "other"
  topics: string[]
  evidence: string[]
}

export interface Misconception {
  topic: string
  belief: string
  correction: string
  questions: string[]
}

export interface InsightReport {
  id: string
  at: number
  model: string
  headline: string
  summary: string
  strengths: string[]
  insights: InsightItem[]
  misconceptions: Misconception[]
  next: string[]
}

export type PlanTaskType = "review" | "practice" | "cards" | "cues" | "notes" | "guide" | "exam" | "collection" | "mistakes" | "custom"

export interface PlanTask {
  id: string
  type: PlanTaskType
  title: string
  topics: string[]
  count?: number
  minutes: number
  why: string
  /** collection id for "collection", guide id for "guide" */
  ref?: string
  /** epoch ms when ticked off */
  done?: number
}

export interface PlanDay {
  day: number
  date: string
  focus: string
  tasks: PlanTask[]
}

export interface StudyPlan {
  id: string
  at: number
  model: string
  title: string
  goal: string
  rationale: string
  start: string
  days: PlanDay[]
  status: "active" | "archived"
}

export interface ChatToolCall {
  name: string
  args: string
  ok?: boolean
  summary?: string
}

export interface ChatMessage {
  id: number
  role: "user" | "assistant"
  content: string
  tools?: ChatToolCall[]
  at: number
}

export interface ChatThread {
  id: string
  title: string
  at: number
}

/** One change the coach (or an MCP client) made to a lab. Undo restores the snapshot taken before it. */
export interface ChangeEntry {
  id: number
  at: number
  actor: string
  tool: string
  summary: string
  undone: boolean
}

export type JobKind = "analyze" | "plan" | "generate" | "build-kb" | "chat"

export interface JobInfo {
  id: string
  labId: string
  kind: JobKind
  title: string
  status: "running" | "done" | "error" | "cancelled"
  step: string
  /** 0–1 */
  progress: number
  error?: string
  usage?: Usage
  startedAt: number
}

export interface ImportResult {
  questions: number
  lectures: number
  topics: number
  cards: number
  sets: string[]
  warnings: string[]
}
