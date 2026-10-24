import { scheduleFsrs } from "@shared/fsrs"
import type { Confidence, SrsRec } from "./types"

/**
 * Scheduling is FSRS-6 (shared/fsrs.ts). Intervals are capped so every item comes back before the
 * exam date, and questions never repeat inside the same day.
 */
export type Grade = 1 | 2 | 3 | 4
export type ItemKind = "c" | "q"

export const nowMin = () => Math.floor(Date.now() / 60000)

export function endOfDayMin(offsetDays = 0): number {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(23, 59, 59, 999)
  return Math.floor(d.getTime() / 60000)
}

export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split("-").map(Number)
  if (!y || !m || !d) return null
  const target = new Date(y, m - 1, d)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}

export function capFromExam(examDate: string | null): number | null {
  const left = daysUntil(examDate)
  if (left == null || left < 2) return null
  return Math.max(1, Math.floor(left * 0.6))
}

export function schedule(prev: SrsRec | undefined, grade: Grade, kind: ItemKind, capDays: number | null, fuzz = true): SrsRec {
  return scheduleFsrs(prev, grade, kind, capDays, fuzz)
}

export function fmtIvl(days: number): string {
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`
  if (days < 1) return `${Math.round(days * 24)}h`
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, "")}mo`
  return `${(days / 365).toFixed(1)}y`
}

export function previewIntervals(prev: SrsRec | undefined, kind: ItemKind, capDays: number | null): string[] {
  return ([1, 2, 3, 4] as Grade[]).map((g) => fmtIvl(schedule(prev, g, kind, capDays, false).i))
}

/**
 * Grade a question for FSRS. A right answer that was guessed, changed, rushed or slow is Hard (known,
 * not yet fluent); "unsure" is Good; "sure" is Good, or Easy when it was also quick.
 */
export function questionGrade(correct: boolean, conf: Confidence, how: { changed?: boolean; rapid?: boolean; slow?: boolean; quick?: boolean } = {}): Grade {
  if (!correct) return 1
  if (conf === 0 || how.changed || how.rapid || how.slow) return 2
  if (conf === 1) return 3
  return how.quick ? 4 : 3
}

export function isDue(rec: SrsRec | undefined, horizon = endOfDayMin()): boolean {
  return !!rec && rec.d <= horizon
}

export type Strength = "new" | "learning" | "review" | "strong"

export function strength(rec: SrsRec | undefined): Strength {
  if (!rec) return "new"
  if (rec.r === 0 || rec.i < 1) return "learning"
  if (rec.i < 7) return "review"
  return "strong"
}

export const STRENGTH_LABEL: Record<Strength, string> = {
  new: "New",
  learning: "Learning",
  review: "Reviewing",
  strong: "Strong",
}
