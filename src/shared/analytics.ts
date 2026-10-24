import type { Card, Domain, ExamConfig, Meta, QRec, Question, SrsRec, StudyEvent, Topic } from "./types"

/*
  Learner analytics. Everything here is deterministic and cheap, so the app can show it live and the
  coach gets numbers it can cite instead of guessing. Sources for the heuristics:
  - rapid guessing: a response faster than a fraction of the expected reading time (Wise & Ma's
    normative threshold, adapted to one learner by estimating reading time from word count);
  - mastery: recency-weighted accuracy with a Beta(1,1) prior, in the spirit of PFA/Elo;
  - learning curves: error rate by practice opportunity per topic (Koedinger's KC curves);
  - calibration: accuracy per stated confidence (confident errors get priority — hypercorrection).
*/

export interface AnalyticsInput {
  questions: Question[]
  cards: Card[]
  topics: Topic[]
  tags: Record<string, string[]>
  domains: Domain[]
  exam: ExamConfig | null
  srsq: Record<string, QRec>
  srsc: Record<string, SrsRec>
  meta: Meta
  events: StudyEvent[]
  now?: number
}

export type TopicState = "new" | "weak" | "learning" | "solid" | "mastered"

export interface TopicReport {
  id: string
  title: string
  d: number
  questions: number
  seen: number
  attempts: number
  accuracy: number | null
  firstTry: number | null
  /** recency-weighted accuracy with a prior, 0–1 */
  mastery: number
  medianSec: number | null
  lapses: number
  repeatWrong: number
  confidentWrong: number
  rapid: number
  cards: number
  cardsSeen: number
  cardsStrong: number
  /** items whose interval is three weeks or more */
  learned: number
  state: TopicState
  trend: "up" | "down" | "flat" | null
  /** error rate by practice opportunity: 1–3, 4–6, 7–10, 11+ */
  curve: (number | null)[]
}

export interface RepeatedError {
  qid: string
  wrong: number
  /** the same wrong option picked again */
  samePick: boolean
  lastPick: number[]
  topics: string[]
}

export interface Confusion {
  a: string
  b: string
  misses: number
  qids: string[]
}

export interface Forgotten {
  qid: string
  gapDays: number
  topics: string[]
}

export interface LearnerSnapshot {
  at: number
  overview: {
    questions: number
    questionsSeen: number
    cards: number
    cardsSeen: number
    attempts: number
    firstTry: number | null
    recent: number | null
    minutes: number
    activeDays14: number
    streak: number
    daysToExam: number | null
    examScores: number[]
    learnedItems: number
  }
  time: {
    medianSec: number | null
    medianRightSec: number | null
    medianWrongSec: number | null
    paceSec: number | null
    overPace: number | null
    rapid: number
    rapidAccuracy: number | null
    slowRight: number
  }
  calibration: { conf: "guess" | "unsure" | "sure"; n: number; accuracy: number | null }[]
  changes: { changed: number; toRight: number; toWrong: number }
  domains: { d: number; name: string; w: number; total: number; seen: number; accuracy: number | null }[]
  topics: TopicReport[]
  repeated: RepeatedError[]
  confusions: Confusion[]
  forgotten: Forgotten[]
  reasons: Record<string, number>
  byHour: { hour: number; n: number; accuracy: number }[]
}

const DAY = 86400000

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

const words = (s: string) => (s.match(/\S+/g) ?? []).length

/** Seconds a careful reader needs to read the question and its options (about 4 words a second). */
export function readingSec(q: Question): number {
  return (words(q.stem) + q.opts.reduce((a, o) => a + words(o), 0)) / 4
}

export function isRapid(q: Question, ms: number): boolean {
  return ms < Math.max(2500, readingSec(q) * 1000 * 0.3)
}

const ratio = (a: number, b: number) => (b ? a / b : null)
const round = (x: number | null, p = 2) => (x == null ? null : Math.round(x * 10 ** p) / 10 ** p)

function sameSet(a: number[] | undefined, b: number[] | undefined) {
  if (!a || !b || a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

export function analyze(inp: AnalyticsInput): LearnerSnapshot {
  const now = inp.now ?? Date.now()
  const qById = new Map(inp.questions.map((q) => [q.id, q]))
  const topicIds = new Set(inp.topics.map((t) => t.id))
  const tagsOf = (qid: string) => (inp.tags[qid] ?? []).filter((t) => topicIds.has(t))
  const qEvents = inp.events.filter((e) => e.kind === "q" && qById.has(e.item)).sort((a, b) => a.at - b.at)

  /* ----- time ----- */
  const secs: number[] = []
  const right: number[] = []
  const wrong: number[] = []
  let rapid = 0
  let rapidOk = 0
  let slowRight = 0
  const pace = inp.exam ? (inp.exam.minutes * 60) / inp.exam.questions : null
  let overPace = 0
  for (const e of qEvents) {
    const q = qById.get(e.item)!
    const s = e.ms / 1000
    secs.push(s)
    ;(e.correct ? right : wrong).push(s)
    if (isRapid(q, e.ms)) {
      rapid++
      rapidOk += e.correct
    }
    if (pace && s > pace) overPace++
    if (e.correct && pace && s > pace * 1.5) slowRight++
  }

  /* ----- calibration and answer changes ----- */
  const cal = [0, 1, 2].map(() => ({ n: 0, ok: 0 }))
  const changes = { changed: 0, toRight: 0, toWrong: 0 }
  for (const e of qEvents) {
    if (e.conf != null && e.mode !== "exam") {
      cal[e.conf].n++
      cal[e.conf].ok += e.correct
    }
    if (e.changes && e.first) {
      const q = qById.get(e.item)!
      const firstOk = sameSet(e.first, q.ans)
      changes.changed++
      if (!firstOk && e.correct) changes.toRight++
      if (firstOk && !e.correct) changes.toWrong++
    }
  }

  /* ----- per item history: repeats and forgetting ----- */
  const byItem = new Map<string, StudyEvent[]>()
  for (const e of qEvents) {
    if (!byItem.has(e.item)) byItem.set(e.item, [])
    byItem.get(e.item)!.push(e)
  }
  const repeated: RepeatedError[] = []
  const forgotten: Forgotten[] = []
  for (const [qid, evs] of byItem) {
    const misses = evs.filter((e) => !e.correct)
    if (misses.length >= 2) {
      const wrongPicks = misses.map((e) => e.picks ?? [])
      const samePick = wrongPicks.some((p, i) => i > 0 && wrongPicks.slice(0, i).some((x) => sameSet(x, p)))
      repeated.push({ qid, wrong: misses.length, samePick, lastPick: wrongPicks[wrongPicks.length - 1], topics: tagsOf(qid) })
    }
    for (let i = 1; i < evs.length; i++) {
      const gap = (evs[i].at - evs[i - 1].at) / DAY
      if (evs[i - 1].correct && !evs[i].correct && gap >= 3) {
        forgotten.push({ qid, gapDays: Math.round(gap), topics: tagsOf(qid) })
        break
      }
    }
  }
  repeated.sort((a, b) => Number(b.samePick) - Number(a.samePick) || b.wrong - a.wrong)

  /* ----- confusions: misses on questions that span two topics, plus declared look-alikes ----- */
  const pairs = new Map<string, Confusion>()
  const addPair = (a: string, b: string, qid: string) => {
    const [x, y] = a < b ? [a, b] : [b, a]
    const k = `${x}|${y}`
    const p = pairs.get(k) ?? { a: x, b: y, misses: 0, qids: [] }
    p.misses++
    if (!p.qids.includes(qid)) p.qids.push(qid)
    pairs.set(k, p)
  }
  const confusableOf = new Map(inp.topics.map((t) => [t.id, new Set(t.confusable ?? [])]))
  for (const e of qEvents) {
    if (e.correct) continue
    const ts = tagsOf(e.item)
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) addPair(ts[i], ts[j], e.item)
    // A miss in a topic with declared look-alikes counts against each look-alike pair.
    for (const t of ts) for (const c of confusableOf.get(t) ?? []) if (topicIds.has(c) && !ts.includes(c)) addPair(t, c, e.item)
  }
  const confusions = [...pairs.values()].filter((p) => p.misses >= 2).sort((a, b) => b.misses - a.misses).slice(0, 15)

  /* ----- topics ----- */
  const qByTopic = new Map<string, Question[]>()
  for (const q of inp.questions) for (const t of tagsOf(q.id)) {
    if (!qByTopic.has(t)) qByTopic.set(t, [])
    qByTopic.get(t)!.push(q)
  }
  const cardsByTopic = new Map<string, Card[]>()
  for (const c of inp.cards) {
    if (!cardsByTopic.has(c.t)) cardsByTopic.set(c.t, [])
    cardsByTopic.get(c.t)!.push(c)
  }
  const eventsByTopic = new Map<string, StudyEvent[]>()
  for (const e of qEvents) for (const t of tagsOf(e.item)) {
    if (!eventsByTopic.has(t)) eventsByTopic.set(t, [])
    eventsByTopic.get(t)!.push(e)
  }
  const repeatByTopic = countBy(repeated.flatMap((r) => r.topics))

  const topics: TopicReport[] = inp.topics.map((t) => {
    const qs = qByTopic.get(t.id) ?? []
    const cs = cardsByTopic.get(t.id) ?? []
    const evs = eventsByTopic.get(t.id) ?? []
    let seen = 0
    let firstOk = 0
    let lapses = 0
    let confidentWrong = 0
    let learned = 0
    for (const q of qs) {
      const r = inp.srsq[q.id]
      if (!r) continue
      seen++
      firstOk += r.f
      lapses += r.l
      confidentWrong += r.h
      if (r.i >= 21) learned++
    }
    let cardsSeen = 0
    let cardsStrong = 0
    for (const c of cs) {
      const r = inp.srsc[c.id]
      if (!r) continue
      cardsSeen++
      if (r.i >= 7) cardsStrong++
      if (r.i >= 21) learned++
    }
    // Recency-weighted accuracy: each older attempt counts 0.85× the next one.
    let wSum = 0
    let wOk = 0
    for (let i = evs.length - 1, w = 1; i >= 0; i--, w *= 0.85) {
      wSum += w
      wOk += w * evs[i].correct
    }
    const cardSignal = cardsSeen ? cardsStrong / cardsSeen : null
    let mastery = (wOk + 1) / (wSum + 2)
    if (cardSignal != null) mastery = evs.length ? mastery * 0.75 + cardSignal * 0.25 : (cardSignal + 0.5) / 2
    const ok = evs.filter((e) => e.correct).length
    const curve = [
      [0, 3],
      [3, 6],
      [6, 10],
      [10, Infinity],
    ].map(([a, b]) => {
      const part = evs.slice(a, b)
      return part.length ? round(1 - part.filter((e) => e.correct).length / part.length) : null
    })
    const half = Math.floor(evs.length / 2)
    let trend: TopicReport["trend"] = null
    if (evs.length >= 8) {
      const early = evs.slice(0, half).filter((e) => e.correct).length / half
      const late = evs.slice(half).filter((e) => e.correct).length / (evs.length - half)
      trend = late - early > 0.12 ? "up" : early - late > 0.12 ? "down" : "flat"
    }
    const items = qs.length + cs.length
    let state: TopicState = "learning"
    if (!evs.length && !cardsSeen) state = "new"
    else if (evs.length >= 3 && mastery < 0.6) state = "weak"
    else if (mastery >= 0.8 && evs.length >= 5) state = items && learned / items >= 0.6 ? "mastered" : "solid"
    return {
      id: t.id,
      title: t.title,
      d: t.d,
      questions: qs.length,
      seen,
      attempts: evs.length,
      accuracy: round(ratio(ok, evs.length)),
      firstTry: round(ratio(firstOk, seen)),
      mastery: round(mastery)!,
      medianSec: round(median(evs.map((e) => e.ms / 1000)), 0),
      lapses,
      repeatWrong: repeatByTopic[t.id] ?? 0,
      confidentWrong,
      rapid: evs.filter((e) => isRapid(qById.get(e.item)!, e.ms)).length,
      cards: cs.length,
      cardsSeen,
      cardsStrong,
      learned,
      state,
      trend,
      curve,
    }
  })

  /* ----- domains ----- */
  const domains = inp.domains.map((d) => {
    let total = 0
    let seen = 0
    let ok = 0
    for (const q of inp.questions) {
      if (q.d !== d.n) continue
      total++
      const r = inp.srsq[q.id]
      if (r) {
        seen++
        ok += r.f
      }
    }
    return { d: d.n, name: d.name, w: d.w, total, seen, accuracy: round(ratio(ok, seen)) }
  })

  /* ----- habits ----- */
  const hours = new Map<number, { n: number; ok: number }>()
  for (const e of inp.events) {
    const h = new Date(e.at).getHours()
    const v = hours.get(h) ?? { n: 0, ok: 0 }
    v.n++
    v.ok += e.correct
    hours.set(h, v)
  }
  const byHour = [...hours.entries()]
    .filter(([, v]) => v.n >= 10)
    .map(([hour, v]) => ({ hour, n: v.n, accuracy: round(v.ok / v.n)! }))
    .sort((a, b) => a.hour - b.hour)

  const reasons: Record<string, number> = {}
  for (const m of Object.values(inp.meta.mistakes)) if (m.cat) reasons[m.cat] = (reasons[m.cat] ?? 0) + 1

  const seenQ = Object.keys(inp.srsq).filter((id) => qById.has(id))
  const firstOkAll = seenQ.reduce((a, id) => a + inp.srsq[id].f, 0)
  const recentEvs = qEvents.slice(-50)
  let minutes = 0
  for (const l of Object.values(inp.meta.log)) minutes += l.sec / 60
  let activeDays14 = 0
  for (let i = 0; i < 14; i++) {
    const l = inp.meta.log[dayKey(new Date(now - i * DAY))]
    if (l && l.n + l.r > 0) activeDays14++
  }

  return {
    at: now,
    overview: {
      questions: inp.questions.length,
      questionsSeen: seenQ.length,
      cards: inp.cards.length,
      cardsSeen: Object.keys(inp.srsc).length,
      attempts: qEvents.length,
      firstTry: round(ratio(firstOkAll, seenQ.length)),
      recent: round(ratio(recentEvs.filter((e) => e.correct).length, recentEvs.length)),
      minutes: Math.round(minutes),
      activeDays14,
      streak: streakOf(inp.meta, now),
      daysToExam: daysUntil(inp.meta.settings.examDate, now),
      examScores: inp.meta.exams.slice(-5).map((e) => e.score),
      learnedItems: topics.reduce((a, t) => a + t.learned, 0),
    },
    time: {
      medianSec: round(median(secs), 0),
      medianRightSec: round(median(right), 0),
      medianWrongSec: round(median(wrong), 0),
      paceSec: pace ? Math.round(pace) : null,
      overPace: round(ratio(overPace, qEvents.length)),
      rapid,
      rapidAccuracy: round(ratio(rapidOk, rapid)),
      slowRight,
    },
    calibration: (["guess", "unsure", "sure"] as const).map((conf, i) => ({ conf, n: cal[i].n, accuracy: round(ratio(cal[i].ok, cal[i].n)) })),
    changes,
    domains,
    topics,
    repeated: repeated.slice(0, 25),
    confusions,
    forgotten: forgotten.slice(0, 25),
    reasons,
    byHour,
  }
}

function countBy(xs: string[]) {
  const out: Record<string, number> = {}
  for (const x of xs) out[x] = (out[x] ?? 0) + 1
  return out
}

export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function daysUntil(dateStr: string | null, now = Date.now()): number | null {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split("-").map(Number)
  if (!y || !m || !d) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / DAY)
}

function streakOf(meta: Meta, now: number) {
  let n = 0
  const d = new Date(now)
  const today = meta.log[dayKey(d)]
  if (!today || today.n + today.r === 0) d.setDate(d.getDate() - 1)
  for (;;) {
    const l = meta.log[dayKey(d)]
    if (!l || l.n + l.r === 0) break
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

export const TOPIC_STATE_LABEL: Record<TopicState, string> = {
  new: "Not started",
  weak: "Needs work",
  learning: "Learning",
  solid: "Solid",
  mastered: "Mastered",
}
