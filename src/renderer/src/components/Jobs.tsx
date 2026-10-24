import { CheckCircle2, CircleAlert, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api, useJobs, whenJobDone } from "@/lib/lab"
import { go } from "@/lib/nav"
import type { JobInfo, JobKind } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Progress strip for the coach's background work of the given kinds (most recent first). */
export function JobStrip({ kinds, className }: { kinds: JobKind[]; className?: string }) {
  const jobs = useJobs().filter((j) => kinds.includes(j.kind))
  const running = jobs.filter((j) => j.status === "running")
  const last = jobs.find((j) => j.status !== "running")
  const shown = running.length ? running : last && Date.now() - last.startedAt < 15 * 60_000 ? [last] : []
  if (!shown.length) return null
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {shown.map((j) => (
        <JobRow key={j.id} job={j} />
      ))}
    </div>
  )
}

function JobRow({ job }: { job: JobInfo }) {
  const running = job.status === "running"
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm",
        job.status === "error" ? "border-bad/40 bg-bad-bg" : job.status === "done" ? "border-good/30 bg-good-bg" : "border-line bg-surface",
      )}
    >
      {running ? <Loader2 className="size-4 shrink-0 animate-spin" /> : job.status === "error" ? <CircleAlert className="size-4 shrink-0 text-bad" /> : <CheckCircle2 className="size-4 shrink-0 text-good" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{job.title}</p>
        <p className="truncate text-xs text-ink-2">{job.status === "error" ? job.error : job.step}</p>
        {running && (
          <div className="mt-1.5 h-1 rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-ink transition-all" style={{ width: `${Math.max(4, job.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {job.usage && <span className="shrink-0 font-mono text-[0.7rem] text-ink-3 tabular">${job.usage.cost.toFixed(4)}</span>}
      {running && (
        <Button variant="ghost" size="icon" className="size-7" onClick={() => void api().cancelJob(job.id)} aria-label="Cancel">
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}

/** Start a coach job and toast when it ends. Returns the job id, or null when it could not start. */
export async function startCoachJob(labId: string, kind: Exclude<JobKind, "chat">, opts: Parameters<ReturnType<typeof api>["runJob"]>[2] = {}, done?: (j: JobInfo) => void) {
  const ai = await api().aiSettings()
  if (!ai.hasKey) {
    toast.error("Add your OpenRouter key first.", { action: { label: "Open settings", onClick: () => go("settings", { tab: "ai" }) } })
    return null
  }
  try {
    const id = await api().runJob(labId, kind, opts)
    void whenJobDone(id).then((j) => {
      if (j.status === "done") toast.success(`${j.title}: done${j.usage ? ` ($${j.usage.cost.toFixed(4)})` : ""}`)
      else if (j.status === "error") toast.error(`${j.title} failed: ${j.error}`)
      done?.(j)
    })
    return id
  } catch (e) {
    toast.error((e as Error).message)
    return null
  }
}
