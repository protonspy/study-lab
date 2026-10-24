import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Play, RotateCcw, X, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TopicChip } from "@/components/Domain"
import { recordCard, shuffled } from "@/lib/actions"
import { data } from "@/lib/data"
import { endOfDayMin, isDue } from "@/lib/srs"
import { getState, useAppState } from "@/lib/store"
import { LETTERS } from "@/lib/text"
import type { Card as StudyCard } from "@/lib/types"
import { cn } from "@/lib/utils"
import { CardsView } from "@/views/CardsView"
import { PageHead, ScopeSelect, scopeToFilter } from "@/views/ReviewView"

interface Round {
  cue: StudyCard
  options: string[]
  answer: number
}

/** Distractors come from other cues in the same domain, so the choice forces real discrimination. */
function buildRounds(scope: string, n: number): Round[] {
  const s = getState()
  const f = scopeToFilter(scope)
  const all = data().cards.filter((c) => c.k === "trigger")
  const pool = all.filter((c) => {
    const t = data().topicById.get(c.t)
    if (f.topic) return c.t === f.topic
    if (f.domain) return t?.d === f.domain
    return true
  })
  const horizon = endOfDayMin()
  const due = pool.filter((c) => isDue(s.srsc[c.id], horizon))
  const rest = shuffled(pool.filter((c) => !isDue(s.srsc[c.id], horizon)))
  const chosen = [...shuffled(due), ...rest].slice(0, n)
  return chosen.map((cue) => {
    const d = data().topicById.get(cue.t)?.d
    const sameDomain = all.filter((c) => c.id !== cue.id && c.b !== cue.b && data().topicById.get(c.t)?.d === d)
    const distractors = shuffled(sameDomain.length >= 3 ? sameDomain : all.filter((c) => c.id !== cue.id))
      .map((c) => c.b)
      .filter((b, i, arr) => arr.indexOf(b) === i)
      .slice(0, 3)
    const options = shuffled([cue.b, ...distractors])
    return { cue, options, answer: options.indexOf(cue.b) }
  })
}

export function DrillView() {
  return (
    <div>
      <PageHead eyebrow="Scenario reflexes" title="Exam cues">
        The exam hides its answer in the constraint. Train the reflex from “phrase in the scenario” to “service or pattern to pick”, at speed.
      </PageHead>
      <Tabs defaultValue="speed">
        <TabsList>
          <TabsTrigger value="speed">Speed match</TabsTrigger>
          <TabsTrigger value="recall">Recall deck</TabsTrigger>
        </TabsList>
        <TabsContent value="speed" className="mt-5">
          <SpeedMatch />
        </TabsContent>
        <TabsContent value="recall" className="mt-5">
          <CardsView kindsDefault="cues" />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SpeedMatch() {
  useAppState()
  const [scope, setScope] = useState("all")
  const [len, setLen] = useState("20")
  const [rounds, setRounds] = useState<Round[] | null>(null)
  const [i, setI] = useState(0)
  const [pick, setPick] = useState<number | null>(null)
  const [score, setScore] = useState({ ok: 0, bad: 0 })
  const [misses, setMisses] = useState<Round[]>([])
  const t0 = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const poolSize = useMemo(() => buildRounds(scope, 1000).length, [scope])

  const round = rounds?.[i]
  const finished = rounds && i >= rounds.length

  useEffect(() => {
    if (!rounds || finished) return
    const t = setInterval(() => setElapsed(Date.now() - t0.current), 250)
    return () => clearInterval(t)
  }, [rounds, finished])

  function start() {
    setRounds(buildRounds(scope, Number(len)))
    setI(0)
    setPick(null)
    setScore({ ok: 0, bad: 0 })
    setMisses([])
    t0.current = Date.now()
    setElapsed(0)
  }

  function choose(k: number) {
    if (!round || pick != null) return
    setPick(k)
    const ok = k === round.answer
    setScore((sc) => ({ ok: sc.ok + (ok ? 1 : 0), bad: sc.bad + (ok ? 0 : 1) }))
    if (!ok) setMisses((m) => [...m, round])
    recordCard(round.cue, ok ? 3 : 1, 8)
  }

  function next() {
    setPick(null)
    setI((x) => x + 1)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!round) return
      const k = e.key.toUpperCase()
      const idx = "1234".indexOf(k) >= 0 ? "1234".indexOf(k) : LETTERS.slice(0, 4).indexOf(k)
      if (pick == null && idx >= 0) {
        e.preventDefault()
        choose(idx)
      } else if (pick != null && (e.key === "Enter" || e.key === " " || k === "N")) {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (!rounds) {
    return (
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Speed match</CardTitle>
          <CardDescription>Read the cue, pick the answer from four. Distractors come from the same domain. Due cues are served first.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <label htmlFor="drill-scope" className="text-sm font-medium">
              Scope
            </label>
            <ScopeSelect id="drill-scope" value={scope} onChange={setScope} />
            <p className="text-xs text-ink-3">{poolSize.toLocaleString()} cues available.</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Round length</p>
            <ToggleGroup type="single" variant="outline" value={len} onValueChange={(v) => v && setLen(v)}>
              {["10", "20", "40"].map((n) => (
                <ToggleGroupItem key={n} value={n}>
                  {n} cues
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <Button size="lg" className="self-start" onClick={start} disabled={!poolSize}>
            <Play /> Start round
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (finished) {
    const total = score.ok + score.bad
    return (
      <div className="flex max-w-3xl flex-col gap-5">
        <div>
          <p className="eyebrow">Round complete</p>
          <p className="mt-1 text-4xl font-semibold">
            {score.ok}/{total} <span className="text-lg font-normal text-ink-2">in {Math.round(elapsed / 1000)}s</span>
          </p>
          <p className="mt-1 text-ink-2">
            {Math.round(elapsed / 1000 / Math.max(1, total))}s per cue. Missed cues return in this session's schedule within minutes.
          </p>
        </div>
        {misses.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Missed: read each pair once more, out loud</p>
            {misses.map((m) => (
              <div key={m.cue.id} className="rounded-lg border border-line bg-surface p-3.5 text-sm">
                <p className="italic">“{m.cue.f}”</p>
                <p className="mt-1">
                  → <span className="hl">{m.cue.b}</span>
                </p>
                {m.cue.x && <p className="mt-1 text-ink-2">{m.cue.x}</p>}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={start}>
            <RotateCcw /> Another round
          </Button>
          <Button variant="outline" onClick={() => setRounds(null)}>
            Change settings
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex items-center gap-3 font-mono text-xs text-ink-3 tabular">
        <Zap className="size-3.5" /> {i + 1} / {rounds.length}
        <span className="text-good">✓ {score.ok}</span>
        <span className="text-bad">✗ {score.bad}</span>
        <span className="ml-auto">{Math.round(elapsed / 1000)}s</span>
      </div>
      <div className="index-card flex min-h-40 flex-col">
        <div className="flex h-[3.25rem] items-center px-4">
          <span className="eyebrow">When the scenario says</span>
        </div>
        <p className="px-5 py-5 text-xl font-medium italic leading-snug sm:px-7">“{round!.cue.f}”</p>
      </div>
      <div className="grid gap-2.5">
        {round!.options.map((o, k) => {
          const isAns = k === round!.answer
          const state = pick == null ? "idle" : isAns ? "good" : k === pick ? "bad" : "dim"
          return (
            <button
              key={k}
              type="button"
              onClick={() => choose(k)}
              disabled={pick != null}
              className={cn(
                "flex items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 text-left text-sm transition-colors",
                state === "idle" && "border-line hover:border-ink-3",
                state === "good" && "border-good bg-good-bg",
                state === "bad" && "border-bad bg-bad-bg",
                state === "dim" && "border-line opacity-60",
              )}
            >
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-line font-mono text-xs">
                {state === "good" ? <Check className="size-3.5 text-good" /> : state === "bad" ? <X className="size-3.5 text-bad" /> : k + 1}
              </span>
              <span>{o}</span>
            </button>
          )
        })}
      </div>
      {pick != null && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1 text-sm text-ink-2">
            {round!.cue.x && <p>{round!.cue.x}</p>}
            <div className="mt-2">
              <TopicChip id={round!.cue.t} />
            </div>
          </div>
          <Button onClick={next}>Next</Button>
        </div>
      )}
    </div>
  )
}
