import type { ErrorType } from "./learner"
import type { KnowledgeGraph } from "./types"

/* Data contracts for the Performance, Timeline and Concept-map views, plus small pure helpers. */

export interface MeterRow {
  id: string
  name: string
  mastery: number | null
  sd: number | null
  /** mastery 14 days ago (self-referenced comparison) */
  ghost: number | null
  attempts: number
  items: number
  weight: number
}

export interface PerformanceData {
  topicLevel: boolean
  scale: { min: number; max: number; pass: number } | null
  predicted: { score: number; low: number; high: number; probPass: number | null } | null
  /** 20 equally likely exam scores (quantile dotplot) */
  quantiles: number[]
  target: number
  domains: (MeterRow & { d: number; topics: (MeterRow & { kcs: (MeterRow & { readiness: number })[] })[] })[]
  retention: { date: string; mean: number; p10: number; p90: number }[]
  examDate: string | null
  calibration: { conf: "guess" | "unsure" | "sure"; stated: number; n: number; acc: number | null; lo: number | null; hi: number | null }[]
  brier: number | null
  bias: number | null
  speed: { topic: string; title: string; medianSec: number; accuracy: number; n: number; rapid: number }[]
  paceSec: number | null
  errors: Record<ErrorType, number>
  actions: { label: string; why: string; kcs: string[]; topics: string[]; reason: string }[]
}

export interface TimelineData {
  scale: { min: number; max: number; pass: number } | null
  days: { date: string; review: number; practice: number; exam: number; cards: number; minutes: number; accuracy: number | null }[]
  trend: { date: string; score: number; low: number; high: number }[]
  mocks: { date: string; at: number; score: number; label: string }[]
  milestones: { date: string; at: number; kind: "mastered" | "resolved" | "coach" | "plan"; label: string; ref?: string }[]
  plan: { date: string; status: "done" | "partial" | "missed" | "upcoming" }[]
  slope: { d: number; name: string; before: number | null; now: number | null }[]
}

export interface GraphViewData {
  graph: KnowledgeGraph
  topics: { id: string; title: string; d: number }[]
  domains: { n: number; name: string; short: string; w: number }[]
  stats: Record<string, { mastery: number; sd: number; readiness: number; items: number; attempts: number; weight: number; errors: Record<ErrorType, number>; misconceptions: number }>
}

/** Inverse of the standard normal CDF (Acklam's approximation). */
export function probit(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) return -probit(1 - p)
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** n equally likely values of a normal distribution, for a quantile dotplot. */
export function quantileDots(mean: number, sd: number, n = 20): number[] {
  return Array.from({ length: n }, (_, i) => mean + sd * probit((i + 0.5) / n))
}

/** Wilson score interval for a proportion. */
export function wilson(k: number, n: number, z = 1.64): [number, number] | null {
  if (!n) return null
  const p = k / n
  const den = 1 + (z * z) / n
  const mid = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return [Math.max(0, mid - half), Math.min(1, mid + half)]
}
