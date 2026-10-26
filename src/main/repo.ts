import { randomUUID } from "node:crypto"
import { analyze, type LearnerSnapshot } from "@shared/analytics"
import { defaultMeta, defaultState, DEFAULT_SETTINGS, emptyConfig, presetConfig } from "@shared/defaults"
import type { StatePatch } from "@shared/api"
import type {
  AppState,
  Card,
  ChangeEntry,
  ChatMessage,
  ChatThread,
  InsightReport,
  ItemStatus,
  LabConfig,
  LabContent,
  LabInfo,
  LabKind,
  Lecture,
  Meta,
  NoteEntry,
  QRec,
  Question,
  Section,
  SrsRec,
  StudyEvent,
  StudyPlan,
  Topic,
} from "@shared/types"
import { all, one, run, tx } from "./db"
import { readGraph } from "./graph"

export const newId = (prefix = "") => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/* ---------- labs ---------- */

interface LabRow {
  id: string
  name: string
  kind: LabKind
  description: string
  config: string
  created_at: number
  opened_at: number
  built_at: string
  conflicts: string
}

function normalizeConfig(c: Partial<LabConfig> | undefined): LabConfig {
  const base = emptyConfig()
  const out = { ...base, ...(c ?? {}) } as LabConfig
  if (!Array.isArray(out.domains) || !out.domains.length) out.domains = base.domains
  out.sources = { ...base.sources, ...(c?.sources ?? {}) }
  out.focus = Array.isArray(out.focus) ? out.focus : []
  out.collections = Array.isArray(out.collections) ? out.collections : []
  out.memory = typeof out.memory === "string" ? out.memory : ""
  return out
}

function toInfo(r: LabRow): LabInfo {
  const count = (table: string, extra = "") => one<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE lab_id = ? ${extra}`, r.id)!.n
  const stats = one<{ n: number; ok: number | null; last: number | null }>(
    "SELECT COUNT(*) n, AVG(correct) ok, MAX(at) last FROM (SELECT correct, at FROM events WHERE lab_id = ? ORDER BY at DESC LIMIT 200)",
    r.id,
  )!
  const attempts = count("events")
  const meta = readMeta(r.id)
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    description: r.description,
    config: normalizeConfig(json(r.config, {})),
    createdAt: r.created_at,
    openedAt: r.opened_at,
    counts: {
      questions: count("questions", "AND status = 'active'"),
      cards: count("cards", "AND status = 'active'"),
      topics: count("topics"),
      lectures: count("lectures"),
    },
    progress: {
      seen: count("srs", "AND kind = 'q'"),
      attempts,
      accuracy: stats.n ? stats.ok : null,
      examDate: meta.settings.examDate,
      lastStudied: stats.last,
    },
  }
}

function labRow(id: string): LabRow {
  const r = one<LabRow>("SELECT * FROM labs WHERE id = ?", id)
  if (!r) throw new Error("This lab no longer exists.")
  return r
}

export function listLabs(): LabInfo[] {
  return all<LabRow>("SELECT * FROM labs ORDER BY opened_at DESC, created_at DESC").map(toInfo)
}

export function getLab(id: string): LabInfo {
  return toInfo(labRow(id))
}

export function getConfig(id: string): LabConfig {
  return normalizeConfig(json(labRow(id).config, {}))
}

export function createLab(input: { name: string; kind?: LabKind; description?: string; preset?: string }): LabInfo {
  const id = newId("lab_")
  const p = presetConfig(input.preset)
  const now = Date.now()
  tx(() => {
    run(
      "INSERT INTO labs(id, name, kind, description, config, created_at, opened_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      id,
      input.name.trim() || "Untitled lab",
      input.kind ?? p.kind,
      input.description ?? "",
      JSON.stringify(p.config),
      now,
      now,
    )
    run("INSERT INTO lab_meta(lab_id, meta) VALUES(?, ?)", id, JSON.stringify(defaultMeta()))
  })
  return getLab(id)
}

export function updateLab(id: string, patch: { name?: string; kind?: LabKind; description?: string; config?: Partial<LabConfig> }): LabInfo {
  const r = labRow(id)
  const config = patch.config ? normalizeConfig({ ...json<Partial<LabConfig>>(r.config, {}), ...patch.config }) : json(r.config, {})
  run(
    "UPDATE labs SET name = ?, kind = ?, description = ?, config = ? WHERE id = ?",
    patch.name?.trim() || r.name,
    patch.kind ?? r.kind,
    patch.description ?? r.description,
    JSON.stringify(config),
    id,
  )
  return getLab(id)
}

export function deleteLab(id: string) {
  tx(() => {
    run("DELETE FROM lectures_fts WHERE lab_id = ?", id)
    run("DELETE FROM labs WHERE id = ?", id)
  })
}

export function touchLab(id: string) {
  run("UPDATE labs SET opened_at = ? WHERE id = ?", Date.now(), id)
}

/* ---------- content ---------- */

interface QRow {
  id: string
  src: string
  src_name: string
  set_name: string
  kind: "exam" | "quiz"
  n: number
  d: number
  stem: string
  opts: string
  ans: string
  why: string
  explanation: string
  status: ItemStatus
  created: number
}

function toQuestion(r: QRow): Question {
  const ans = json<number[]>(r.ans, [])
  return {
    id: r.id,
    src: r.src,
    src_name: r.src_name,
    set: r.set_name,
    kind: r.kind,
    n: r.n,
    d: r.d,
    stem: r.stem,
    opts: json(r.opts, []),
    ans,
    why: json(r.why, []),
    explanation: r.explanation,
    multi: ans.length > 1,
    status: r.status,
    created: r.created || undefined,
  }
}

interface CRow {
  id: string
  topic_id: string
  kind: Card["k"]
  front: string
  back: string
  x: string | null
  src: Card["s"]
  status: ItemStatus
  created: number
}

function toCard(r: CRow): Card {
  const c: Card = { id: r.id, t: r.topic_id, f: r.front, b: r.back, k: r.kind, s: r.src, status: r.status }
  if (r.x) c.x = r.x
  if (r.created) c.created = r.created
  return c
}

function toTopic(r: { id: string; d: number; title: string; data: string }): Topic {
  const t = json<Partial<Topic>>(r.data, {})
  const notes = { keyPoints: [], examTips: [], pitfalls: [] }
  return {
    covers: "",
    summary: [],
    mnemonics: [],
    tables: [],
    lectures: [],
    ...t,
    lec: { ...notes, ...(t.lec ?? {}) },
    exam: { ...notes, ...(t.exam ?? {}) },
    id: r.id,
    d: r.d,
    title: r.title,
  }
}

export function getTags(labId: string): Record<string, string[]> {
  const tags: Record<string, string[]> = {}
  for (const r of all<{ qid: string; topic_id: string }>("SELECT qid, topic_id FROM question_topics WHERE lab_id = ? ORDER BY qid, ord", labId)) {
    ;(tags[r.qid] ??= []).push(r.topic_id)
  }
  return tags
}

export function readContent(labId: string): LabContent {
  const r = labRow(labId)
  const questions = all<QRow>("SELECT * FROM questions WHERE lab_id = ? ORDER BY ord, rowid", labId).map(toQuestion)
  const topics = all<{ id: string; d: number; title: string; data: string }>("SELECT id, d, title, data FROM topics WHERE lab_id = ? ORDER BY ord, rowid", labId).map(toTopic)
  const cards = all<CRow>("SELECT * FROM cards WHERE lab_id = ? ORDER BY ord, rowid", labId).map(toCard)
  const kb = { topics, cards, tags: getTags(labId), conflicts: json(r.conflicts, []), builtAt: r.built_at }
  return { questions, kb, graph: readGraph(labId) }
}

export function readTopics(labId: string): Topic[] {
  return all<{ id: string; d: number; title: string; data: string }>("SELECT id, d, title, data FROM topics WHERE lab_id = ? ORDER BY ord, rowid", labId).map(toTopic)
}

export function getQuestion(labId: string, id: string): Question | null {
  const r = one<QRow>("SELECT * FROM questions WHERE lab_id = ? AND id = ?", labId, id)
  return r ? toQuestion(r) : null
}

export function getCard(labId: string, id: string): Card | null {
  const r = one<CRow>("SELECT * FROM cards WHERE lab_id = ? AND id = ?", labId, id)
  return r ? toCard(r) : null
}

export function getTopic(labId: string, id: string): Topic | null {
  const r = one<{ id: string; d: number; title: string; data: string }>("SELECT id, d, title, data FROM topics WHERE lab_id = ? AND id = ?", labId, id)
  return r ? toTopic(r) : null
}

const nextOrd = (table: string, labId: string) => (one<{ m: number | null }>(`SELECT MAX(ord) m FROM ${table} WHERE lab_id = ?`, labId)?.m ?? 0) + 1

export function upsertQuestion(labId: string, q: Question, ord?: number) {
  const existing = one<{ ord: number; created: number }>("SELECT ord, created FROM questions WHERE lab_id = ? AND id = ?", labId, q.id)
  run(
    `INSERT INTO questions(lab_id, id, ord, src, src_name, set_name, kind, n, d, stem, opts, ans, why, explanation, status, created)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lab_id, id) DO UPDATE SET src = excluded.src, src_name = excluded.src_name, set_name = excluded.set_name, kind = excluded.kind,
       n = excluded.n, d = excluded.d, stem = excluded.stem, opts = excluded.opts, ans = excluded.ans, why = excluded.why,
       explanation = excluded.explanation, status = excluded.status`,
    labId,
    q.id,
    ord ?? existing?.ord ?? nextOrd("questions", labId),
    q.src,
    q.src_name ?? "",
    q.set ?? "",
    q.kind ?? "quiz",
    q.n ?? 0,
    q.d ?? 1,
    q.stem,
    JSON.stringify(q.opts),
    JSON.stringify(q.ans),
    JSON.stringify(q.why ?? []),
    q.explanation ?? "",
    q.status ?? "active",
    existing?.created ?? q.created ?? Date.now(),
  )
}

export function setTags(labId: string, qid: string, topics: string[]) {
  run("DELETE FROM question_topics WHERE lab_id = ? AND qid = ?", labId, qid)
  topics.forEach((t, i) => run("INSERT OR IGNORE INTO question_topics(lab_id, qid, topic_id, ord) VALUES(?, ?, ?, ?)", labId, qid, t, i))
}

export function upsertCard(labId: string, c: Card, ord?: number) {
  const existing = one<{ ord: number; created: number }>("SELECT ord, created FROM cards WHERE lab_id = ? AND id = ?", labId, c.id)
  run(
    `INSERT INTO cards(lab_id, id, ord, topic_id, kind, front, back, x, src, status, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lab_id, id) DO UPDATE SET topic_id = excluded.topic_id, kind = excluded.kind, front = excluded.front, back = excluded.back,
       x = excluded.x, src = excluded.src, status = excluded.status`,
    labId,
    c.id,
    ord ?? existing?.ord ?? nextOrd("cards", labId),
    c.t,
    c.k,
    c.f,
    c.b,
    c.x ?? null,
    c.s ?? "A",
    c.status ?? "active",
    existing?.created ?? c.created ?? Date.now(),
  )
}

export function upsertTopic(labId: string, t: Topic, ord?: number) {
  const existing = one<{ ord: number }>("SELECT ord FROM topics WHERE lab_id = ? AND id = ?", labId, t.id)
  const { id, d, title, ...rest } = t
  run(
    `INSERT INTO topics(lab_id, id, ord, d, title, data) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(lab_id, id) DO UPDATE SET d = excluded.d, title = excluded.title, data = excluded.data, ord = excluded.ord`,
    labId,
    id,
    ord ?? existing?.ord ?? nextOrd("topics", labId),
    d,
    title,
    JSON.stringify(rest),
  )
}

export function deleteQuestion(labId: string, id: string) {
  run("DELETE FROM questions WHERE lab_id = ? AND id = ?", labId, id)
  run("DELETE FROM question_topics WHERE lab_id = ? AND qid = ?", labId, id)
}

export function deleteCard(labId: string, id: string) {
  run("DELETE FROM cards WHERE lab_id = ? AND id = ?", labId, id)
}

export function deleteTopic(labId: string, id: string) {
  run("DELETE FROM topics WHERE lab_id = ? AND id = ?", labId, id)
  run("DELETE FROM question_topics WHERE lab_id = ? AND topic_id = ?", labId, id)
}

export function setItemStatus(labId: string, kind: "q" | "c", ids: string[], status: ItemStatus) {
  const table = kind === "q" ? "questions" : "cards"
  tx(() => {
    for (const id of ids) run(`UPDATE ${table} SET status = ? WHERE lab_id = ? AND id = ?`, status, labId, id)
  })
}

export function setBuilt(labId: string, conflicts?: string[]) {
  run("UPDATE labs SET built_at = ?, conflicts = COALESCE(?, conflicts) WHERE id = ?", new Date().toISOString(), conflicts ? JSON.stringify(conflicts) : null, labId)
}

/* ---------- lectures ---------- */

export function replaceLectures(labId: string, lectures: Lecture[]) {
  tx(() => {
    run("DELETE FROM lectures WHERE lab_id = ?", labId)
    run("DELETE FROM lectures_fts WHERE lab_id = ?", labId)
    for (const l of lectures) {
      const body = l.p.join("\n\n")
      run("INSERT INTO lectures(lab_id, n, title, sec, body) VALUES(?, ?, ?, ?, ?)", labId, l.n, l.title, l.sec, body)
      run("INSERT INTO lectures_fts(lab_id, n, title, body) VALUES(?, ?, ?, ?)", labId, l.n, l.title, body)
    }
  })
}

export function getLectures(labId: string): Lecture[] {
  return all<{ n: number; title: string; sec: string; body: string }>("SELECT n, title, sec, body FROM lectures WHERE lab_id = ? ORDER BY n", labId).map((r) => ({
    n: r.n,
    title: r.title,
    sec: r.sec,
    p: r.body.split(/\n{2,}/).filter(Boolean),
  }))
}

export function getLecture(labId: string, n: number): Lecture | null {
  const r = one<{ n: number; title: string; sec: string; body: string }>("SELECT n, title, sec, body FROM lectures WHERE lab_id = ? AND n = ?", labId, n)
  return r ? { n: r.n, title: r.title, sec: r.sec, p: r.body.split(/\n{2,}/).filter(Boolean) } : null
}

/** Full-text search. Terms are quoted so user text cannot break the FTS query syntax. */
export function searchLectures(labId: string, query: string, limit = 8) {
  const terms = (query.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).slice(0, 12)
  if (!terms.length) return []
  const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ")
  return all<{ n: number; title: string; sec: string; snippet: string }>(
    `SELECT f.n n, l.title title, l.sec sec, snippet(lectures_fts, 3, '«', '»', ' … ', 40) snippet
     FROM lectures_fts f JOIN lectures l ON l.lab_id = f.lab_id AND l.n = f.n
     WHERE lectures_fts MATCH ? AND f.lab_id = ? ORDER BY bm25(lectures_fts) LIMIT ?`,
    match,
    labId,
    limit,
  )
}

/* ---------- progress ---------- */

export function readMeta(labId: string): Meta {
  const raw = json<Partial<Meta>>(one<{ meta: string }>("SELECT meta FROM lab_meta WHERE lab_id = ?", labId)?.meta, {})
  const base = defaultMeta()
  return {
    ...base,
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    log: raw.log ?? {},
    exams: Array.isArray(raw.exams) ? raw.exams : [],
    mistakes: raw.mistakes ?? {},
    flags: raw.flags ?? {},
    active: raw.active ?? null,
    au: raw.au ?? 0,
  }
}

export function writeMeta(labId: string, meta: Meta) {
  run("INSERT INTO lab_meta(lab_id, meta) VALUES(?, ?) ON CONFLICT(lab_id) DO UPDATE SET meta = excluded.meta", labId, JSON.stringify(meta))
}

export function readState(labId: string): AppState {
  const st = defaultState()
  for (const r of all<{ kind: string; item_id: string; rec: string }>("SELECT kind, item_id, rec FROM srs WHERE lab_id = ?", labId)) {
    if (r.kind === "q") st.srsq[r.item_id] = json<QRec>(r.rec, null as unknown as QRec)
    else st.srsc[r.item_id] = json<SrsRec>(r.rec, null as unknown as SrsRec)
  }
  for (const r of all<{ key: string; text: string; at: number }>("SELECT key, text, at FROM notes WHERE lab_id = ?", labId)) st.notes[r.key] = { t: r.text, at: r.at }
  st.meta = readMeta(labId)
  return st
}

export function saveState(labId: string, section: Section, patch: StatePatch) {
  tx(() => {
    if (section === "meta") {
      if (patch.whole) writeMeta(labId, patch.whole as Meta)
      return
    }
    if (section === "notes") {
      if (patch.whole) run("DELETE FROM notes WHERE lab_id = ?", labId)
      const set = (patch.whole ?? patch.set ?? {}) as Record<string, NoteEntry>
      for (const [k, v] of Object.entries(set)) {
        run("INSERT INTO notes(lab_id, key, text, at) VALUES(?, ?, ?, ?) ON CONFLICT(lab_id, key) DO UPDATE SET text = excluded.text, at = excluded.at", labId, k, v.t, v.at)
      }
      for (const k of patch.del ?? []) run("DELETE FROM notes WHERE lab_id = ? AND key = ?", labId, k)
      return
    }
    const kind = section === "srsq" ? "q" : "c"
    if (patch.whole) run("DELETE FROM srs WHERE lab_id = ? AND kind = ?", labId, kind)
    const set = (patch.whole ?? patch.set ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(set)) {
      run("INSERT INTO srs(lab_id, kind, item_id, rec) VALUES(?, ?, ?, ?) ON CONFLICT(lab_id, kind, item_id) DO UPDATE SET rec = excluded.rec", labId, kind, k, JSON.stringify(v))
    }
    for (const k of patch.del ?? []) run("DELETE FROM srs WHERE lab_id = ? AND kind = ? AND item_id = ?", labId, kind, k)
  })
}

export function addEvents(labId: string, events: StudyEvent[]) {
  tx(() => {
    for (const e of events) {
      run(
        "INSERT INTO events(lab_id, at, kind, item_id, mode, correct, grade, conf, picks, first, ms, changes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        labId,
        e.at,
        e.kind,
        e.item,
        e.mode,
        e.correct,
        e.grade,
        e.conf ?? null,
        e.picks ? JSON.stringify(e.picks) : null,
        e.first ? JSON.stringify(e.first) : null,
        Math.max(0, Math.round(e.ms)),
        e.changes ?? 0,
      )
    }
  })
}

export function readEvents(labId: string, since = 0): StudyEvent[] {
  return all<{ at: number; kind: "q" | "c"; item_id: string; mode: string; correct: 0 | 1; grade: number; conf: number | null; picks: string | null; first: string | null; ms: number; changes: number }>(
    "SELECT at, kind, item_id, mode, correct, grade, conf, picks, first, ms, changes FROM events WHERE lab_id = ? AND at >= ? ORDER BY at",
    labId,
    since,
  ).map((r) => {
    const e: StudyEvent = { at: r.at, kind: r.kind, item: r.item_id, mode: r.mode, correct: r.correct, grade: r.grade, ms: r.ms }
    if (r.conf != null) e.conf = r.conf as StudyEvent["conf"]
    if (r.picks) e.picks = json(r.picks, [])
    if (r.first) e.first = json(r.first, [])
    if (r.changes) e.changes = r.changes
    return e
  })
}

export function resetProgress(labId: string) {
  tx(() => {
    const keep = readMeta(labId).settings
    run("DELETE FROM srs WHERE lab_id = ?", labId)
    run("DELETE FROM notes WHERE lab_id = ?", labId)
    run("DELETE FROM events WHERE lab_id = ?", labId)
    writeMeta(labId, { ...defaultMeta(), settings: keep })
  })
}

/** Study items that are in rotation: suspended and archived items stay out of queues and analytics. */
export function snapshot(labId: string): LearnerSnapshot {
  const content = readContent(labId)
  const config = getConfig(labId)
  const st = readState(labId)
  return analyze({
    questions: content.questions.filter((q) => q.status !== "suspended"),
    cards: content.kb.cards.filter((c) => c.status !== "suspended"),
    topics: content.kb.topics,
    tags: content.kb.tags,
    domains: config.domains,
    exam: config.exam,
    srsq: st.srsq,
    srsc: st.srsc,
    meta: st.meta,
    events: readEvents(labId),
  })
}

/* ---------- coach records ---------- */

export function saveInsight(labId: string, r: InsightReport) {
  run("INSERT INTO insights(id, lab_id, at, data) VALUES(?, ?, ?, ?)", r.id, labId, r.at, JSON.stringify(r))
}

export function listInsights(labId: string): InsightReport[] {
  return all<{ data: string }>("SELECT data FROM insights WHERE lab_id = ? ORDER BY at DESC LIMIT 30", labId).map((r) => json(r.data, {} as InsightReport))
}

export function deleteInsight(labId: string, id: string) {
  run("DELETE FROM insights WHERE lab_id = ? AND id = ?", labId, id)
}

export function savePlan(labId: string, p: StudyPlan) {
  run(
    "INSERT INTO plans(id, lab_id, at, status, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
    p.id,
    labId,
    p.at,
    p.status,
    JSON.stringify(p),
  )
}

export function getPlan(labId: string, id: string): StudyPlan | null {
  const r = one<{ data: string }>("SELECT data FROM plans WHERE lab_id = ? AND id = ?", labId, id)
  return r ? json(r.data, null) : null
}

export function deletePlan(labId: string, id: string) {
  run("DELETE FROM plans WHERE lab_id = ? AND id = ?", labId, id)
}

export function listPlans(labId: string): StudyPlan[] {
  return all<{ data: string }>("SELECT data FROM plans WHERE lab_id = ? ORDER BY at DESC LIMIT 30", labId).map((r) => json(r.data, {} as StudyPlan))
}

export function activePlan(labId: string): StudyPlan | null {
  const r = one<{ data: string }>("SELECT data FROM plans WHERE lab_id = ? AND status = 'active' ORDER BY at DESC LIMIT 1", labId)
  return r ? json(r.data, null) : null
}

export function listThreads(labId: string): ChatThread[] {
  return all<ChatThread>("SELECT id, title, at FROM threads WHERE lab_id = ? ORDER BY at DESC", labId)
}

export function createThread(labId: string, title: string): ChatThread {
  const t = { id: newId("t_"), title: title.slice(0, 80) || "New chat", at: Date.now() }
  run("INSERT INTO threads(id, lab_id, title, at) VALUES(?, ?, ?, ?)", t.id, labId, t.title, t.at)
  return t
}

export function deleteThread(labId: string, id: string) {
  run("DELETE FROM threads WHERE lab_id = ? AND id = ?", labId, id)
}

export function addMessage(threadId: string, m: Omit<ChatMessage, "id">, raw?: unknown): ChatMessage {
  const r = run(
    "INSERT INTO messages(thread_id, at, role, content, tools, raw) VALUES(?, ?, ?, ?, ?, ?)",
    threadId,
    m.at,
    m.role,
    m.content,
    m.tools ? JSON.stringify(m.tools) : null,
    raw ? JSON.stringify(raw) : null,
  )
  run("UPDATE threads SET at = ? WHERE id = ?", m.at, threadId)
  return { ...m, id: Number(r.lastInsertRowid) }
}

export function listMessages(threadId: string): ChatMessage[] {
  return all<{ id: number; at: number; role: "user" | "assistant"; content: string; tools: string | null }>(
    "SELECT id, at, role, content, tools FROM messages WHERE thread_id = ? ORDER BY id",
    threadId,
  ).map((r) => ({ id: r.id, at: r.at, role: r.role, content: r.content, tools: json(r.tools, undefined) }))
}

/** The Claude Code session that holds this thread up to message `upto`, if any. */
export function threadSession(threadId: string): { id: string; upto: number } | null {
  const r = one<{ claude_session: string | null }>("SELECT claude_session FROM threads WHERE id = ?", threadId)
  return json<{ id: string; upto: number } | null>(r?.claude_session ?? null, null)
}

export function setThreadSession(threadId: string, s: { id: string; upto: number } | null) {
  run("UPDATE threads SET claude_session = ? WHERE id = ?", s ? JSON.stringify(s) : null, threadId)
}

export function lastMessageId(threadId: string): number {
  return one<{ id: number | null }>("SELECT MAX(id) AS id FROM messages WHERE thread_id = ?", threadId)?.id ?? 0
}

/** The raw provider messages (with tool calls and results) for continuing a conversation. */
export function rawMessages(threadId: string): unknown[] {
  return all<{ raw: string | null }>("SELECT raw FROM messages WHERE thread_id = ? ORDER BY id", threadId).flatMap((r) => json<unknown[]>(r.raw, []))
}

/* ---------- change journal ---------- */

export function listChanges(labId: string): ChangeEntry[] {
  return all<{ id: number; at: number; actor: string; tool: string; summary: string; undone: number }>(
    "SELECT id, at, actor, tool, summary, undone FROM changes WHERE lab_id = ? ORDER BY id DESC LIMIT 200",
    labId,
  ).map((r) => ({ ...r, undone: !!r.undone }))
}

export function logAiCall(labId: string | null, task: string, model: string, tokensIn: number, tokensOut: number, cost: number) {
  run("INSERT INTO ai_calls(at, lab_id, task, model, tokens_in, tokens_out, cost) VALUES(?, ?, ?, ?, ?, ?, ?)", Date.now(), labId, task, model, tokensIn, tokensOut, cost)
}

export function usageSummary() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const month = new Date(start.getFullYear(), start.getMonth(), 1)
  const sum = (since: number) => one<{ c: number | null }>("SELECT SUM(cost) c FROM ai_calls WHERE at >= ?", since)?.c ?? 0
  return { today: sum(start.getTime()), month: sum(month.getTime()), total: sum(0), calls: one<{ n: number }>("SELECT COUNT(*) n FROM ai_calls")!.n }
}
