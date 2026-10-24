import { useMemo, useState } from "react"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Meter } from "@/components/charts"
import { shuffled } from "@/lib/actions"
import { data, LAB, PASS_ACC, shortSetName, sourceName, useDataVersion } from "@/lib/data"
import { run } from "@/lib/nav"
import { endOfDayMin, isDue } from "@/lib/srs"
import { useAppState } from "@/lib/store"
import type { AppState, Question } from "@/lib/types"
import { plural } from "@/lib/text"
import { PageHead, ScopeSelect, scopeToFilter } from "@/views/ReviewView"

type Status = "all" | "unseen" | "due" | "wrong" | "confident" | "flagged" | "multi"

const STATUS: { v: Status; label: string }[] = [
  { v: "all", label: "Any" },
  { v: "unseen", label: "Unseen" },
  { v: "due", label: "Due" },
  { v: "wrong", label: "Wrong last time" },
  { v: "confident", label: "Confidently wrong" },
  { v: "flagged", label: "Flagged" },
  { v: "multi", label: "Select-two/three" },
]

function matchStatus(s: AppState, q: Question, st: Status, horizon: number) {
  const r = s.srsq[q.id]
  switch (st) {
    case "unseen":
      return !r
    case "due":
      return isDue(r, horizon)
    case "wrong":
      return !!r && r.la === 0
    case "confident":
      return !!r && r.h > 0
    case "flagged":
      return !!s.meta.flags[q.id]?.on
    case "multi":
      return q.multi
    default:
      return true
  }
}

export function PracticeView() {
  useDataVersion()
  const s = useAppState()
  const [src, setSrc] = useState("all")
  const [set, setSet] = useState("all")
  const [scope, setScope] = useState("all")
  const [status, setStatus] = useState<Status>("all")
  const [count, setCount] = useState("20")
  const [order, setOrder] = useState("random")

  const matches = useMemo(() => {
    const f = scopeToFilter(scope)
    const horizon = endOfDayMin()
    return data().questions.filter(
      (q) =>
        (src === "all" || q.src === src) &&
        (set === "all" || q.set === set) &&
        (!f.domain || q.d === f.domain) &&
        (!f.topic || (data().kb.tags[q.id] ?? []).includes(f.topic)) &&
        matchStatus(s, q, status, horizon),
    )
  }, [s, src, set, scope, status])

  function start() {
    const list = order === "random" ? shuffled(matches) : matches
    const n = count === "all" ? list.length : Number(count)
    run(`Practice · ${plural(Math.min(n, list.length), "question")}`, list.slice(0, n).map((q) => ({ kind: "q" as const, id: q.id })), "practice")
  }

  const sets = data().sets.filter((x) => src === "all" || x.src === src)

  const setStats = useMemo(
    () =>
      data().sets.map((x) => {
        const qs = data().questions.filter((q) => q.set === x.name)
        let seen = 0
        let ok = 0
        for (const q of qs) {
          const r = s.srsq[q.id]
          if (r) {
            seen++
            ok += r.la
          }
        }
        return { ...x, seen, ok }
      }),
    [s.srsq], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <div>
      <PageHead eyebrow="Tutor mode" title="Practice questions">
        {data().questions.length} questions in rotation, including any the coach wrote for you. Answer, rate your confidence, then study why each distractor fails.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Pick a set</CardTitle>
            <CardDescription>{plural(matches.length, "question")} match these filters.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="pr-src" className="text-sm font-medium">
                  Source
                </label>
                <Select
                  value={src}
                  onValueChange={(v) => {
                    setSrc(v)
                    setSet("all")
                  }}
                >
                  <SelectTrigger id="pr-src" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {[...new Set(data().questions.map((q) => q.src))].map((k) => (
                      <SelectItem key={k} value={k}>
                        {sourceName(k)} ({data().questions.filter((q) => q.src === k).length})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pr-set" className="text-sm font-medium">
                  Exam or quiz
                </label>
                <Select value={set} onValueChange={setSet}>
                  <SelectTrigger id="pr-set" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    <SelectItem value="all">All sets</SelectItem>
                    {sets.map((x) => (
                      <SelectItem key={x.name} value={x.name}>
                        {shortSetName(x.name)} ({x.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pr-scope" className="text-sm font-medium">
                Domain or topic
              </label>
              <ScopeSelect id="pr-scope" value={scope} onChange={setScope} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Status</p>
              <ToggleGroup type="single" variant="outline" value={status} onValueChange={(v) => v && setStatus(v as Status)} className="flex-wrap justify-start">
                {STATUS.map((x) => (
                  <ToggleGroupItem key={x.v} value={x.v}>
                    {x.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="flex flex-wrap gap-6">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">How many</p>
                <ToggleGroup type="single" variant="outline" value={count} onValueChange={(v) => v && setCount(v)}>
                  {["10", "20", "40", "all"].map((n) => (
                    <ToggleGroupItem key={n} value={n}>
                      {n === "all" ? "All" : n}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Order</p>
                <ToggleGroup type="single" variant="outline" value={order} onValueChange={(v) => v && setOrder(v)}>
                  <ToggleGroupItem value="random">Shuffled</ToggleGroupItem>
                  <ToggleGroupItem value="original">Original</ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
            <Button size="lg" className="self-start" disabled={!matches.length} onClick={start}>
              Start practice <ArrowRight />
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
        {!!LAB?.config.collections.length && (
          <Card>
            <CardHeader>
              <CardTitle>Practice sets from the coach</CardTitle>
              <CardDescription>Hand-picked questions and cards aimed at a pattern in your mistakes.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-line">
              {LAB.config.collections.map((c) => {
                const items = c.items.filter((x) => (x.kind === "q" ? data().qById.has(x.id) : data().cardById.has(x.id)))
                return (
                  <div key={c.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="line-clamp-1 text-[0.7rem] text-ink-3">
                        {items.length} items{c.why ? ` · ${c.why}` : ""}
                      </p>
                    </div>
                    <Button size="xs" variant="ghost" disabled={!items.length} onClick={() => run(c.name, items, "practice")}>
                      Open
                    </Button>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Sets</CardTitle>
            <CardDescription>Latest-attempt accuracy per exam and quiz.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-line">
            {setStats.map((x) => {
              const acc = x.seen ? Math.round((100 * x.ok) / x.seen) : null
              return (
                <div key={x.name} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{shortSetName(x.name)}</p>
                    <p className="text-[0.7rem] text-ink-3">
                      {sourceName(x.src)} · {x.seen}/{x.count} seen
                      {acc != null ? ` · ${acc}% right` : ""}
                    </p>
                  </div>
                  <Meter value={acc ?? 0} className="w-16 sm:w-24" tone={acc == null ? "ink" : acc >= PASS_ACC ? "good" : acc >= 55 ? "warn" : "bad"} />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      run(
                        `Practice · ${shortSetName(x.name)}`,
                        data()
                          .questions.filter((q) => q.set === x.name)
                          .map((q) => ({ kind: "q" as const, id: q.id })),
                        "practice",
                      )
                    }
                  >
                    Open
                  </Button>
                </div>
              )
            })}
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  )
}
