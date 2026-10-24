import { createEmptyCard, forgetting_curve, FSRS6_DEFAULT_DECAY, fsrs, generatorParameters, State, type Card, type Grade } from "ts-fsrs"
import type { SrsRec } from "./types"

/*
  Item memory with FSRS-6 (ts-fsrs, default parameters). Records keep the app's compact SrsRec shape
  so every view keeps working; the FSRS state rides along in `fs`. Records written by the old SM-2
  scheduler are converted the first time they are reviewed.
*/

export type ItemKind = "c" | "q"

const DAY_MS = 86_400_000

function scheduler(kind: ItemKind, capDays: number | null, fuzz: boolean) {
  return fsrs(
    generatorParameters({
      request_retention: 0.9,
      maximum_interval: capDays ?? 36_500,
      enable_fuzz: fuzz,
      // Questions never come back the same day (re-reading an answer minutes later only tests short-term memory);
      // flashcards use FSRS's short learning steps.
      enable_short_term: kind === "c",
    }),
  )
}

/** Rebuild an FSRS card from a stored record (FSRS or legacy SM-2). */
export function toCard(rec: SrsRec | undefined, nowMs: number): Card {
  if (!rec) return createEmptyCard(new Date(nowMs))
  if (rec.fs)
    return {
      due: new Date(rec.d * 60_000),
      stability: rec.fs.s,
      difficulty: rec.fs.df,
      elapsed_days: 0,
      scheduled_days: Math.round(rec.i),
      learning_steps: rec.fs.ls,
      reps: rec.s,
      lapses: rec.l,
      state: rec.fs.st as State,
      last_review: new Date(rec.fs.lr),
    }
  // Legacy SM-2: interval ≈ stability, ease 130–320 → difficulty 10–1.
  const reviewed = rec.r > 0 && rec.i >= 1
  return {
    due: new Date(rec.d * 60_000),
    stability: Math.max(0.5, rec.i),
    difficulty: Math.min(10, Math.max(1, 10 - ((rec.e - 130) / 190) * 9)),
    elapsed_days: 0,
    scheduled_days: Math.round(rec.i),
    learning_steps: 0,
    reps: rec.s,
    lapses: rec.l,
    state: reviewed ? State.Review : rec.s ? State.Relearning : State.New,
    last_review: rec.t ? new Date(rec.t * 60_000) : undefined,
  }
}

export function scheduleFsrs(prev: SrsRec | undefined, grade: Grade, kind: ItemKind, capDays: number | null, fuzz = true, nowMs = Date.now()): SrsRec {
  const next = scheduler(kind, capDays, fuzz).next(toCard(prev, nowMs), new Date(nowMs), grade).card
  const nowMin = Math.floor(nowMs / 60_000)
  // ts-fsrs keeps Easy above Good even past maximum_interval; the exam cap is a hard limit here.
  let dueMin = Math.max(nowMin + 1, Math.floor(next.due.getTime() / 60_000))
  if (capDays != null) dueMin = Math.min(dueMin, nowMin + Math.round(capDays * 1440))
  return {
    d: dueMin,
    i: Math.round(((dueMin - nowMin) / 1440) * 100) / 100,
    // Ease mirrors difficulty for views written for SM-2.
    e: Math.round(130 + ((10 - next.difficulty) / 9) * 190),
    r: grade > 1 ? (prev?.r ?? 0) + 1 : 0,
    l: next.lapses,
    s: (prev?.s ?? 0) + 1,
    g: grade,
    t: nowMin,
    fs: { s: next.stability, df: next.difficulty, st: next.state, ls: next.learning_steps, lr: nowMs },
  }
}

/** Probability of recalling the item at a given time (FSRS-6 forgetting curve). */
export function retrievability(rec: SrsRec | undefined, atMs = Date.now()): number | null {
  if (!rec) return null
  const card = toCard(rec, atMs)
  if (card.state === State.New || !card.last_review) return null
  const elapsed = Math.max(0, (atMs - card.last_review.getTime()) / DAY_MS)
  return forgetting_curve(FSRS6_DEFAULT_DECAY, elapsed, Math.max(0.01, card.stability))
}

export function stabilityOf(rec: SrsRec | undefined): number {
  if (!rec) return 0
  return rec.fs?.s ?? Math.max(0.5, rec.i)
}
