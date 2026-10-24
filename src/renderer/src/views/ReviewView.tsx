import { useMemo, useState } from "react"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DomainDot } from "@/components/Domain"
import { data, DOMAINS, domainOf } from "@/lib/data"
import { run } from "@/lib/nav"
import { buildDaily, dueSummary, forecast } from "@/lib/stats"
import { useAppState } from "@/lib/store"
import { plural } from "@/lib/text"

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-6">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="mt-1.5 text-3xl font-semibold sm:text-4xl">{title}</h1>
      {children && <div className="mt-2 max-w-2xl text-ink-2">{children}</div>}
    </header>
  )
}

export function ScopeSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full sm:w-80">
        <SelectValue placeholder="Everything" />
      </SelectTrigger>
      <SelectContent className="max-h-96">
        <SelectItem value="all">Everything</SelectItem>
        <SelectGroup>
          <SelectLabel>Domains</SelectLabel>
          {DOMAINS.map((d) => (
            <SelectItem key={d.n} value={`d:${d.n}`}>
              <DomainDot d={d.n} /> D{d.n} · {d.short}
            </SelectItem>
          ))}
        </SelectGroup>
        {DOMAINS.map((d) => (
          <SelectGroup key={d.n}>
            <SelectLabel>D{d.n} topics</SelectLabel>
            {data()
              .topics.filter((t) => t.d === d.n)
              .map((t) => (
                <SelectItem key={t.id} value={`t:${t.id}`}>
                  {t.title}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

export function scopeToFilter(v: string): { domain?: number; topic?: string } {
  if (v.startsWith("d:")) return { domain: Number(v.slice(2)) }
  if (v.startsWith("t:")) return { topic: v.slice(2) }
  return {}
}

export function scopeLabel(v: string) {
  if (v.startsWith("d:")) return domainOf(Number(v.slice(2)))?.short ?? "Domain"
  if (v.startsWith("t:")) return data().topicById.get(v.slice(2))?.title ?? "Topic"
  return "Everything"
}

export function ReviewView() {
  const s = useAppState()
  const [scope, setScope] = useState("all")
  const due = useMemo(() => dueSummary(s), [s])
  const fc = useMemo(() => forecast(s, 7), [s.srsc, s.srsq]) // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(1, ...fc)
  const preview = useMemo(() => buildDaily(s, scopeToFilter(scope)), [s, scope])
  const nCards = preview.filter((i) => i.kind === "c").length

  return (
    <div>
      <PageHead eyebrow="Spaced repetition" title="Daily review">
        One interleaved session of what is due today plus a measured dose of new material. Do it every day; consistency matters more than
        session length.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Today's session</CardTitle>
            <CardDescription>
              {plural(preview.length, "item")}: {plural(nCards, "card")} and {plural(preview.length - nCards, "question")}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <label htmlFor="review-scope" className="text-sm font-medium">
                Scope
              </label>
              <ScopeSelect id="review-scope" value={scope} onChange={setScope} />
              <p className="text-xs text-ink-3">Narrowing the scope adds new material from that area even past today's limits.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="lg" disabled={!preview.length} onClick={() => run(scope === "all" ? "Daily review" : `Review · ${scopeLabel(scope)}`, preview, "review")}>
                Start <ArrowRight />
              </Button>
            </div>
            <dl className="grid grid-cols-3 gap-3 border-t border-line pt-4 text-sm">
              <div>
                <dt className="text-xs text-ink-3">Due cards</dt>
                <dd className="text-lg font-semibold tabular">{due.cards}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Due cues</dt>
                <dd className="text-lg font-semibold tabular">{due.cues}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Due questions</dt>
                <dd className="text-lg font-semibold tabular">{due.qs}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Unseen cards</dt>
                <dd className="text-lg font-semibold tabular">{due.newCards.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Unseen cues</dt>
                <dd className="text-lg font-semibold tabular">{due.newCues.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Unseen questions</dt>
                <dd className="text-lg font-semibold tabular">{due.newQs}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Coming up</CardTitle>
            <CardDescription>Reviews scheduled for the next seven days.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex h-40 items-end gap-2" role="img" aria-label="Reviews due per day for the next seven days">
              {fc.map((n, i) => {
                const d = new Date()
                d.setDate(d.getDate() + i)
                return (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
                    <span className="font-mono text-[0.7rem] text-ink-2 tabular">{n}</span>
                    <div className="w-full max-w-6 rounded-t-[4px] bg-[var(--d1)]" style={{ height: `${Math.max(2, (n / max) * 100)}px` }} />
                    <span className="text-[0.68rem] text-ink-3">{i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
