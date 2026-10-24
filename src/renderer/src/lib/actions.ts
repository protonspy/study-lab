import { data, EXAM_FACTS } from "./data"
import { currentView } from "./nav"
import { capFromExam, dayKey, questionGrade, schedule, type Grade } from "./srs"
import { batch, getState, logEvent, mutate } from "./store"
import type { ActiveExam, Card, Confidence, ExamResult, QRec, Question, Settings } from "./types"

function cap() {
  return capFromExam(getState().meta.settings.examDate)
}

function logDay(isNew: boolean, ok: boolean | null, sec: number) {
  mutate("meta", (m) => {
    const k = dayKey()
    const d = m.log[k] ?? { n: 0, r: 0, ok: 0, bad: 0, sec: 0 }
    if (isNew) d.n++
    else d.r++
    if (ok === true) d.ok++
    if (ok === false) d.bad++
    d.sec += Math.min(240, Math.max(0, Math.round(sec)))
    m.log[k] = d
  })
}

export function recordCard(card: Card, grade: Grade, sec: number) {
  const prev = getState().srsc[card.id]
  const rec = schedule(prev, grade, "c", cap())
  mutate("srsc", (s) => {
    s[card.id] = rec
  })
  logDay(!prev, grade > 1, sec)
  logEvent({ at: Date.now(), kind: "c", item: card.id, mode: currentView(), correct: grade > 1 ? 1 : 0, grade, ms: sec * 1000 })
}

/** How the answer was reached, for the event log. */
export interface AttemptDetail {
  mode?: string
  /** times the selection changed before submitting */
  changes?: number
  /** the first selection */
  first?: number[]
}

export function isCorrect(q: Question, picks: number[]) {
  if (picks.length !== q.ans.length) return false
  const a = new Set(q.ans)
  return picks.every((p) => a.has(p))
}

export function recordQuestion(q: Question, picks: number[], conf: Confidence, sec: number, detail: AttemptDetail = {}) {
  const correct = isCorrect(q, picks)
  const prev = getState().srsq[q.id]
  const grade = questionGrade(correct, conf)
  const base = schedule(prev, grade, "q", cap())
  const rec: QRec = {
    ...base,
    c: (prev?.c ?? 0) + (correct ? 1 : 0),
    w: (prev?.w ?? 0) + (correct ? 0 : 1),
    f: prev ? prev.f : correct ? 1 : 0,
    h: (prev?.h ?? 0) + (!correct && conf === 2 ? 1 : 0),
    la: correct ? 1 : 0,
    cf: conf,
    lp: [...picks].sort(),
  }
  mutate("srsq", (s) => {
    s[q.id] = rec
  })
  if (!correct) {
    mutate("meta", (m) => {
      const cur = m.mistakes[q.id]
      m.mistakes[q.id] = { ...(cur ?? {}), at: Date.now() }
    })
  }
  logDay(!prev, correct, sec)
  logEvent({
    at: Date.now(),
    kind: "q",
    item: q.id,
    mode: detail.mode ?? currentView(),
    correct: correct ? 1 : 0,
    grade,
    conf,
    picks: [...picks].sort(),
    ms: sec * 1000,
    ...(detail.changes ? { changes: detail.changes, first: detail.first } : {}),
  })
  return correct
}

export function setMistakeReason(qid: string, cat: string | undefined, note?: string) {
  mutate("meta", (m) => {
    const cur = m.mistakes[qid] ?? { at: Date.now() }
    m.mistakes[qid] = { ...cur, cat, note: note ?? cur.note, at: Date.now() }
  })
}

export function toggleFlag(qid: string) {
  mutate("meta", (m) => {
    const on = !m.flags[qid]?.on
    m.flags[qid] = { on, at: Date.now() }
  })
}

export function setNote(key: string, text: string) {
  mutate("notes", (n) => {
    n[key] = { t: text, at: Date.now() }
  })
}

export function updateSettings(patch: Partial<Settings>) {
  mutate("meta", (m) => {
    m.settings = { ...m.settings, ...patch }
  })
}

/* ---------- exam simulation ---------- */

export function shuffled<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function optionOrder(q: Question, shuffle: boolean): number[] {
  const idx = q.opts.map((_, i) => i)
  return shuffle ? shuffled(idx) : idx
}

export function startExam(mode: string, label: string, ids: string[], limitMin: number) {
  const { settings } = getState().meta
  const order: Record<string, number[]> = {}
  for (const id of ids) {
    const q = data().qById.get(id)
    if (q) order[id] = optionOrder(q, settings.shuffle)
  }
  const now = Date.now()
  const active: ActiveExam = { mode, label, ids, order, picks: {}, flags: [], cur: 0, used: 0, since: now, limitMin, u: now, qms: {}, qSince: now, changes: {}, first: {} }
  mutate("meta", (m) => {
    m.active = active
    m.au = Date.now()
  })
}

export function patchExam(patch: Partial<ActiveExam>) {
  mutate("meta", (m) => {
    if (!m.active) return
    m.active = { ...m.active, ...patch, u: Date.now() }
    m.au = Date.now()
  })
}

export function examUsedMs(a: ActiveExam) {
  return a.used + (a.since ? Date.now() - a.since : 0)
}

/** Time on each question so far, counting the open stretch on the current one. */
export function examQuestionMs(a: ActiveExam): Record<string, number> {
  const out = { ...(a.qms ?? {}) }
  const id = a.ids[a.cur]
  if (id && a.since && a.qSince) out[id] = (out[id] ?? 0) + Date.now() - a.qSince
  return out
}

/** Close the time slice on the current question; call before moving, pausing or submitting. */
export function examLeaveQuestion(a: ActiveExam): Pick<ActiveExam, "qms" | "qSince"> {
  return { qms: examQuestionMs(a), qSince: a.since ? Date.now() : 0 }
}

/** Track how an answer evolved: the first selection and how often it changed. */
export function examPick(a: ActiveExam, id: string, next: number[]): Pick<ActiveExam, "picks" | "changes" | "first"> {
  const prev = a.picks[id]
  const first = { ...(a.first ?? {}) }
  const changes = { ...(a.changes ?? {}) }
  if (!prev || !prev.length) {
    if (!first[id]) first[id] = next
  } else if (next.length && (next.length !== prev.length || next.some((x) => !prev.includes(x)))) {
    changes[id] = (changes[id] ?? 0) + 1
  }
  return { picks: { ...a.picks, [id]: next }, changes, first }
}

export function abandonExam() {
  mutate("meta", (m) => {
    m.active = null
    m.au = Date.now()
  })
}

/** Maps raw accuracy linearly onto the exam's reported scale (e.g. AWS's 100–1000). */
export function scaledScore(correct: number, total: number) {
  const { min, max } = EXAM_FACTS
  if (!total) return min
  return Math.round(min + ((max - min) * correct) / total)
}

export function finishExam(): ExamResult | null {
  const a = getState().meta.active
  if (!a) return null
  const perD: Record<string, [number, number]> = {}
  let correct = 0
  const picks: number[][] = []
  const flagged = new Set(a.flags)
  for (const id of a.ids) {
    const q = data().qById.get(id)
    if (!q) continue
    const p = a.picks[id] ?? []
    picks.push(p)
    const ok = isCorrect(q, p)
    if (ok) correct++
    const key = String(q.d)
    perD[key] = perD[key] ?? [0, 0]
    perD[key][1]++
    if (ok) perD[key][0]++
  }
  const sec = Math.round(examUsedMs(a) / 1000)
  const qms = examQuestionMs(a)
  const result: ExamResult = {
    at: Date.now(),
    mode: a.mode,
    label: a.label,
    ids: a.ids,
    picks,
    flags: a.flags,
    correct,
    total: a.ids.length,
    score: scaledScore(correct, a.ids.length),
    sec,
    limitMin: a.limitMin,
    perD,
    ms: a.ids.map((id) => Math.round(qms[id] ?? 0)),
  }
  // Exam answers feed the scheduler: a flag means "unsure", an unflagged miss is a confident miss.
  const perQ = Math.max(5, sec / Math.max(1, a.ids.length))
  batch(() => {
    for (const id of a.ids) {
      const q = data().qById.get(id)
      if (!q) continue
      const p = a.picks[id] ?? []
      const spent = qms[id] ? qms[id] / 1000 : perQ
      recordQuestion(q, p, p.length === 0 ? 0 : flagged.has(id) ? 1 : 2, spent, { mode: "exam", changes: a.changes?.[id], first: a.first?.[id] })
    }
    mutate("meta", (m) => {
      m.exams = [...m.exams, result].slice(-30)
      m.active = null
      m.au = Date.now()
    })
  })
  return result
}

export const passMark = () => EXAM_FACTS.pass

export { questionGrade, type Grade }
