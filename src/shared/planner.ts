import { dayKey } from "./analytics"
import { retrievability } from "./fsrs"
import type { KcState, LearnerModel } from "./learner"
import type { Card, Domain, ExamConfig, ExamResult, KnowledgeGraph, PlanDay, PlanTask, QRec, Question, SrsRec } from "./types"

/*
  Deterministic study planner (docs/methodology.md §3). The schedule comes from the learner model
  and FSRS, not from the LLM; the coach explains it and may adjust it within limits.

  priority(k) = w_k · (gap + γ·unc + δ·risk) · urgency · misconception · readiness^η
  Each day: due reviews (≤ ~50% of the budget) → exam protection → retests of confident errors →
  mock exam on its cadence → remediation, greedy by priority per minute, at most 4 concepts and
  2 brand-new ones a day, confusable pairs practised together, a concept revisited after 1–3 days.
*/

const GAMMA = 0.3
const DELTA = 0.7
const ALPHA = 1
const BETA = 0.5
const ETA = 1
const DAY = 86_400_000

export interface PlannerInput {
  model: LearnerModel
  graph: KnowledgeGraph
  questions: Question[]
  cards: Card[]
  domains: Domain[]
  exam: ExamConfig | null
  examDate: string | null
  minutesPerDay: number
  srsq: Record<string, QRec>
  srsc: Record<string, SrsRec>
  exams: ExamResult[]
  /** median seconds per question / card from the learner's log */
  secPerQuestion: number
  secPerCard: number
  days: number
  now?: number
}

export interface KcPriority {
  kc: string
  name: string
  topic: string | null
  score: number
  parts: { weight: number; gap: number; unc: number; risk: number; urgency: number; misconception: number; readiness: number }
  reason: "misconception" | "confusable" | "gap" | "prereq_unlock" | "exam_risk"
}

export interface ComputedPlan {
  start: string
  days: PlanDay[]
  priorities: KcPriority[]
  notes: string[]
}

function startOfDay(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function examMs(examDate: string | null): number | null {
  if (!examDate) return null
  const [y, m, d] = examDate.split("-").map(Number)
  return y && m && d ? new Date(y, m - 1, d, 9).getTime() : null
}

export function priorities(inp: PlannerInput, now: number): KcPriority[] {
  const exam = examMs(inp.examDate)
  const daysLeft = exam ? Math.max(0, (exam - now) / DAY) : null
  const urgency = 1 + ALPHA * Math.max(0, 1 - (daysLeft ?? 60) / 14)
  const totalW = inp.domains.reduce((a, d) => a + d.w, 0) || 1
  const kcsPerDomain = new Map<number, number>()
  for (const k of inp.model.kcs) if (k.items > 0) kcsPerDomain.set(k.domain, (kcsPerDomain.get(k.domain) ?? 0) + 1)
  const confusable = new Map<string, number>()
  for (const e of inp.graph.edges) if (e.type === "confusable" && e.status !== "rejected") {
    confusable.set(e.src, (confusable.get(e.src) ?? 0) + e.weight)
    confusable.set(e.dst, (confusable.get(e.dst) ?? 0) + e.weight)
  }
  return inp.model.kcs
    .filter((k) => k.items > 0)
    .map((k) => {
      const dw = inp.domains.find((d) => d.n === k.domain)?.w ?? totalW / Math.max(1, inp.domains.length)
      const weight = dw / totalW / Math.max(1, kcsPerDomain.get(k.domain) ?? 1)
      const gap = 1 - k.mastery
      const unc = k.sd * 2
      const risk = k.examRetention != null ? 1 - k.examRetention : k.retention != null ? 1 - k.retention : k.attempts ? 0.3 : 0
      const mis = 1 + BETA * (k.misconceptions.length || k.pendingRetest ? 1 : 0)
      const ready = Math.max(0.05, k.readiness)
      const score = weight * (gap + GAMMA * unc + DELTA * risk) * urgency * mis * ready ** ETA * 100
      const reason: KcPriority["reason"] = k.misconceptions.length
        ? "misconception"
        : (confusable.get(k.id) ?? 0) > 0 && k.errors.confusion > 0
          ? "confusable"
          : k.readiness < 0.5
            ? "prereq_unlock"
            : risk > gap
              ? "exam_risk"
              : "gap"
      return { kc: k.id, name: k.name, topic: k.topic, score: Math.round(score * 1000) / 1000, parts: { weight, gap, unc, risk, urgency, misconception: mis, readiness: k.readiness }, reason }
    })
    .sort((a, b) => b.score - a.score)
}

export function computePlan(inp: PlannerInput): ComputedPlan {
  const now = inp.now ?? Date.now()
  const today = startOfDay(now)
  const exam = examMs(inp.examDate)
  const budget = Math.max(10, inp.minutesPerDay)
  const notes: string[] = []
  const prio = priorities(inp, now)
  const kcState = inp.model.byId
  const prereqOf = new Map<string, string[]>()
  const confusableOf = new Map<string, string[]>()
  for (const e of inp.graph.edges) {
    if (e.status === "rejected") continue
    if (e.type === "prerequisite") prereqOf.set(e.dst, [...(prereqOf.get(e.dst) ?? []), e.src])
    if (e.type === "confusable") {
      confusableOf.set(e.src, [...(confusableOf.get(e.src) ?? []), e.dst])
      confusableOf.set(e.dst, [...(confusableOf.get(e.dst) ?? []), e.src])
    }
  }
  const qPerSession = 8
  const minQ = inp.secPerQuestion / 60
  const minC = inp.secPerCard / 60
  const lastPractised = new Map<string, number>()
  const projected = new Map<string, number>(inp.model.kcs.map((k) => [k.id, k.mastery]))
  const lastMock = inp.exams.length ? Math.max(...inp.exams.map((e) => e.at)) : null
  let nextMock = !exam ? null : lastMock == null ? today : Math.max(today, startOfDay(lastMock) + 8 * DAY)
  const finalMock = exam ? startOfDay(exam) - 4 * DAY : null
  let newToday = 0
  let id = 0
  const tid = (d: number) => `d${d + 1}t${++id}`
  const days: PlanDay[] = []
  // Each confident error is retested once, on the first day 1–3 days after it.
  const retested = new Set<string>()

  for (let d = 0; d < inp.days; d++) {
    const day = today + d * DAY
    const end = day + DAY - 1
    if (exam && day > startOfDay(exam)) break
    const tasks: PlanTask[] = []
    let left = budget
    id = 0
    newToday = 0

    // 1. Spaced review: items due by the end of this day (as currently scheduled).
    const dueQ = inp.questions.filter((q) => inp.srsq[q.id] && inp.srsq[q.id].d * 60_000 <= end && (d === 0 || inp.srsq[q.id].d * 60_000 > end - DAY)).length
    const dueC = inp.cards.filter((c) => inp.srsc[c.id] && inp.srsc[c.id].d * 60_000 <= end && (d === 0 || inp.srsc[c.id].d * 60_000 > end - DAY)).length
    const reviewMin = Math.min(Math.ceil(dueQ * minQ + dueC * minC), Math.round(budget * 0.5))
    if (dueQ + dueC > 0) {
      tasks.push({ id: tid(d), type: "review", title: "Spaced review", topics: [], minutes: Math.max(5, reviewMin), count: dueQ + dueC, why: `${dueQ} questions and ${dueC} cards due`, reason: "due_review" })
      left -= Math.max(5, reviewMin)
    }

    // 2. Exam protection: items that would fall below 85% recall on exam day, around 20% of the runway before it.
    if (exam && d === Math.max(0, Math.round(((exam - today) / DAY) * 0.8))) {
      const atRisk = inp.questions.filter((q) => {
        const r = retrievability(inp.srsq[q.id], exam)
        return r != null && r < 0.85 && inp.srsq[q.id].d * 60_000 > exam
      })
      if (atRisk.length) {
        const m = Math.min(Math.ceil(atRisk.length * minQ), Math.round(budget * 0.4))
        tasks.push({ id: tid(d), type: "practice", title: "Exam-day protection", topics: [], minutes: m, count: atRisk.length, why: `${atRisk.length} items would be forgotten by exam day`, reason: "exam_risk" })
        left -= m
      }
    }

    // 3. Retests of confident errors and misconceptions, 1–3 days after the error.
    if (d >= 1 && d <= 3) {
      const retest = inp.model.kcs.filter((k) => !retested.has(k.id) && (k.pendingRetest || k.misconceptions.length) && k.lastErrorAt && day - startOfDay(k.lastErrorAt) >= DAY && day - startOfDay(k.lastErrorAt) <= 3 * DAY && !tasks.some((t) => t.kcs?.includes(k.id)))
      if (retest.length && left > 5) {
        const kcs = retest.slice(0, 4).map((k) => k.id)
        const m = Math.min(left, Math.ceil(kcs.length * 4 * minQ) + 2)
        tasks.push({ id: tid(d), type: "practice", title: "Retest confident mistakes", topics: topicsOf(kcs, kcState), kcs, count: kcs.length * 4, minutes: m, why: "Errors made with confidence are corrected best with a retest 1–3 days later", reason: "retest" })
        left -= m
        for (const k of kcs) {
          lastPractised.set(k, day)
          retested.add(k)
        }
      }
    }

    // 4. Mock exams: a baseline, then every ~8 days, and one 3–5 days before the exam.
    if (inp.exam && (day === nextMock || day === finalMock)) {
      tasks.push({ id: tid(d), type: "exam", title: day === finalMock ? "Final mock exam" : lastMock == null && d === 0 ? "Baseline mock exam" : "Mock exam", topics: [], minutes: inp.exam.minutes, count: inp.exam.questions, why: "Practise the real format and recalibrate", reason: "mock" })
      left -= inp.exam.minutes
      nextMock = day + 8 * DAY
    }

    // 5. Remediation: greedy by priority per minute, spacing practice of a concept 2 days apart.
    const ranked = [...prio].sort((a, b) => adjusted(b) - adjusted(a))
    const picked = new Set<string>()
    for (const p of ranked) {
      if (left < 6 || picked.size >= 4) break
      if (picked.has(p.kc) || tasks.some((t) => t.kcs?.includes(p.kc))) continue
      const last = lastPractised.get(p.kc)
      if (last != null && day - last < 2 * DAY) continue
      const st = kcState.get(p.kc)
      if (!st) continue
      let target = p.kc
      let reason = p.reason as string
      // Not ready: work on the weakest prerequisite first.
      if (st.readiness < 0.5) {
        const pre = (prereqOf.get(p.kc) ?? []).map((x) => kcState.get(x)).filter((x): x is KcState => !!x && x.items > 0).sort((a, b) => a.mastery - b.mastery)[0]
        if (pre && !picked.has(pre.id)) {
          target = pre.id
          reason = "prereq_unlock"
        }
      }
      const isNew = (kcState.get(target)?.attempts ?? 0) === 0
      if (isNew && newToday >= 2) continue
      // Confusable partner practised together (interleaving similar concepts helps most).
      const spaced = (x: string) => {
        const l = lastPractised.get(x)
        return l == null || day - l >= 2 * DAY
      }
      const partner = (confusableOf.get(target) ?? []).find((x) => !picked.has(x) && spaced(x) && (kcState.get(x)?.items ?? 0) > 0)
      const kcs = partner && reason !== "prereq_unlock" ? [target, partner] : [target]
      const minutes = Math.min(left, Math.ceil(kcs.length * qPerSession * minQ) + 2)
      tasks.push({
        id: tid(d),
        type: "practice",
        title: kcs.length > 1 ? `Tell apart: ${kcs.map((k) => kcState.get(k)?.name ?? k).join(" vs ")}` : `${isNew ? "Learn" : "Practise"}: ${kcState.get(target)?.name ?? target}`,
        topics: topicsOf(kcs, kcState),
        kcs,
        count: kcs.length * qPerSession,
        minutes,
        why: whyText(kcs.length > 1 ? "confusable" : reason, kcState.get(target)),
        reason: kcs.length > 1 ? "confusable" : reason,
      })
      for (const k of kcs) {
        picked.add(k)
        lastPractised.set(k, day)
        projected.set(k, Math.min(0.95, (projected.get(k) ?? 0.3) + 0.12))
      }
      if (isNew) newToday++
      left -= minutes
    }
    // Spacing blocked every concept: interleave the top ones instead of leaving the day idle.
    if (!tasks.some((t) => t.type === "practice") && left >= 10 && prio.length) {
      const kcs = prio.slice(0, 3).map((p) => p.kc)
      const minutes = Math.min(left, Math.ceil(kcs.length * 4 * minQ) + 2)
      tasks.push({ id: tid(d), type: "practice", title: "Mixed practice", topics: topicsOf(kcs, kcState), kcs, count: kcs.length * 4, minutes, why: "Interleaving your top concepts keeps retrieval varied", reason: "interleaved" })
    }
    if (tasks.length) days.push({ day: days.length + 1, date: dayKey(new Date(day)), focus: focusLine(tasks, kcState), tasks })
  }
  if (!prio.length) notes.push("No concept has questions yet: import content or build the knowledge base first.")
  if (!inp.exam) notes.push("No exam format is set, so the plan has no mock exams.")
  return { start: dayKey(new Date(today)), days, priorities: prio.slice(0, 30), notes }

  /** Priority with a projected-mastery discount, so practised concepts give way to others on later days. */
  function adjusted(p: KcPriority) {
    const base = kcState.get(p.kc)?.mastery ?? 0.3
    const proj = projected.get(p.kc) ?? base
    return p.score * ((1 - proj) / Math.max(0.05, 1 - base))
  }
}

function topicsOf(kcs: string[], st: Map<string, KcState>) {
  return [...new Set(kcs.map((k) => st.get(k)?.topic).filter((x): x is string => !!x))]
}

function whyText(reason: string, k: KcState | undefined) {
  if (!k) return ""
  const m = `${Math.round(k.mastery * 100)}% mastery`
  switch (reason) {
    case "misconception":
      return `Same wrong option picked ${k.misconceptions[0]?.count ?? 2}× (${m})`
    case "confusable":
      return "These two get mixed up; practising them side by side trains the difference"
    case "prereq_unlock":
      return `Prerequisite for weaker concepts (${m})`
    case "exam_risk":
      return `Likely to be forgotten by exam day (${m})`
    default:
      return k.attempts ? `${m} after ${k.attempts} answers` : "Not started yet"
  }
}

function focusLine(tasks: PlanTask[], st: Map<string, KcState>) {
  const names = tasks.flatMap((t) => t.kcs ?? []).map((k) => st.get(k)?.name).filter(Boolean)
  if (tasks.some((t) => t.type === "exam")) return "Mock exam day"
  return names.length ? names.slice(0, 3).join(", ") : "Spaced review"
}
