import { median } from "@shared/analytics"
import { learnerModel, type LearnerModel } from "@shared/learner"
import { computePlan, type ComputedPlan } from "@shared/planner"
import type { StudyPlan } from "@shared/types"
import * as repo from "./repo"

/* Learner model and deterministic plan for one lab, read straight from the database. */

export function labLearner(labId: string, now = Date.now()): LearnerModel {
  const content = repo.readContent(labId)
  const cfg = repo.getConfig(labId)
  const st = repo.readState(labId)
  return learnerModel({
    questions: content.questions.filter((q) => q.status !== "suspended"),
    topics: content.kb.topics,
    domains: cfg.domains,
    exam: cfg.exam,
    graph: content.graph,
    srsq: st.srsq,
    events: repo.readEvents(labId),
    examDate: st.meta.settings.examDate,
    now,
  })
}

export function labPlan(labId: string, opts: { days?: number; minutesPerDay?: number; now?: number } = {}): ComputedPlan {
  const now = opts.now ?? Date.now()
  const content = repo.readContent(labId)
  const cfg = repo.getConfig(labId)
  const st = repo.readState(labId)
  const events = repo.readEvents(labId)
  const model = labLearner(labId, now)
  const active = <T extends { status?: string }>(x: T) => !x.status || x.status === "active"
  return computePlan({
    model,
    graph: content.graph,
    questions: content.questions.filter(active),
    cards: content.kb.cards.filter(active),
    domains: cfg.domains,
    exam: cfg.exam,
    examDate: st.meta.settings.examDate,
    minutesPerDay: opts.minutesPerDay ?? st.meta.settings.minutesPerDay ?? 45,
    srsq: st.srsq,
    srsc: st.srsc,
    exams: st.meta.exams,
    secPerQuestion: Math.min(180, Math.max(20, median(events.filter((e) => e.kind === "q").map((e) => e.ms / 1000)) ?? 60)),
    secPerCard: Math.min(60, Math.max(5, median(events.filter((e) => e.kind === "c").map((e) => e.ms / 1000)) ?? 15)),
    days: Math.max(1, Math.min(30, opts.days ?? 7)),
    now,
  })
}

/** A plan straight from the planner, for labs without an AI key or when you want no LLM involved. */
export function plannerPlan(labId: string, days = 7, minutesPerDay?: number): StudyPlan {
  const p = labPlan(labId, { days, minutesPerDay })
  return {
    id: repo.newId("plan-"),
    at: Date.now(),
    model: "planner",
    title: `Next ${p.days.length} days`,
    goal: "Spaced review every day, then the concepts with the highest priority for the exam.",
    rationale: [
      "Computed by the planner from your learner model:",
      ...p.priorities.slice(0, 5).map((x) => `- **${x.name}**: priority ${x.score.toFixed(2)} (${x.reason.replace("_", " ")}, mastery ${Math.round((1 - x.parts.gap) * 100)}%)`),
      ...p.notes.map((n) => `- ${n}`),
    ].join("\n"),
    start: p.start,
    days: p.days,
    status: "active",
  }
}
