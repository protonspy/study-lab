import { useMemo, useState } from "react"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Meter } from "@/components/charts"
import { DomainDot } from "@/components/Domain"
import { Pager, usePaged } from "@/components/Pager"
import { data, DOMAINS } from "@/lib/data"
import { run } from "@/lib/nav"
import { STRENGTH_LABEL, strength } from "@/lib/srs"
import { cardsQueue } from "@/lib/stats"
import { useAppState } from "@/lib/store"
import { plural } from "@/lib/text"
import { PageHead, ScopeSelect, scopeLabel, scopeToFilter } from "@/views/ReviewView"

type Kinds = "cards" | "cues" | "all"
type Mode = "due" | "new" | "weak" | "all"

const MODE_LABEL: Record<Mode, string> = {
  due: "Due + new",
  new: "New only",
  weak: "Weak spots",
  all: "Shuffle all",
}

export function CardsView({ kindsDefault = "cards" as Kinds }: { kindsDefault?: Kinds }) {
  const s = useAppState()
  const [scope, setScope] = useState("all")
  const [kinds, setKinds] = useState<Kinds>(kindsDefault)
  const [mode, setMode] = useState<Mode>("due")
  const [size, setSize] = useState("30")
  const [browse, setBrowse] = useState(false)
  const filter = scopeToFilter(scope)
  const queue = useMemo(() => cardsQueue(s, { ...filter, kinds, scope: mode }, Number(size)), [s, scope, kinds, mode, size]) // eslint-disable-line react-hooks/exhaustive-deps

  const decks = useMemo(() => {
    return data().topics.map((t) => {
      const cs = (data().cardsByTopic.get(t.id) ?? []).filter((c) => (kinds === "all" ? true : kinds === "cues" ? c.k === "trigger" : c.k !== "trigger"))
      let seen = 0
      let strong = 0
      for (const c of cs) {
        const r = s.srsc[c.id]
        if (r) {
          seen++
          if (r.i >= 7) strong++
        }
      }
      return { t, total: cs.length, seen, strong }
    })
  }, [s.srsc, kinds]) // eslint-disable-line react-hooks/exhaustive-deps

  const browseList = useMemo(() => {
    if (!browse) return []
    return data().cards.filter(
      (c) =>
        (kinds === "all" || (kinds === "cues" ? c.k === "trigger" : c.k !== "trigger")) &&
        (!filter.topic || c.t === filter.topic) &&
        (!filter.domain || data().topicById.get(c.t)?.d === filter.domain),
    )
  }, [browse, kinds, scope]) // eslint-disable-line react-hooks/exhaustive-deps
  const page = usePaged(browseList, { size: 50, reset: [kinds, scope].join("|") })

  const title = kinds === "cues" ? "Exam cues" : "Flashcards"

  return (
    <div>
      <PageHead eyebrow="Active recall" title={kinds === "cues" ? "Exam cues" : "Flashcards"}>
        {kinds === "cues"
          ? "Scenario phrases mapped to the answer they point to. These are the reflexes the professional exam rewards."
          : "Atomic cards from the lectures and the practice-exam explanations. Answer in your head (or type it) before flipping, then grade honestly."}
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Build a deck</CardTitle>
            <CardDescription>{plural(queue.length, "card")} match.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <label htmlFor="cards-scope" className="text-sm font-medium">
                Scope
              </label>
              <ScopeSelect id="cards-scope" value={scope} onChange={setScope} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Card type</p>
              <ToggleGroup type="single" variant="outline" value={kinds} onValueChange={(v) => v && setKinds(v as Kinds)} className="flex-wrap">
                <ToggleGroupItem value="cards">Flashcards</ToggleGroupItem>
                <ToggleGroupItem value="cues">Exam cues</ToggleGroupItem>
                <ToggleGroupItem value="all">Both</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Which cards</p>
              <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as Mode)} className="flex-wrap">
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <ToggleGroupItem key={m} value={m}>
                    {MODE_LABEL[m]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-xs text-ink-3">
                {mode === "weak"
                  ? "Cards you lapsed on or graded Hard, worst first."
                  : mode === "all"
                    ? "Ignores the schedule. Useful for a final cram; grades still update the schedule."
                    : mode === "new"
                      ? "Only cards you have never seen."
                      : "What is due, topped up with unseen cards."}
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Size</p>
              <ToggleGroup type="single" variant="outline" value={size} onValueChange={(v) => v && setSize(v)}>
                {["15", "30", "60", "120"].map((n) => (
                  <ToggleGroupItem key={n} value={n}>
                    {n}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="lg" disabled={!queue.length} onClick={() => run(`${title} · ${scopeLabel(scope)}`, queue, kinds === "cues" ? "drill" : "cards")}>
                Study {queue.length} <ArrowRight />
              </Button>
              <Button size="lg" variant="outline" onClick={() => setBrowse((b) => !b)}>
                {browse ? "Hide card list" : "Browse cards"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Decks by topic</CardTitle>
            <CardDescription>Strong means the next review is a week or more away.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {DOMAINS.map((d) => (
              <div key={d.n}>
                <p className="mb-1.5 flex items-center gap-2 text-xs font-medium text-ink-2">
                  <DomainDot d={d.n} /> D{d.n} · {d.short} <span className="font-mono text-ink-3">{d.w}%</span>
                </p>
                <div className="flex flex-col divide-y divide-line">
                  {decks
                    .filter((x) => x.t.d === d.n && x.total > 0)
                    .map((x) => (
                      <div key={x.t.id} className="flex items-center gap-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-sm">{x.t.title}</span>
                        <span className="hidden font-mono text-[0.7rem] text-ink-3 tabular sm:inline">
                          {x.strong}/{x.seen}/{x.total}
                        </span>
                        <Meter value={(100 * x.strong) / x.total} className="w-16 sm:w-24" tone="good" />
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => run(`${title} · ${x.t.title}`, cardsQueue(s, { topic: x.t.id, kinds, scope: "due" }, 40), kinds === "cues" ? "drill" : "cards")}
                        >
                          Study
                        </Button>
                      </div>
                    ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-ink-3">Counts read strong / seen / total.</p>
          </CardContent>
        </Card>
      </div>

      {browse && (
        <section className="mt-6">
          <h2 className="mb-3 text-lg font-semibold">
            {plural(browseList.length, "card")} in {scopeLabel(scope)}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {page.rows.map((c) => (
              <div key={c.id} className="rounded-lg border border-line bg-surface p-3.5 text-sm">
                <p className="font-medium">{c.k === "trigger" ? `“${c.f}”` : c.f}</p>
                <p className="mt-1.5 text-ink-2">{c.b}</p>
                <p className="mt-2 text-[0.7rem] text-ink-3">
                  {data().topicById.get(c.t)?.title} · {STRENGTH_LABEL[strength(s.srsc[c.id])]}
                </p>
              </div>
            ))}
          </div>
          <Pager p={page} className="mt-4" />
        </section>
      )}
    </div>
  )
}
