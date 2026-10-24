import { dayKey } from "@shared/analytics"
import { data, LAB } from "./data"
import { go, run } from "./nav"
import { buildDaily, cardsQueue, questionSprint, type QueueItem } from "./stats"
import { getState } from "./store"
import type { PlanDay, PlanTask, StudyPlan } from "./types"

/* Turning the coach's plan tasks into study sessions. */

export function todayOf(plan: StudyPlan): PlanDay | null {
  const today = dayKey()
  return plan.days.find((d) => d.date === today) ?? null
}

/** The first day that still has open tasks, up to today. */
export function currentDay(plan: StudyPlan): PlanDay | null {
  const today = dayKey()
  return plan.days.find((d) => d.date === today) ?? plan.days.find((d) => d.date > today) ?? null
}

export function canStart(task: PlanTask): boolean {
  return task.type !== "custom"
}

function interleave(lists: QueueItem[][], max: number): QueueItem[] {
  const out: QueueItem[] = []
  const seen = new Set<string>()
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const x = l[i]
      if (x && !seen.has(x.id)) {
        seen.add(x.id)
        out.push(x)
      }
    }
  }
  return out.slice(0, max)
}

export function startTask(task: PlanTask) {
  const s = getState()
  const topics = task.topics.filter((t) => data().topicById.has(t))
  const n = task.count ?? Math.max(5, Math.round(task.minutes * 1.2))
  switch (task.type) {
    case "review":
      if (topics.length) return run(task.title, interleave(topics.map((t) => buildDaily(s, { topic: t })), n), "coach")
      return go("review")
    case "practice": {
      const items = topics.length ? interleave(topics.map((t) => questionSprint(s, n, { topic: t })), n) : questionSprint(s, n)
      return run(task.title, items, "coach")
    }
    case "cards":
    case "cues": {
      const kinds = task.type === "cues" ? "cues" : "cards"
      const items = topics.length ? interleave(topics.map((t) => cardsQueue(s, { topic: t, kinds, scope: "due" }, n)), n) : cardsQueue(s, { kinds, scope: "due" }, n)
      return run(task.title, items, "coach")
    }
    case "notes":
    case "guide":
      return go("notes", { topic: topics[0], guide: task.ref })
    case "exam":
      return go("exam")
    case "mistakes":
      return go("mistakes")
    case "collection": {
      const col = LAB?.config.collections.find((c) => c.id === task.ref)
      if (col) return run(col.name, col.items.filter((x) => (x.kind === "q" ? data().qById.has(x.id) : data().cardById.has(x.id))), "coach")
      return go("practice")
    }
    default:
      return undefined
  }
}

export function planProgress(plan: StudyPlan) {
  let done = 0
  let total = 0
  for (const d of plan.days)
    for (const t of d.tasks) {
      total++
      if (t.done) done++
    }
  return { done, total }
}
