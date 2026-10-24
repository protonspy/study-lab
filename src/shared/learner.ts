import { isRapid } from "./analytics"
import { retrievability, stabilityOf } from "./fsrs"
import type { Domain, ExamConfig, KnowledgeGraph, QRec, Question, StudyEvent, Topic } from "./types"

/*
  Learner model over knowledge components (docs/methodology.md §2):
  - mastery per KC: a BKT-style posterior with fixed parameters (slip 0.1, guess 1/options, learning
    0.12), so a right answer on a 4-option question is weaker evidence than on a 6-option one;
    rapid guesses carry no evidence; repeating the same question soon after counts half;
  - uncertainty from the effective number of observations;
  - readiness from prerequisites (knowledge-space "outer fringe");
  - error typology per wrong answer: slip, misconception, forgetting, gap, confusion;
  - predicted exam score with an interval, and calibration (Brier score, confidence bias).
*/

const P_INIT = 0.3
const SLIP = 0.1
const LEARN = 0.05
const DAY = 86_400_000

export type ErrorType = "slip" | "misconception" | "forgetting" | "gap" | "confusion"

export interface KcState {
  id: string
  name: string
  topic: string | null
  domain: number
  mastery: number
  sd: number
  /** effective observations */
  n: number
  attempts: number
  correct: number
  lastAt: number | null
  /** min mastery of prerequisites (1 when none) */
  readiness: number
  /** mean retrievability of its questions today / on exam day (FSRS) */
  retention: number | null
  examRetention: number | null
  items: number
  errors: Record<ErrorType, number>
  /** wrong options picked twice or more, still not answered right since */
  misconceptions: { qid: string; option: number; count: number; lastAt: number }[]
  /** a confident wrong answer not yet retested correctly */
  pendingRetest: boolean
  lastErrorAt: number | null
}

export interface LearnerModel {
  kcs: KcState[]
  byId: Map<string, KcState>
  predicted: { score: number; low: number; high: number; pass: number | null; probPass: number | null } | null
  calibration: { brier: number | null; bias: number | null; n: number }
  errors: Record<ErrorType, number>
  rapidRate: number | null
  topicLevel: boolean
}

export interface LearnerInput {
  questions: Question[]
  topics: Topic[]
  domains: Domain[]
  exam: ExamConfig | null
  graph: KnowledgeGraph
  srsq: Record<string, QRec>
  events: StudyEvent[]
  examDate: string | null
  now?: number
}

const CONF_P = [0.35, 0.65, 0.92]

function guessRate(q: Question) {
  // Picking k right answers out of n options at random.
  const n = q.opts.length
  const k = Math.max(1, q.ans.length)
  let comb = 1
  for (let i = 0; i < k; i++) comb = (comb * (n - i)) / (i + 1)
  return 1 / Math.max(2, comb)
}

/** Bayesian update of P(mastered) after one observation, with partial weight, then learning. */
export function bktUpdate(p: number, correct: boolean, guess: number, weight = 1): number {
  const like = correct ? [1 - SLIP, guess] : [SLIP, 1 - guess]
  const post = (p * like[0]) / (p * like[0] + (1 - p) * like[1])
  const mixed = p + weight * (post - p)
  return mixed + (1 - mixed) * LEARN * weight
}

function examDayMs(examDate: string | null): number | null {
  if (!examDate) return null
  const [y, m, d] = examDate.split("-").map(Number)
  return y && m && d ? new Date(y, m - 1, d, 9).getTime() : null
}

export function learnerModel(inp: LearnerInput): LearnerModel {
  const now = inp.now ?? Date.now()
  const qById = new Map(inp.questions.map((q) => [q.id, q]))
  const topicDomain = new Map(inp.topics.map((t) => [t.id, t.d]))
  const g = inp.graph
  const prereqs = new Map<string, string[]>()
  const confusable = new Map<string, Set<string>>()
  for (const e of g.edges) {
    if (e.status === "rejected") continue
    if (e.type === "prerequisite") prereqs.set(e.dst, [...(prereqs.get(e.dst) ?? []), e.src])
    if (e.type === "confusable") {
      if (!confusable.has(e.src)) confusable.set(e.src, new Set())
      if (!confusable.has(e.dst)) confusable.set(e.dst, new Set())
      confusable.get(e.src)!.add(e.dst)
      confusable.get(e.dst)!.add(e.src)
    }
  }
  const itemsOf = new Map<string, string[]>()
  for (const [qid, ks] of Object.entries(g.itemKc)) {
    if (!qById.has(qid)) continue
    for (const k of ks) itemsOf.set(k.kc, [...(itemsOf.get(k.kc) ?? []), qid])
  }

  const st = new Map<string, KcState>()
  for (const k of g.kcs) {
    st.set(k.id, {
      id: k.id,
      name: k.name,
      topic: k.topic,
      domain: k.topic ? (topicDomain.get(k.topic) ?? 0) : 0,
      mastery: P_INIT,
      sd: Math.sqrt((P_INIT * (1 - P_INIT)) / 2),
      n: 0,
      attempts: 0,
      correct: 0,
      lastAt: null,
      readiness: 1,
      retention: null,
      examRetention: null,
      items: itemsOf.get(k.id)?.length ?? 0,
      errors: { slip: 0, misconception: 0, forgetting: 0, gap: 0, confusion: 0 },
      misconceptions: [],
      pendingRetest: false,
      lastErrorAt: null,
    })
  }

  const errors: Record<ErrorType, number> = { slip: 0, misconception: 0, forgetting: 0, gap: 0, confusion: 0 }
  const lastAttempt = new Map<string, number>()
  const lastCorrect = new Map<string, number>()
  const wrongPicks = new Map<string, Map<number, { count: number; lastAt: number }>>()
  let calN = 0
  let brierSum = 0
  let confSum = 0
  let okSum = 0
  let rapid = 0
  let qEvents = 0

  const events = inp.events.filter((e) => e.kind === "q" && qById.has(e.item)).sort((a, b) => a.at - b.at)
  for (const e of events) {
    const q = qById.get(e.item)!
    qEvents++
    const ok = e.correct === 1
    if (e.conf != null && e.mode !== "exam") {
      const p = CONF_P[e.conf]
      brierSum += (p - (ok ? 1 : 0)) ** 2
      confSum += p
      okSum += ok ? 1 : 0
      calN++
    }
    const fast = isRapid(q, e.ms)
    if (fast) rapid++
    const prevAt = lastAttempt.get(q.id)
    const weight = fast ? 0 : prevAt && e.at - prevAt < DAY ? 0.5 : 1
    const kcs = g.itemKc[q.id] ?? []
    const guess = guessRate(q)

    // Error typology, judged with the state *before* this answer.
    let type: ErrorType | null = null
    if (!ok) {
      const picked = (e.picks ?? []).filter((p) => !q.ans.includes(p))
      const pickedKcs = picked.map((p) => g.optionKc[q.id]?.[p]).filter((x): x is string => !!x)
      const primary = kcs[0]?.kc
      const repeats = picked.some((p) => (wrongPicks.get(q.id)?.get(p)?.count ?? 0) >= 1)
      const lc = lastCorrect.get(q.id)
      if (primary && pickedKcs.some((k) => k !== primary && confusable.get(primary)?.has(k))) type = "confusion"
      else if (repeats) type = "misconception"
      else if (lc != null && e.at - lc >= Math.max(3 * DAY, 0.5 * stabilityOf(inp.srsq[q.id]) * DAY)) type = "forgetting"
      else if (primary && (st.get(primary)?.mastery ?? 0) >= 0.8 && (e.conf ?? 2) < 2) type = "slip"
      else type = "gap"
      errors[type]++
      for (const p of picked) {
        const m = wrongPicks.get(q.id) ?? new Map()
        const cur = m.get(p) ?? { count: 0, lastAt: 0 }
        m.set(p, { count: cur.count + 1, lastAt: e.at })
        wrongPicks.set(q.id, m)
      }
    } else {
      lastCorrect.set(q.id, e.at)
      wrongPicks.delete(q.id)
    }

    for (const { kc, role } of kcs) {
      const s = st.get(kc)
      if (!s) continue
      const w = weight * (role === "primary" ? 1 : 0.5)
      s.attempts++
      if (ok) s.correct++
      s.lastAt = e.at
      if (w > 0) {
        s.mastery = bktUpdate(s.mastery, ok, guess, w)
        s.n += w
      }
      if (type && role === "primary") {
        s.errors[type]++
        s.lastErrorAt = e.at
        if (e.conf === 2 && e.mode !== "exam") s.pendingRetest = true
      }
      if (ok && role === "primary") s.pendingRetest = false
    }
    lastAttempt.set(q.id, e.at)
  }

  // Active misconceptions: a wrong option picked twice or more and not answered right since.
  for (const [qid, picks] of wrongPicks) {
    for (const [option, v] of picks) {
      if (v.count < 2) continue
      const primary = g.itemKc[qid]?.[0]?.kc
      const s = primary ? st.get(primary) : undefined
      if (s) s.misconceptions.push({ qid, option, count: v.count, lastAt: v.lastAt })
    }
  }

  const examAt = examDayMs(inp.examDate)
  for (const s of st.values()) {
    s.sd = Math.sqrt((s.mastery * (1 - s.mastery)) / (s.n + 2))
    const rs: number[] = []
    const ers: number[] = []
    for (const qid of itemsOf.get(s.id) ?? []) {
      const r = retrievability(inp.srsq[qid], now)
      if (r != null) rs.push(r)
      if (examAt && examAt > now) {
        const er = retrievability(inp.srsq[qid], examAt)
        if (er != null) ers.push(er)
      }
    }
    s.retention = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null
    s.examRetention = ers.length ? ers.reduce((a, b) => a + b, 0) / ers.length : null
  }
  for (const s of st.values()) {
    const ps = (prereqs.get(s.id) ?? []).map((p) => st.get(p)?.mastery).filter((x): x is number => x != null)
    s.readiness = ps.length ? Math.min(...ps) : 1
  }

  /* predicted exam score: P(correct) per KC, averaged per domain, weighted by the exam guide */
  let predicted: LearnerModel["predicted"] = null
  if (inp.exam && st.size) {
    const byDomain = new Map<number, KcState[]>()
    for (const s of st.values()) if (s.items > 0) byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s])
    let wSum = 0
    let mean = 0
    let variance = 0
    for (const d of inp.domains) {
      const ks = byDomain.get(d.n) ?? []
      if (!ks.length || !d.w) continue
      const pc = ks.map((k) => k.mastery * (1 - SLIP) + (1 - k.mastery) * 0.25)
      const m = pc.reduce((a, b) => a + b, 0) / pc.length
      const v = ks.reduce((a, k) => a + (k.sd * (1 - SLIP - 0.25)) ** 2, 0) / ks.length ** 2
      mean += d.w * m
      variance += d.w ** 2 * v
      wSum += d.w
    }
    if (wSum) {
      mean /= wSum
      // Model uncertainty on top of sampling uncertainty: the KC model itself is approximate (±6 points of accuracy).
      const sd = Math.sqrt((Math.sqrt(variance) / wSum) ** 2 + 0.06 ** 2)
      const { min, max, pass } = inp.exam
      const scale = (x: number) => Math.round(min + (max - min) * Math.max(0, Math.min(1, x)))
      const passAcc = (pass - min) / Math.max(1, max - min)
      const z = sd > 0 ? (mean - passAcc) / sd : mean >= passAcc ? 9 : -9
      predicted = { score: scale(mean), low: scale(mean - 1.64 * sd), high: scale(mean + 1.64 * sd), pass, probPass: Math.min(0.98, Math.max(0.02, Math.round(normCdf(z) * 100) / 100)) }
    }
  }

  const kcs = [...st.values()]
  return {
    kcs,
    byId: st,
    predicted,
    calibration: { brier: calN ? Math.round((brierSum / calN) * 1000) / 1000 : null, bias: calN ? Math.round(((confSum - okSum) / calN) * 100) / 100 : null, n: calN },
    errors,
    rapidRate: qEvents ? Math.round((rapid / qEvents) * 100) / 100 : null,
    topicLevel: g.topicLevel,
  }
}

function normCdf(z: number) {
  // Abramowitz–Stegun approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}
