import { data, DOMAINS, domainOf, EXAM_FACTS, EXAM_MIX } from "./data"
import { dayKey, daysUntil, endOfDayMin, isDue, nowMin } from "./srs"
import { shuffled } from "./actions"
import type { AppState, Card, Question } from "./types"

export interface DomainStat {
  d: number
  total: number
  seen: number
  firstN: number
  firstOk: number
  latestOk: number
  /** smoothed first-attempt accuracy */
  acc: number
}

export function readiness(s: AppState) {
  const per: DomainStat[] = DOMAINS.map((d) => ({ d: d.n, total: 0, seen: 0, firstN: 0, firstOk: 0, latestOk: 0, acc: 0.5 }))
  const byN = new Map(per.map((p) => [p.d, p]))
  for (const q of data().questions) {
    const p = byN.get(q.d)
    if (!p) continue
    p.total++
    const r = s.srsq[q.id]
    if (r) {
      p.seen++
      p.firstN++
      p.firstOk += r.f
      p.latestOk += r.la
    }
  }
  let weighted = 0
  const totalW = DOMAINS.reduce((a, d) => a + d.w, 0) || 1
  for (const p of per) {
    p.acc = (p.firstOk + 1) / (p.firstN + 2)
    weighted += ((domainOf(p.d)?.w ?? 0) / totalW) * p.acc
  }
  const n = per.reduce((a, p) => a + p.firstN, 0)
  const recentExams = s.meta.exams.slice(-3)
  const examAvg = recentExams.length ? recentExams.reduce((a, e) => a + e.score, 0) / recentExams.length : null
  return { per, score: Math.round(EXAM_FACTS.min + (EXAM_FACTS.max - EXAM_FACTS.min) * weighted), n, examAvg, reliable: n >= 40 }
}

export interface TopicStat {
  qTotal: number
  qSeen: number
  qOk: number
  cTotal: number
  cSeen: number
  cStrong: number
  mastery: number | null
}

export function topicStat(s: AppState, topicId: string): TopicStat {
  const qs = data().qByTopic.get(topicId) ?? []
  const cs = data().cardsByTopic.get(topicId) ?? []
  let qSeen = 0
  let qOk = 0
  for (const q of qs) {
    const r = s.srsq[q.id]
    if (r) {
      qSeen++
      qOk += r.la
    }
  }
  let cSeen = 0
  let cStrong = 0
  for (const c of cs) {
    const r = s.srsc[c.id]
    if (r) {
      cSeen++
      if (r.i >= 7) cStrong++
      else if (r.r >= 1) cStrong += 0.5
    }
  }
  const parts: [number, number][] = []
  if (qSeen) parts.push([qOk / qSeen, 0.6])
  if (cSeen) parts.push([cStrong / cs.length, 0.4])
  const mastery = parts.length ? parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0) : null
  return { qTotal: qs.length, qSeen, qOk, cTotal: cs.length, cSeen, cStrong, mastery }
}

export function weakTopics(s: AppState, n = 6) {
  const rows = data().topics
    .filter((t) => t.d > 0)
    .map((t) => {
      const st = topicStat(s, t.id)
      const acc = st.qSeen ? st.qOk / st.qSeen : null
      const weight = domainOf(t.d)?.w ?? 10
      // Untested topics rank by exam weight; tested ones by how often they still go wrong.
      const need = acc == null ? 0.55 + weight / 400 : (1 - acc) * (0.7 + weight / 100) + (st.qSeen < 3 ? 0.1 : 0)
      return { topic: t, st, acc, need }
    })
    .sort((a, b) => b.need - a.need)
  return rows.slice(0, n)
}

export function dueSummary(s: AppState) {
  const horizon = endOfDayMin()
  let cards = 0
  let cues = 0
  let qs = 0
  let newCards = 0
  let newCues = 0
  let newQs = 0
  for (const c of data().cards) {
    const r = s.srsc[c.id]
    if (!r) {
      if (c.k === "trigger") newCues++
      else newCards++
    } else if (isDue(r, horizon)) {
      if (c.k === "trigger") cues++
      else cards++
    }
  }
  for (const q of data().questions) {
    const r = s.srsq[q.id]
    if (!r) newQs++
    else if (isDue(r, horizon)) qs++
  }
  const today = s.meta.log[dayKey()]
  return { cards, cues, qs, newCards, newCues, newQs, doneToday: today ? today.n + today.r : 0, newToday: today?.n ?? 0 }
}

/** Items introduced today, split by kind, so daily new-item limits hold across sessions. */
function introducedToday(s: AppState) {
  const start = endOfDayMin(-1)
  let cards = 0
  let qs = 0
  for (const r of Object.values(s.srsc)) if (r.s === 1 && r.t > start) cards++
  for (const r of Object.values(s.srsq)) if (r.s === 1 && r.t > start) qs++
  return { cards, qs }
}

export function suggestedNewPerDay(s: AppState) {
  const left = daysUntil(s.meta.settings.examDate)
  if (left == null || left <= 0) return null
  const sum = dueSummary(s)
  // Finish first exposure with about a fifth of the runway left for pure review.
  const runway = Math.max(1, Math.floor(left * 0.8))
  return { cards: Math.ceil((sum.newCards + sum.newCues) / runway), qs: Math.ceil(sum.newQs / runway), left }
}

export interface QueueItem {
  kind: "c" | "q"
  id: string
}

export interface QueueFilter {
  domain?: number
  topic?: string
}

function matchesCard(c: Card, f: QueueFilter) {
  if (f.topic && c.t !== f.topic) return false
  if (f.domain) {
    const t = data().topicById.get(c.t)
    if (!t || t.d !== f.domain) return false
  }
  return true
}

function matchesQ(q: Question, f: QueueFilter) {
  if (f.domain && q.d !== f.domain) return false
  if (f.topic && !(data().kb.tags[q.id] ?? []).includes(f.topic)) return false
  return true
}

/** Round-robin across groups so neighbours come from different topics (interleaving). */
function interleave<T>(groups: T[][]): T[] {
  const out: T[] = []
  const gs = groups.map((g) => [...g]).filter((g) => g.length)
  while (gs.length) {
    for (let i = 0; i < gs.length; i++) {
      const v = gs[i].shift()
      if (v !== undefined) out.push(v)
    }
    for (let i = gs.length - 1; i >= 0; i--) if (!gs[i].length) gs.splice(i, 1)
  }
  return out
}

function pickNewCards(s: AppState, f: QueueFilter, limit: number): Card[] {
  if (limit <= 0) return []
  const byTopic = new Map<string, Card[]>()
  for (const c of data().cards) {
    if (s.srsc[c.id] || !matchesCard(c, f)) continue
    if (!byTopic.has(c.t)) byTopic.set(c.t, [])
    byTopic.get(c.t)!.push(c)
  }
  // Heavier domains first, then keep each topic's cards in authored order (lecture order).
  const groups = [...byTopic.entries()]
    .sort((a, b) => (domainOf(data().topicById.get(b[0])?.d ?? 0)?.w ?? 0) - (domainOf(data().topicById.get(a[0])?.d ?? 0)?.w ?? 0))
    .map(([, cs]) => cs)
  return interleave(groups).slice(0, limit)
}

function pickNewQuestions(s: AppState, f: QueueFilter, limit: number): Question[] {
  if (limit <= 0) return []
  const fresh = data().questions.filter((q) => !s.srsq[q.id] && matchesQ(q, f))
  if (f.domain || f.topic) return shuffled(fresh).slice(0, limit)
  const byD = new Map<number, Question[]>()
  for (const q of shuffled(fresh)) {
    if (!byD.has(q.d)) byD.set(q.d, [])
    byD.get(q.d)!.push(q)
  }
  const out: Question[] = []
  // Allocate by exam weight, then fill any gap from whatever is left.
  for (const d of DOMAINS) {
    const take = Math.round((limit * (EXAM_MIX[d.n] ?? 0)) / Math.max(1, EXAM_FACTS.questions))
    out.push(...(byD.get(d.n) ?? []).splice(0, take))
  }
  const rest = shuffled([...byD.values()].flat())
  while (out.length < limit && rest.length) out.push(rest.shift()!)
  return shuffled(out.slice(0, limit))
}

/** The daily mix: due questions (confident misses first), due cards, then new material. */
export function buildDaily(s: AppState, f: QueueFilter = {}): QueueItem[] {
  const st = s.meta.settings
  const horizon = endOfDayMin()
  const dueQs = data().questions
    .filter((q) => matchesQ(q, f) && isDue(s.srsq[q.id], horizon))
    .sort((a, b) => (s.srsq[b.id].h - s.srsq[a.id].h) || s.srsq[a.id].d - s.srsq[b.id].d)
  const dueCards = data().cards
    .filter((c) => matchesCard(c, f) && isDue(s.srsc[c.id], horizon))
    .sort((a, b) => s.srsc[a.id].d - s.srsc[b.id].d)
  const intro = introducedToday(s)
  const scoped = !!(f.domain || f.topic)
  const newCards = pickNewCards(s, f, scoped ? Math.max(st.newCards, 15) : st.newCards - intro.cards)
  const newQs = pickNewQuestions(s, f, scoped ? Math.max(st.newQs, 8) : st.newQs - intro.qs)

  const cardItems: QueueItem[] = [...dueCards, ...newCards].map((c) => ({ kind: "c", id: c.id }))
  const qItems: QueueItem[] = [...dueQs, ...newQs].map((q) => ({ kind: "q", id: q.id }))
  // Weave: a question after every three cards keeps retrieval varied.
  const out: QueueItem[] = []
  let ci = 0
  let qi = 0
  while (ci < cardItems.length || qi < qItems.length) {
    for (let k = 0; k < 3 && ci < cardItems.length; k++) out.push(cardItems[ci++])
    if (qi < qItems.length) out.push(qItems[qi++])
  }
  return out.slice(0, st.sessionMax)
}

export function cardsQueue(s: AppState, f: QueueFilter & { kinds?: "cards" | "cues" | "all"; scope?: "due" | "all" | "new" | "weak" }, limit = 40): QueueItem[] {
  const horizon = endOfDayMin()
  const kinds = f.kinds ?? "all"
  const pool = data().cards.filter((c) => matchesCard(c, f) && (kinds === "all" || (kinds === "cues" ? c.k === "trigger" : c.k !== "trigger")))
  let picked: Card[]
  switch (f.scope ?? "due") {
    case "due": {
      const due = pool.filter((c) => isDue(s.srsc[c.id], horizon)).sort((a, b) => s.srsc[a.id].d - s.srsc[b.id].d)
      const fresh = pool.filter((c) => !s.srsc[c.id])
      picked = [...due, ...fresh].slice(0, limit)
      break
    }
    case "new":
      picked = pool.filter((c) => !s.srsc[c.id]).slice(0, limit)
      break
    case "weak":
      picked = pool
        .filter((c) => s.srsc[c.id] && (s.srsc[c.id].l > 0 || (s.srsc[c.id].g ?? 3) <= 2 || s.srsc[c.id].i < 3))
        .sort((a, b) => (s.srsc[b.id].l - s.srsc[a.id].l) || s.srsc[a.id].i - s.srsc[b.id].i)
        .slice(0, limit)
      break
    default:
      picked = shuffled(pool).slice(0, limit)
  }
  return picked.map((c) => ({ kind: "c", id: c.id }))
}

export function heatmap(s: AppState, weeks = 12) {
  const days: { key: string; date: Date; count: number; ok: number; bad: number; sec: number }[] = []
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  // Align the grid so the last column ends on this week's Sunday.
  const dow = (end.getDay() + 6) % 7
  const start = new Date(end)
  start.setDate(end.getDate() - dow - (weeks - 1) * 7)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d)
    const l = s.meta.log[key]
    days.push({ key, date: new Date(d), count: l ? l.n + l.r : 0, ok: l?.ok ?? 0, bad: l?.bad ?? 0, sec: l?.sec ?? 0 })
  }
  return days
}

export function streak(s: AppState) {
  let n = 0
  const d = new Date()
  const today = s.meta.log[dayKey(d)]
  if (!today || today.n + today.r === 0) d.setDate(d.getDate() - 1)
  for (;;) {
    const l = s.meta.log[dayKey(d)]
    if (!l || l.n + l.r === 0) break
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

export function totals(s: AppState) {
  let sec = 0
  let items = 0
  for (const l of Object.values(s.meta.log)) {
    sec += l.sec
    items += l.n + l.r
  }
  const seenQ = Object.keys(s.srsq).length
  const seenC = Object.keys(s.srsc).length
  return { sec, items, seenQ, seenC }
}

export function forecast(s: AppState, days = 7) {
  const out = Array.from({ length: days }, () => 0)
  const base = endOfDayMin()
  const now = nowMin()
  for (const r of [...Object.values(s.srsc), ...Object.values(s.srsq)]) {
    if (r.d <= base) {
      out[0]++
      continue
    }
    const idx = Math.floor((r.d - base) / 1440) + 1
    if (idx < days) out[idx]++
  }
  void now
  return out
}

/** A quick block of questions: anything due first, then unseen questions in exam proportions. */
export function questionSprint(s: AppState, n: number, f: QueueFilter = {}): QueueItem[] {
  const horizon = endOfDayMin()
  const due = data().questions
    .filter((q) => matchesQ(q, f) && isDue(s.srsq[q.id], horizon))
    .sort((a, b) => (s.srsq[b.id].h - s.srsq[a.id].h) || s.srsq[a.id].d - s.srsq[b.id].d)
    .slice(0, n)
  const fresh = pickNewQuestions(s, f, n - due.length)
  return [...due, ...fresh].map((q) => ({ kind: "q", id: q.id }))
}
