import type { MainEvent } from "@shared/api"
import type { JobInfo, JobKind, Usage } from "@shared/types"
import { newId } from "./repo"

let broadcast: (e: MainEvent) => void = () => undefined

export function setBroadcaster(fn: (e: MainEvent) => void) {
  broadcast = fn
}

export function emit(e: MainEvent) {
  broadcast(e)
}

interface Running {
  info: JobInfo
  ctrl: AbortController
}

const jobs = new Map<string, Running>()

export interface JobHandle {
  id: string
  signal: AbortSignal
  step(text: string, progress?: number): void
  addUsage(u: { tokensIn: number; tokensOut: number; cost: number }, model: string): void
}

/** Run work in the background, reporting progress to every window. Returns the job id at once. */
export function startJob(labId: string, kind: JobKind, title: string, work: (job: JobHandle) => Promise<void>): string {
  const id = newId("job_")
  const ctrl = new AbortController()
  const info: JobInfo = { id, labId, kind, title, status: "running", step: "Starting…", progress: 0, startedAt: Date.now() }
  jobs.set(id, { info, ctrl })
  const push = () => emit({ type: "job", job: { ...info } })
  const handle: JobHandle = {
    id,
    signal: ctrl.signal,
    step(text, progress) {
      info.step = text
      if (progress != null) info.progress = Math.max(0, Math.min(1, progress))
      push()
    },
    addUsage(u, model) {
      const cur: Usage = info.usage ?? { model, tokensIn: 0, tokensOut: 0, cost: 0 }
      info.usage = { model, tokensIn: cur.tokensIn + u.tokensIn, tokensOut: cur.tokensOut + u.tokensOut, cost: cur.cost + u.cost }
    },
  }
  push()
  void work(handle)
    .then(() => {
      info.status = ctrl.signal.aborted ? "cancelled" : "done"
      info.progress = 1
      if (info.status === "done") info.step = "Done"
    })
    .catch((e: Error) => {
      info.status = ctrl.signal.aborted ? "cancelled" : "error"
      info.error = ctrl.signal.aborted ? undefined : e.message
      info.step = ctrl.signal.aborted ? "Cancelled" : "Failed"
    })
    .finally(() => {
      push()
      // Keep finished jobs around briefly so a window that opens late still sees the result.
      setTimeout(() => jobs.delete(id), 10 * 60_000)
    })
  return id
}

export function cancelJob(id: string) {
  jobs.get(id)?.ctrl.abort()
}

export function listJobs(labId: string): JobInfo[] {
  return [...jobs.values()].filter((j) => j.info.labId === labId).map((j) => ({ ...j.info }))
}

export function isBusy(labId: string, kind: JobKind) {
  return [...jobs.values()].some((j) => j.info.labId === labId && j.info.kind === kind && j.info.status === "running")
}
