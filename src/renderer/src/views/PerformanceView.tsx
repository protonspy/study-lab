import { useEffect, useMemo, useState } from "react"
import { ChevronRight, Gauge, Loader2, Play, Target } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DomainDot } from "@/components/Domain"
import { CalibrationChart, calibrationVerdict, MasteryMeter, QuantileDotplot, RetentionCurve, SpeedAccuracy } from "@/components/viz"
import type { MeterRow, PerformanceData } from "@shared/viz"
import { LAB, useDataVersion } from "@/lib/data"
import { api } from "@/lib/lab"
import { go, run } from "@/lib/nav"
import { questionSprint } from "@/lib/stats"
import { flush, getState, useAppState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

/*
  "How am I doing, and where?" — an open learner model: predicted score as 20 equally likely
  outcomes, mastery per domain → topic → concept with its uncertainty and where it was 14 days ago,
  memory and metacognition, and the next actions it implies.
*/

const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`)

export function usePerformance() {
  const s = useAppState()
  const v = useDataVersion()
  const [data, setData] = useState<PerformanceData | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      await flush()
      const d = await api().performance(LAB!.id)
      if (live) setData(d)
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [s.srsq, s.srsc, v])
  return data
}

function practise(label: string, kcs: string[], topics: string[]) {
  const s = getState()
  const items = kcs.length ? questionSprint(s, 12, { kcs }) : topics.length ? questionSprint(s, 12, { topic: topics[0] }) : questionSprint(s, 12)
  run(`Practice · ${label}`, items, "performance")
}

export function PerformanceView() {
  const d = usePerformance()
  if (!d) return <Loader2 className="size-5 animate-spin text-ink-3" />
  const passing = d.scale ? d.quantiles.filter((x) => x >= d.scale!.pass).length : 0
  const verdict = calibrationVerdict(d.bias, d.brier)

  return (
    <div>
      <PageHead eyebrow={LAB!.name} title="Performance">
        Where you stand, with honest uncertainty: what the model knows about each concept, how much you will remember on exam day, and how well your confidence matches reality.
      </PageHead>

      <Card>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center">
          <div>
            <p className="eyebrow flex items-center gap-1.5">
              <Gauge className="size-3.5" /> Exam readiness
            </p>
            {d.predicted && d.scale ? (
              <>
                <p className="mt-1 font-heading text-5xl font-semibold tabular">{d.predicted.score}</p>
                <p className="text-sm text-ink-2">
                  Likely between <span className="font-mono">{d.predicted.low}</span> and <span className="font-mono">{d.predicted.high}</span>. In <span className="font-semibold text-ink">{passing} of 20</span>{" "}
                  likely outcomes you reach the pass mark of {d.scale.pass}.
                </p>
                <p className="mt-2 text-xs text-ink-3">Each dot is one equally likely exam score given what you know today. The range narrows as you answer more.</p>
              </>
            ) : (
              <p className="mt-2 text-sm text-ink-2">{d.scale ? "Answer some questions to get a prediction." : "This lab has no exam format, so there is no score prediction. Mastery below still applies."}</p>
            )}
          </div>
          {d.predicted && d.scale && <QuantileDotplot dots={d.quantiles} min={d.scale.min} max={d.scale.max} pass={d.scale.pass} />}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <MasteryMap d={d} />
        <Card>
          <Tabs defaultValue="memory">
            <CardHeader>
              <TabsList>
                <TabsTrigger value="memory">Memory</TabsTrigger>
                <TabsTrigger value="meta">Metacognition</TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent>
              <TabsContent value="memory" className="flex flex-col gap-3">
                <p className="text-sm font-medium">If you stopped reviewing today</p>
                <RetentionCurve points={d.retention} examDate={d.examDate} />
                <p className="text-xs text-ink-3">
                  Average chance of recalling what you have studied (FSRS forgetting curve), with the 10–90% spread across items. Daily reviews keep items near the dashed 90% line.
                </p>
              </TabsContent>
              <TabsContent value="meta" className="flex flex-col gap-4">
                <div>
                  <p className="text-sm font-medium">Confidence vs. accuracy</p>
                  <CalibrationChart rows={d.calibration} />
                  {verdict && <p className={cn("text-xs", verdict.tone === "good" ? "text-good" : "text-warn")}>{verdict.label}</p>}
                </div>
                <div>
                  <p className="text-sm font-medium">Speed and accuracy by topic</p>
                  <SpeedAccuracy rows={d.speed} pace={d.paceSec} onPick={(t) => go("notes", { topic: t })} />
                  <p className="text-xs text-ink-3">Orange dots: many answers faster than the time needed to read the question. Treat speed as a skill to train.</p>
                </div>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="size-4" /> What to do next
          </CardTitle>
          <CardDescription>The concepts with the highest priority: exam weight × what is still missing × how soon you would forget × misconceptions.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {d.actions.map((a) => (
            <div key={a.label} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <p className="font-medium">{a.label}</p>
              <p className="text-xs text-ink-3">{REASON[a.reason] ?? a.reason}</p>
              <Button size="sm" variant="outline" className="mt-auto w-fit" onClick={() => practise(a.label, a.kcs, a.topics)}>
                <Play /> Practise
              </Button>
            </div>
          ))}
          {!d.actions.length && <p className="text-sm text-ink-3">Nothing to suggest yet.</p>}
        </CardContent>
      </Card>
    </div>
  )
}

const REASON: Record<string, string> = {
  gap: "Still a gap: low mastery for its exam weight.",
  misconception: "The same wrong option keeps coming back.",
  confusable: "Mixed up with a look-alike concept.",
  prereq_unlock: "A prerequisite for weaker concepts.",
  exam_risk: "Likely to be forgotten by exam day.",
}

function MasteryMap({ d }: { d: PerformanceData }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))))
  const gain = (r: MeterRow) => (r.mastery == null ? 0.5 : Math.max(0, 0.8 - r.mastery))
  const domains = useMemo(() => d.domains.map((x) => ({ ...x, topics: [...x.topics].sort((a, b) => gain(b) - gain(a)) })), [d])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mastery map</CardTitle>
        <CardDescription>
          Bar = estimated mastery; the soft band is how unsure the estimate still is; the tick is the 80% target; the hollow dot is where you were 14 days ago. Grey means too little data.
          {d.topicLevel && " Build the knowledge graph to see individual concepts."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {domains.map((dom) => (
          <div key={dom.id}>
            <Row row={dom} level={0} open={open.has(`d${dom.id}`)} onToggle={() => toggle(`d${dom.id}`)} lead={<DomainDot d={dom.d} />} extra={`${Math.round(dom.weight * 100)}%`} />
            {open.has(`d${dom.id}`) &&
              dom.topics.map((t) => (
                <div key={t.id}>
                  <Row row={t} level={1} open={open.has(`t${t.id}`)} onToggle={t.kcs.length ? () => toggle(`t${t.id}`) : undefined} onOpen={() => go("notes", { topic: t.id })} />
                  {open.has(`t${t.id}`) &&
                    [...t.kcs]
                      .sort((a, b) => gain(b) - gain(a))
                      .map((k) => <Row key={k.id} row={k} level={2} extra={k.readiness < 0.5 ? "needs prerequisites" : undefined} onOpen={() => practise(k.name, [k.id], [])} />)}
                </div>
              ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function Row({ row, level, open, onToggle, onOpen, lead, extra }: { row: MeterRow; level: number; open?: boolean; onToggle?: () => void; onOpen?: () => void; lead?: React.ReactNode; extra?: string }) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_minmax(120px,1.2fr)_4.5rem] items-center gap-3 rounded-md py-1.5 pr-2 hover:bg-surface-2/60", level === 0 && "font-medium")} style={{ paddingLeft: `${level * 18 + 4}px` }}>
      <div className="flex min-w-0 items-center gap-1.5">
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} className="rounded p-0.5 text-ink-3 hover:text-ink">
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="w-4.5" />
        )}
        {lead}
        <button type="button" onClick={onOpen ?? onToggle} className="truncate text-left text-sm hover:underline">
          {row.name}
        </button>
        {extra && <span className="shrink-0 font-mono text-[0.68rem] text-ink-3">{extra}</span>}
      </div>
      <MasteryMeter mastery={row.mastery} sd={row.sd} ghost={row.ghost} attempts={row.attempts} />
      <span className="text-right font-mono text-xs tabular" title={row.sd != null ? `± ${Math.round(row.sd * 128)} points (80% interval)` : undefined}>
        {pct(row.mastery)}
        {row.sd != null && row.mastery != null && <span className="text-ink-3"> ±{Math.round(row.sd * 128)}</span>}
      </span>
    </div>
  )
}
