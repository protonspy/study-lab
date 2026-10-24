import { useMemo, useState } from "react"
import { ChevronDown, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DomainLabel } from "@/components/Domain"
import { MISTAKE_REASONS, QuestionCard } from "@/components/QuestionCard"
import { data } from "@/lib/data"
import { run } from "@/lib/nav"
import { useAppState } from "@/lib/store"
import { excerpt, plural } from "@/lib/text"
import { cn } from "@/lib/utils"
import { PageHead, ScopeSelect, scopeToFilter } from "@/views/ReviewView"

type State = "open" | "fixed" | "all"

const ADVICE: Record<string, string> = {
  gap: "Knowledge gaps: open the topic notes and run its flashcards before retrying.",
  constraint: "Misread constraints: before looking at options, name what the question optimizes (cost, latency, overhead, compliance).",
  confused: "Confused services: drill the exam cues for that domain; they train the distinctions.",
  overthought: "Overthinking: the simplest managed service that meets every stated requirement is usually right. Don't add requirements.",
  careless: "Careless slips: on select-two questions, re-check you picked exactly two, and re-read the last sentence of the stem.",
}

export function MistakesView() {
  const s = useAppState()
  const [state, setState] = useState<State>("open")
  const [reason, setReason] = useState("all")
  const [scope, setScope] = useState("all")
  const [open, setOpen] = useState<string | null>(null)

  const rows = useMemo(() => {
    const f = scopeToFilter(scope)
    return Object.entries(s.meta.mistakes)
      .map(([id, m]) => ({ id, m, q: data().qById.get(id), r: s.srsq[id] }))
      .filter((x) => x.q && x.r)
      .filter((x) => (state === "open" ? x.r!.la === 0 : state === "fixed" ? x.r!.la === 1 : true))
      .filter((x) => (reason === "all" ? true : reason === "none" ? !x.m.cat : x.m.cat === reason))
      .filter((x) => (!f.domain || x.q!.d === f.domain) && (!f.topic || (data().kb.tags[x.id] ?? []).includes(f.topic)))
      .sort((a, b) => b.r!.h - a.r!.h || b.m.at - a.m.at)
  }, [s, state, reason, scope])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    let open = 0
    let confident = 0
    for (const [id, m] of Object.entries(s.meta.mistakes)) {
      const r = s.srsq[id]
      if (!r) continue
      if (r.la === 0) open++
      if (r.h > 0 && r.la === 0) confident++
      c[m.cat ?? "none"] = (c[m.cat ?? "none"] ?? 0) + 1
    }
    return { c, open, confident, total: Object.keys(s.meta.mistakes).length }
  }, [s.meta.mistakes, s.srsq])

  const top = MISTAKE_REASONS.map((r) => ({ ...r, n: counts.c[r.id] ?? 0 })).sort((a, b) => b.n - a.n)[0]
  const maxN = Math.max(1, ...MISTAKE_REASONS.map((r) => counts.c[r.id] ?? 0), counts.c.none ?? 0)

  return (
    <div>
      <PageHead eyebrow="Error log" title="Mistakes">
        Every question you have missed, confident misses first. A mistake you understand is worth more than three questions you got right.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>
              {plural(counts.open, "question")} still wrong
            </CardTitle>
            <CardDescription>
              {counts.confident} confident misses · {counts.total - counts.open} fixed since
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button
              className="self-start"
              disabled={!counts.open}
              onClick={() =>
                run(
                  "Retry mistakes",
                  Object.keys(s.meta.mistakes)
                    .filter((id) => s.srsq[id]?.la === 0)
                    .sort((a, b) => (s.srsq[b]?.h ?? 0) - (s.srsq[a]?.h ?? 0))
                    .slice(0, 40)
                    .map((id) => ({ kind: "q" as const, id })),
                  "mistakes",
                )
              }
            >
              <RotateCcw /> Retry up to 40 now
            </Button>
            <p className="text-xs text-ink-3">Retrying the same day mostly tests short-term memory. The scheduler brings each one back tomorrow anyway.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Why you miss</CardTitle>
            <CardDescription>Tag each miss in the feedback panel; patterns show here.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {[...MISTAKE_REASONS, { id: "none", label: "Not tagged yet" }].map((r) => {
              const n = counts.c[r.id] ?? 0
              return (
                <div key={r.id} className="grid grid-cols-[10rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-sm">
                  <span className="truncate text-ink-2">{r.label}</span>
                  <div className="relative h-2 rounded-full bg-surface-2">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${(100 * n) / maxN}%` }} />
                  </div>
                  <span className="text-right font-mono text-xs tabular">{n}</span>
                </div>
              )
            })}
            {top && top.n > 0 && <p className="mt-2 rounded-md bg-marker-soft px-3 py-2 text-sm">{ADVICE[top.id]}</p>}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
        <ToggleGroup type="single" variant="outline" value={state} onValueChange={(v) => v && setState(v as State)}>
          <ToggleGroupItem value="open">Still wrong</ToggleGroupItem>
          <ToggleGroupItem value="fixed">Fixed</ToggleGroupItem>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" value={reason} onValueChange={(v) => v && setReason(v)} className="flex-wrap justify-start">
          <ToggleGroupItem value="all">Any reason</ToggleGroupItem>
          {MISTAKE_REASONS.map((r) => (
            <ToggleGroupItem key={r.id} value={r.id}>
              {r.label}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value="none">Untagged</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="mt-3">
        <ScopeSelect id="mistake-scope" value={scope} onChange={setScope} />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {rows.map(({ id, m, q, r }) => (
          <div key={id} className="rounded-lg border border-line bg-surface">
            <button type="button" className="flex w-full items-start gap-3 px-3.5 py-3 text-left" onClick={() => setOpen((o) => (o === id ? null : id))} aria-expanded={open === id}>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <DomainLabel d={q!.d} />
                  <span>
                    wrong {r!.w}× · right {r!.c}×
                  </span>
                  {r!.h > 0 && <span className="rounded-full bg-bad-bg px-2 py-0.5 text-bad">confident miss</span>}
                  {m.cat && <span className="rounded-full bg-surface-2 px-2 py-0.5">{MISTAKE_REASONS.find((x) => x.id === m.cat)?.label}</span>}
                  <span>{new Date(m.at).toLocaleDateString()}</span>
                </span>
                <span className="mt-1 block text-sm">{excerpt(q!.stem, 200)}</span>
              </span>
              <ChevronDown className={cn("mt-1 size-4 shrink-0 text-ink-3 transition-transform", open === id && "rotate-180")} />
            </button>
            {open === id && (
              <div className="flex flex-col gap-3 border-t border-line px-3.5 py-4">
                <p className="text-xs text-ink-3">Your last answer is marked below.</p>
                <QuestionCard q={q!} mode="review" reviewPicks={r!.lp ?? []} order={q!.opts.map((_, i) => i)} />
                <Button variant="outline" className="self-start" onClick={() => run("Retry", [{ kind: "q", id }], "mistakes")}>
                  <RotateCcw /> Retry this question
                </Button>
              </div>
            )}
          </div>
        ))}
        {!rows.length && <p className="py-10 text-center text-sm text-ink-3">No mistakes in this view.</p>}
      </div>
    </div>
  )
}
