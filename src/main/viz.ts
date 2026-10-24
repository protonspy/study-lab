import { dayKey, median } from "@shared/analytics"
import { retrievability } from "@shared/fsrs"
import { learnerModel, type LearnerModel } from "@shared/learner"
import { quantileDots, wilson, type GraphViewData, type MeterRow, type PerformanceData, type TimelineData } from "@shared/viz"
import type { StudyEvent } from "@shared/types"
import { labPlan } from "./learner"
import * as repo from "./repo"

/* Data behind the Performance, Timeline and Concept-map views (docs/visualization.md). */

const DAY = 86_400_000

function context(labId: string) {
  const content = repo.readContent(labId)
  const cfg = repo.getConfig(labId)
  const st = repo.readState(labId)
  const events = repo.readEvents(labId)
  const active = <T extends { status?: string }>(x: T) => !x.status || x.status === "active"
  const questions = content.questions.filter(active)
  const model = (now: number, evs: StudyEvent[] = events): LearnerModel =>
    learnerModel({
      questions,
      topics: content.kb.topics,
      domains: cfg.domains,
      exam: cfg.exam,
      graph: content.graph,
      srsq: st.srsq,
      events: evs.filter((e) => e.at <= now),
      examDate: st.meta.settings.examDate,
      now,
    })
  return { content, cfg, st, events, questions, model }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function performance(labId: string): PerformanceData {
  const now = Date.now()
  const { content, cfg, st, events, questions, model } = context(labId)
  const m = model(now)
  const ghost = events.length && events[0].at < now - 14 * DAY ? model(now - 14 * DAY) : null
  const totalW = cfg.domains.reduce((a, d) => a + d.w, 0) || 1
  const exam = cfg.exam

  const row = (id: string, name: string, ks: { mastery: number; sd: number; attempts: number; items: number }[], gks: { mastery: number }[] | null, weight: number): MeterRow => {
    const withItems = ks.filter((k) => k.items > 0)
    const seen = withItems.filter((k) => k.attempts > 0)
    return {
      id,
      name,
      mastery: seen.length ? mean(seen.map((k) => k.mastery))! : null,
      sd: seen.length ? Math.sqrt(seen.reduce((a, k) => a + k.sd ** 2, 0) / seen.length ** 2 + 0.0004) : null,
      ghost: gks && gks.length && seen.length ? mean(gks.map((k) => k.mastery)) : null,
      attempts: ks.reduce((a, k) => a + k.attempts, 0),
      items: ks.reduce((a, k) => a + k.items, 0),
      weight,
    }
  }
  const domains = cfg.domains.map((d) => {
    const topics = content.kb.topics
      .filter((t) => t.d === d.n)
      .map((t) => {
        const ks = m.kcs.filter((k) => k.topic === t.id)
        const gks = ghost ? ghost.kcs.filter((k) => k.topic === t.id && k.attempts > 0) : null
        const kcRows = m.topicLevel
          ? []
          : ks.map((k) => ({
              ...row(k.id, k.name, [k], ghost?.byId.get(k.id)?.attempts ? [ghost.byId.get(k.id)!] : null, 0),
              readiness: k.readiness,
            }))
        return { ...row(t.id, t.title, ks, gks, 0), kcs: kcRows }
      })
    const ks = m.kcs.filter((k) => k.domain === d.n)
    const gks = ghost ? ghost.kcs.filter((k) => k.domain === d.n && k.attempts > 0) : null
    return { ...row(String(d.n), d.name, ks, gks, d.w / totalW), d: d.n, topics }
  })

  // Retention forecast without further review: FSRS retrievability of everything studied.
  const recs = [...Object.values(st.srsq), ...Object.values(st.srsc)].filter((r) => r.s > 0)
  const examDate = st.meta.settings.examDate
  const [ey, em, ed] = (examDate ?? "").split("-").map(Number)
  const examAt = examDate && ey ? new Date(ey, em - 1, ed, 9).getTime() : null
  const horizon = Math.max(7, Math.min(90, examAt && examAt > now ? Math.ceil((examAt - now) / DAY) : 30))
  const retention: PerformanceData["retention"] = []
  if (recs.length)
    for (let i = 0; i <= horizon; i += Math.max(1, Math.round(horizon / 30))) {
      const at = now + i * DAY
      const rs = recs
        .map((r) => retrievability(r, at))
        .filter((x): x is number => x != null)
        .sort((a, b) => a - b)
      if (!rs.length) break
      retention.push({ date: dayKey(new Date(at)), mean: mean(rs)!, p10: rs[Math.floor(rs.length * 0.1)], p90: rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.9))] })
    }

  // Calibration per stated confidence.
  const stated = [0.35, 0.65, 0.92]
  const calibration = (["guess", "unsure", "sure"] as const).map((conf, i) => {
    const evs = events.filter((e) => e.kind === "q" && e.conf === i && e.mode !== "exam")
    const k = evs.filter((e) => e.correct).length
    const ci = wilson(k, evs.length)
    return { conf, stated: stated[i], n: evs.length, acc: evs.length ? k / evs.length : null, lo: ci?.[0] ?? null, hi: ci?.[1] ?? null }
  })

  // Speed × accuracy per topic.
  const qTopic = new Map(Object.entries(content.kb.tags).map(([q, ts]) => [q, ts[0]]))
  const byTopic = new Map<string, StudyEvent[]>()
  for (const e of events) {
    if (e.kind !== "q") continue
    const t = qTopic.get(e.item)
    if (t) byTopic.set(t, [...(byTopic.get(t) ?? []), e])
  }
  const qById = new Map(questions.map((q) => [q.id, q]))
  const speed = [...byTopic.entries()]
    .filter(([, evs]) => evs.length >= 3)
    .map(([t, evs]) => ({
      topic: t,
      title: content.kb.topics.find((x) => x.id === t)?.title ?? t,
      medianSec: Math.round(median(evs.map((e) => e.ms / 1000)) ?? 0),
      accuracy: evs.filter((e) => e.correct).length / evs.length,
      n: evs.length,
      rapid: evs.filter((e) => {
        const q = qById.get(e.item)
        return q ? e.ms < Math.max(2500, ((q.stem.split(/\s+/).length + q.opts.join(" ").split(/\s+/).length) / 4) * 300) : false
      }).length,
    }))

  const pr = labPlan(labId, { days: 1 }).priorities.slice(0, 3)
  const scale = exam ? { min: exam.min, max: exam.max, pass: exam.pass } : null
  let quantiles: number[] = []
  if (m.predicted && exam) {
    const sd = (m.predicted.high - m.predicted.low) / (2 * 1.64)
    quantiles = quantileDots(m.predicted.score, sd).map((x) => Math.round(Math.min(exam.max, Math.max(exam.min, x))))
  }
  return {
    topicLevel: m.topicLevel,
    scale,
    predicted: m.predicted ? { score: m.predicted.score, low: m.predicted.low, high: m.predicted.high, probPass: m.predicted.probPass } : null,
    quantiles,
    target: 0.8,
    domains,
    retention,
    examDate,
    calibration,
    brier: m.calibration.brier,
    bias: m.calibration.bias,
    speed,
    paceSec: exam ? Math.round((exam.minutes * 60) / exam.questions) : null,
    errors: m.errors,
    actions: pr.map((p) => ({
      label: p.name,
      why: p.reason,
      kcs: m.topicLevel ? [] : [p.kc],
      topics: p.topic ? [p.topic] : [],
      reason: p.reason,
    })),
  }
}

export function timeline(labId: string): TimelineData {
  const now = Date.now()
  const { content, cfg, st, events, model } = context(labId)
  const exam = cfg.exam
  const byDay = new Map<string, TimelineData["days"][number] & { ok: number; n: number }>()
  for (const e of events) {
    const k = dayKey(new Date(e.at))
    const d = byDay.get(k) ?? { date: k, review: 0, practice: 0, exam: 0, cards: 0, minutes: 0, accuracy: null, ok: 0, n: 0 }
    if (e.kind === "c") d.cards++
    else if (e.mode === "exam") d.exam++
    else if (e.mode === "review") d.review++
    else d.practice++
    d.minutes += Math.min(240, e.ms / 1000) / 60
    if (e.kind === "q") {
      d.n++
      d.ok += e.correct
    }
    byDay.set(k, d)
  }
  const first = events.length ? events[0].at : now
  const days: TimelineData["days"] = []
  for (let t = new Date(first).setHours(0, 0, 0, 0); t <= now; t += DAY) {
    const k = dayKey(new Date(t))
    const d = byDay.get(k)
    days.push(d ? { date: k, review: d.review, practice: d.practice, exam: d.exam, cards: d.cards, minutes: Math.round(d.minutes), accuracy: d.n ? d.ok / d.n : null } : { date: k, review: 0, practice: 0, exam: 0, cards: 0, minutes: 0, accuracy: null })
  }

  // Predicted score over time, at up to ~24 checkpoints.
  const trend: TimelineData["trend"] = []
  if (exam && events.length) {
    const span = now - first
    const steps = Math.min(24, Math.max(2, Math.ceil(span / DAY)))
    for (let i = 1; i <= steps; i++) {
      const at = first + (span * i) / steps
      const p = model(at).predicted
      if (p) trend.push({ date: dayKey(new Date(at)), score: p.score, low: p.low, high: p.high })
    }
  }

  const mocks = st.meta.exams.map((e) => ({ date: dayKey(new Date(e.at)), at: e.at, score: e.score, label: e.label }))
  const m = model(now)
  const milestones: TimelineData["milestones"] = []
  for (const k of m.kcs) {
    if (k.masteredAt) milestones.push({ date: dayKey(new Date(k.masteredAt)), at: k.masteredAt, kind: "mastered", label: `Mastered ${k.name}`, ref: k.id })
    for (const r of k.resolved) milestones.push({ date: dayKey(new Date(r.at)), at: r.at, kind: "resolved", label: `Fixed a misconception in ${k.name}`, ref: k.id })
  }
  for (const c of repo.listChanges(labId).filter((c) => !c.undone).slice(0, 60))
    milestones.push({ date: dayKey(new Date(c.at)), at: c.at, kind: "coach", label: c.summary, ref: String(c.id) })
  milestones.sort((a, b) => a.at - b.at)

  // Plan adherence from every plan's days.
  const status = new Map<string, TimelineData["plan"][number]["status"]>()
  const today = dayKey()
  for (const p of repo.listPlans(labId)) {
    for (const d of p.days) {
      if (status.has(d.date) && p.status !== "active") continue
      const done = d.tasks.filter((t) => t.done).length
      status.set(d.date, d.date > today ? "upcoming" : done === d.tasks.length && done > 0 ? "done" : done > 0 ? "partial" : d.date === today ? "upcoming" : "missed")
    }
  }

  // Each domain 30 days ago vs now.
  const then = events.length && first < now - 30 * DAY ? model(now - 30 * DAY) : null
  const slope = cfg.domains.map((d) => {
    const nowKs = m.kcs.filter((k) => k.domain === d.n && k.attempts > 0)
    const thenKs = then ? then.kcs.filter((k) => k.domain === d.n && k.attempts > 0) : []
    return { d: d.n, name: d.short || d.name, before: thenKs.length ? mean(thenKs.map((k) => k.mastery)) : null, now: nowKs.length ? mean(nowKs.map((k) => k.mastery)) : null }
  })
  void content
  return {
    scale: exam ? { min: exam.min, max: exam.max, pass: exam.pass } : null,
    days,
    trend,
    mocks,
    milestones,
    plan: [...status.entries()].map(([date, s]) => ({ date, status: s })).sort((a, b) => a.date.localeCompare(b.date)),
    slope,
  }
}

export function graphView(labId: string): GraphViewData {
  const { content, cfg, model } = context(labId)
  const m = model(Date.now())
  const totalW = cfg.domains.reduce((a, d) => a + d.w, 0) || 1
  const perDomain = new Map<number, number>()
  for (const k of m.kcs) perDomain.set(k.domain, (perDomain.get(k.domain) ?? 0) + 1)
  const stats: GraphViewData["stats"] = {}
  for (const k of m.kcs) {
    const w = (cfg.domains.find((d) => d.n === k.domain)?.w ?? 0) / totalW / Math.max(1, perDomain.get(k.domain) ?? 1)
    stats[k.id] = { mastery: k.mastery, sd: k.sd, readiness: k.readiness, items: k.items, attempts: k.attempts, weight: w, errors: k.errors, misconceptions: k.misconceptions.length }
  }
  // Without a concept graph, derive topic links from the data: shared questions (related) and misses on them (confusable).
  let graph = content.graph
  if (graph.topicLevel && !graph.edges.length) {
    const pair = new Map<string, { a: string; b: string; shared: number; misses: number }>()
    const wrong = new Map<string, number>()
    for (const e of repo.readEvents(labId)) if (e.kind === "q" && !e.correct) wrong.set(e.item, (wrong.get(e.item) ?? 0) + 1)
    for (const [qid, ts] of Object.entries(content.kb.tags)) {
      for (let i = 0; i < ts.length; i++)
        for (let j = i + 1; j < ts.length; j++) {
          const [a, b] = [ts[i], ts[j]].sort()
          const x = pair.get(`${a}|${b}`) ?? { a, b, shared: 0, misses: 0 }
          x.shared++
          x.misses += wrong.get(qid) ?? 0
          pair.set(`${a}|${b}`, x)
        }
    }
    const edges = [...pair.values()].flatMap((x) => [
      ...(x.shared >= 2 ? [{ src: x.a, dst: x.b, type: "related" as const, weight: x.shared, method: "co-tagged questions", evidence: `${x.shared} shared questions`, status: "accepted" as const }] : []),
      ...(x.misses >= 2 ? [{ src: x.a, dst: x.b, type: "confusable" as const, weight: x.misses, method: "learner misses", evidence: `${x.misses} misses on questions spanning both`, status: "accepted" as const }] : []),
    ])
    graph = { ...graph, edges }
  }
  return {
    graph,
    topics: content.kb.topics.map((t) => ({ id: t.id, title: t.title, d: t.d })),
    domains: cfg.domains,
    stats,
  }
}
