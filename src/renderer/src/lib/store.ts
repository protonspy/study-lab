import { useSyncExternalStore } from "react"
import { defaultState } from "@shared/defaults"
import type { AppState, Section, StudyEvent } from "./types"

/*
  Progress for the open lab lives in memory and is written to the app's SQLite database through
  the main process: SRS records and notes as changed rows, the meta document whole (debounced),
  and every attempt appended to the event log that powers analytics and the coach.
*/

const api = () => window.studyLab.api

let labId: string | null = null
let state: AppState = defaultState()
const listeners = new Set<() => void>()

let batching = 0
let pendingEmit = false

function emit() {
  if (batching) {
    pendingEmit = true
    return
  }
  for (const fn of listeners) fn()
}

/** Group several mutations into one re-render. */
export function batch(fn: () => void) {
  batching++
  try {
    fn()
  } finally {
    batching--
    if (!batching && pendingEmit) {
      pendingEmit = false
      emit()
    }
  }
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getState(): AppState {
  return state
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState, getState)
}

export function currentLabId(): string {
  if (!labId) throw new Error("No lab is open")
  return labId
}

/* ---------- saving ---------- */

type Pending = { set: Record<string, unknown>; del: Set<string> }
const fresh = (): Pending => ({ set: {}, del: new Set() })
const pending: Record<"srsq" | "srsc" | "notes", Pending> = { srsq: fresh(), srsc: fresh(), notes: fresh() }
let metaDirty = false
let events: StudyEvent[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let saveError: string | null = null
const errListeners = new Set<() => void>()

function setSaveError(e: string | null) {
  if (e === saveError) return
  saveError = e
  for (const fn of errListeners) fn()
}

export function useSaveError() {
  return useSyncExternalStore(
    (fn) => {
      errListeners.add(fn)
      return () => errListeners.delete(fn)
    },
    () => saveError,
    () => saveError,
  )
}

function queueSave() {
  clearTimeout(timer)
  timer = setTimeout(() => void flush(), 400)
}

/** Write everything pending now. Safe to call often. */
export async function flush() {
  clearTimeout(timer)
  if (!labId) return
  const id = labId
  const jobs: Promise<unknown>[] = []
  for (const sec of ["srsq", "srsc", "notes"] as const) {
    const p = pending[sec]
    if (!Object.keys(p.set).length && !p.del.size) continue
    pending[sec] = fresh()
    jobs.push(api().saveState(id, sec, { set: p.set, del: [...p.del] }))
  }
  if (metaDirty) {
    metaDirty = false
    jobs.push(api().saveState(id, "meta", { whole: state.meta }))
  }
  if (events.length) {
    const evs = events
    events = []
    jobs.push(api().addEvents(id, evs))
  }
  try {
    await Promise.all(jobs)
    setSaveError(null)
  } catch (e) {
    setSaveError((e as Error).message)
  }
}

/** Apply a change to one section. The section object is replaced so memoized views recompute. */
export function mutate<K extends Section>(sec: K, fn: (draft: AppState[K], whole: AppState) => void) {
  const before = state[sec] as Record<string, unknown>
  const draft = (sec === "meta" ? structuredClone(state.meta) : { ...state[sec] }) as AppState[K]
  fn(draft, state)
  state = { ...state, [sec]: draft }
  if (sec === "meta") metaDirty = true
  else {
    const p = pending[sec as "srsq" | "srsc" | "notes"]
    const d = draft as Record<string, unknown>
    for (const k of Object.keys(d)) {
      if (d[k] === before[k]) continue
      p.set[k] = d[k]
      p.del.delete(k)
    }
    for (const k of Object.keys(before)) {
      if (k in d) continue
      p.del.add(k)
      delete p.set[k]
    }
  }
  emit()
  queueSave()
}

export function logEvent(e: StudyEvent) {
  events.push(e)
  queueSave()
}

/* ---------- lab lifecycle ---------- */

export function loadLabState(id: string, s: AppState) {
  labId = id
  state = s
  pending.srsq = fresh()
  pending.srsc = fresh()
  pending.notes = fresh()
  metaDirty = false
  events = []
  emit()
}

/** The coach changed study settings in the database: take its version of the settings. */
export async function reloadSettings() {
  if (!labId) return
  await flush()
  const latest = await api().loadState(labId)
  state = { ...state, meta: { ...state.meta, settings: latest.meta.settings } }
  emit()
}

export async function closeLabState() {
  await flush()
  labId = null
  state = defaultState()
  emit()
}

export async function resetAll() {
  if (!labId) return
  await flush()
  await api().resetProgress(labId)
  const keep = state.meta.settings
  state = defaultState()
  state.meta.settings = keep
  emit()
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void flush())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush()
  })
}
