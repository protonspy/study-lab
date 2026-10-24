import { useSyncExternalStore } from "react"
import type { MainEvent } from "@shared/api"
import { clearLab, LAB, setContent, setLabInfo } from "./data"
import { go } from "./nav"
import { closeLabState, flush, loadLabState, reloadSettings } from "./store"
import type { ChatMessage, JobInfo, LabConfig, LabInfo } from "./types"

/* The open lab, background jobs and the push events that keep the window in sync with the main process. */

export const api = () => window.studyLab.api

let openId: string | null = null
const openListeners = new Set<() => void>()

function emitOpen() {
  for (const fn of openListeners) fn()
}

export function useOpenLab(): string | null {
  return useSyncExternalStore(
    (fn) => {
      openListeners.add(fn)
      return () => openListeners.delete(fn)
    },
    () => openId,
    () => openId,
  )
}

export async function openLab(id: string) {
  if (openId) await closeLab()
  const r = await api().openLab(id)
  setLabInfo(r.lab)
  setContent(r.content)
  loadLabState(id, r.state)
  openId = id
  try {
    localStorage.setItem("study-lab:last", id)
  } catch {
    /* storage may be unavailable */
  }
  for (const j of await api().jobs(id)) setJob(j)
  go("today")
  emitOpen()
}

export async function closeLab() {
  await closeLabState()
  clearLab()
  openId = null
  try {
    localStorage.removeItem("study-lab:last")
  } catch {
    /* storage may be unavailable */
  }
  emitOpen()
}

export function lastLabId(): string | null {
  try {
    return localStorage.getItem("study-lab:last")
  } catch {
    return null
  }
}

export async function reloadContent() {
  if (!openId) return
  const r = await api().getContent(openId)
  setLabInfo(r.lab)
  setContent(r.content)
}

/** Save a change to the open lab's setup and apply it at once. */
export async function updateLabConfig(patch: { name?: string; description?: string; kind?: LabInfo["kind"]; config?: Partial<LabConfig> }) {
  if (!openId) return
  const lab = await api().updateLab(openId, patch)
  setLabInfo(lab)
}

/* ---------- coach records: a version counter views can depend on ---------- */

let coachVersion = 0
const coachListeners = new Set<() => void>()
export function bumpCoach() {
  coachVersion++
  for (const fn of coachListeners) fn()
}
export function useCoachVersion() {
  return useSyncExternalStore(
    (fn) => {
      coachListeners.add(fn)
      return () => coachListeners.delete(fn)
    },
    () => coachVersion,
    () => coachVersion,
  )
}

/* ---------- jobs ---------- */

let jobs: Record<string, JobInfo> = {}
const jobListeners = new Set<() => void>()
const jobDone = new Map<string, ((j: JobInfo) => void)[]>()

function setJob(j: JobInfo) {
  jobs = { ...jobs, [j.id]: j }
  for (const fn of jobListeners) fn()
  if (j.status !== "running") {
    for (const fn of jobDone.get(j.id) ?? []) fn(j)
    jobDone.delete(j.id)
  }
}

export function useJobs(): JobInfo[] {
  const all = useSyncExternalStore(
    (fn) => {
      jobListeners.add(fn)
      return () => jobListeners.delete(fn)
    },
    () => jobs,
    () => jobs,
  )
  return Object.values(all)
    .filter((j) => j.labId === openId)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Resolve when the job finishes (immediately if it already did). */
export function whenJobDone(id: string): Promise<JobInfo> {
  const j = jobs[id]
  if (j && j.status !== "running") return Promise.resolve(j)
  return new Promise((resolve) => jobDone.set(id, [...(jobDone.get(id) ?? []), resolve]))
}

/* ---------- chat stream ---------- */

const chatListeners = new Set<(threadId: string, m: ChatMessage) => void>()
export function onChat(fn: (threadId: string, m: ChatMessage) => void) {
  chatListeners.add(fn)
  return () => {
    chatListeners.delete(fn)
  }
}

/* ---------- push events from main ---------- */

export function startEventBridge() {
  return window.studyLab.onEvent(async (e: MainEvent) => {
    if (e.type === "job") setJob(e.job)
    else if (e.type === "chat") {
      if (e.labId === openId) for (const fn of chatListeners) fn(e.threadId, e.message)
    } else if (e.type === "lab-changed" && e.labId === openId) {
      if (e.what.includes("content") || e.what.includes("config")) {
        await flush()
        await reloadContent()
      }
      if (e.what.includes("state")) await reloadSettings()
      if (e.what.includes("plans") || e.what.includes("insights") || e.what.includes("content") || e.what.includes("config")) bumpCoach()
    }
  })
}

export function labName() {
  return LAB?.name ?? "Study Lab"
}
