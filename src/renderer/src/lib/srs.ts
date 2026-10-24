import type { Confidence, SrsRec } from "./types"

/**
 * SM-2 style scheduler (the algorithm behind Anki), with two changes for exam prep:
 * - intervals are capped so every item comes back at least once before the exam date;
 * - questions never repeat inside the same day (re-reading an answer minutes later only
 *   tests short-term memory), while flashcards relearn after 10 minutes.
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
  const now = nowMin()
  const rec: SrsRec = prev ? { ...prev } : { d: 0, i: 0, e: 250, r: 0, l: 0, s: 0, t: 0 }
  rec.s = (rec.s || 0) + 1
  let ivl: number
  if (grade === 1) {
    if (rec.r > 0) rec.l = (rec.l || 0) + 1
    rec.r = 0
    rec.e = Math.max(130, rec.e - 20)
    ivl = kind === "q" ? 1 : 10 / 1440
  } else {
    const ease = rec.e / 100
    if (rec.r === 0) ivl = grade === 2 ? (kind === "q" ? 1 : 0.5) : grade === 3 ? 1 : 3
    else if (rec.r === 1) ivl = grade === 2 ? 2 : grade === 3 ? 3 : 5
    else if (grade === 2) ivl = Math.max(1, rec.i * 1.2)
    else if (grade === 3) ivl = Math.max(rec.i + 1, rec.i * ease)
    else ivl = Math.max(rec.i + 2, rec.i * ease * 1.3)
    if (grade === 2) rec.e = Math.max(130, rec.e - 15)
    if (grade === 4) rec.e = Math.min(320, rec.e + 15)
    rec.r += 1
  }
  if (fuzz && ivl >= 3) ivl *= 0.95 + Math.random() * 0.1
  if (capDays != null && ivl > capDays) ivl = capDays
  rec.i = Math.round(ivl * 100) / 100
  rec.d = now + Math.round(ivl * 1440)
  rec.g = grade
  rec.t = now
  return rec
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

/** Grade a question from correctness and stated confidence. */
export function questionGrade(correct: boolean, conf: Confidence): Grade {
  if (!correct) return 1
  return conf === 2 ? 3 : 2
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
