import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Heatmap } from "@/components/charts"
import { SlopeChart } from "@/components/viz"
import type { TimelineData } from "@shared/viz"
import { LAB, useDataVersion } from "@/lib/data"
import { api } from "@/lib/lab"
import { go } from "@/lib/nav"
import { heatmap } from "@/lib/stats"
import { flush, useAppState } from "@/lib/store"
import { PageHead } from "@/views/ReviewView"

/*
  "How did I get here?" — aligned tracks on one shared time axis (activity, predicted score with
  mock exams, milestones, plan adherence), so cause and effect line up without a dual-axis chart.
  Drag across the chart to zoom, double-click to reset.
*/

const DAY = 86_400_000
const MODES = [
  { k: "review", label: "Review", color: "var(--d1)" },
  { k: "practice", label: "Practice", color: "var(--d3)" },
  { k: "exam", label: "Mock exam", color: "var(--d2)" },
  { k: "cards", label: "Flashcards", color: "var(--d4)" },
] as const

const PLAN_COLOR = { done: "var(--good)", partial: "var(--warn)", missed: "var(--bad)", upcoming: "var(--line)" }
const MILESTONE = { mastered: { sym: "◆", color: "var(--seq)", label: "Concept mastered" }, resolved: { sym: "✓", color: "var(--good)", label: "Misconception fixed" }, coach: { sym: "▲", color: "var(--d2)", label: "Coach change" }, plan: { sym: "●", color: "var(--ink-3)", label: "Plan" } }

const ts = (date: string) => new Date(`${date}T12:00:00`).getTime()

export function TimelineView() {
  const s = useAppState()
  const v = useDataVersion()
  const [d, setD] = useState<TimelineData | null>(null)
  const [range, setRange] = useState<"14" | "30" | "90" | "all">("30")
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      await flush()
      const x = await api().timeline(LAB!.id)
      if (live) setD(x)
    })()
    return () => {
      live = false
    }
  }, [s.meta.exams, v]) // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => heatmap(s, 16), [s.meta.log]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <Loader2 className="size-5 animate-spin text-ink-3" />
  const end = Date.now()
  const first = d.days.length ? ts(d.days[0].date) - DAY / 2 : end - 14 * DAY
  const start = zoom ? zoom[0] : range === "all" ? first : Math.max(first, end - Number(range) * DAY)
  const stop = zoom ? zoom[1] : end + DAY / 2

  return (
    <div>
      <PageHead eyebrow={LAB!.name} title="Timeline">
        Your study history on one time axis: what you did, how your predicted score moved, the milestones along the way and how closely you followed the plan.
      </PageHead>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Progress</CardTitle>
            <CardDescription>Drag across the chart to zoom into a period; double-click to reset.</CardDescription>
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            value={zoom ? "" : range}
            onValueChange={(x) => {
              if (!x) return
              setZoom(null)
              setRange(x as typeof range)
            }}
          >
            <ToggleGroupItem value="14">14 days</ToggleGroupItem>
            <ToggleGroupItem value="30">30 days</ToggleGroupItem>
            <ToggleGroupItem value="90">90 days</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent>
          {d.days.every((x) => !x.review && !x.practice && !x.exam && !x.cards) ? (
            <p className="py-8 text-sm text-ink-3">No study activity yet. Your timeline starts with your first session.</p>
          ) : (
            <Tracks d={d} start={start} end={stop} onZoom={setZoom} />
          )}
          <Legend />
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Study rhythm</CardTitle>
            <CardDescription>Items studied per day. Gaps are fine; consistency matters more than streaks.</CardDescription>
          </CardHeader>
          <CardContent>
            <Heatmap days={days} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Then and now</CardTitle>
            <CardDescription>Average mastery per domain, 30 days ago and today: progress measured against yourself.</CardDescription>
          </CardHeader>
          <CardContent>
            {d.slope.some((x) => x.now != null) ? <SlopeChart rows={d.slope} /> : <p className="text-sm text-ink-3">Not enough history yet.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {MODES.map((m) => (
        <span key={m.k} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: m.color }} /> {m.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-4" style={{ background: "var(--seq)" }} /> Predicted score
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border-2 border-surface" style={{ background: "var(--d2)" }} /> Mock exam score
      </span>
      {(["mastered", "resolved", "coach"] as const).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span style={{ color: MILESTONE[k].color }}>{MILESTONE[k].sym}</span> {MILESTONE[k].label}
        </span>
      ))}
    </div>
  )
}

function Tracks({ d, start, end, onZoom }: { d: TimelineData; start: number; end: number; onZoom: (z: [number, number] | null) => void }) {
  const ref = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<[number, number] | null>(null)
  const W = 900
  const L = 92
  const R = 12
  const hasTrend = !!d.scale && (d.trend.length > 0 || d.mocks.length > 0)
  const tracks = { act: { y: 6, h: 70 }, trend: { y: 92, h: hasTrend ? 120 : 0 }, mil: { y: hasTrend ? 228 : 92, h: 22 }, plan: { y: hasTrend ? 262 : 126, h: 14 } }
  const H = tracks.plan.y + tracks.plan.h + 22
  const x = (t: number) => L + ((t - start) / Math.max(1, end - start)) * (W - L - R)
  const inView = (t: number) => t >= start && t <= end
  const days = d.days.filter((x2) => inView(ts(x2.date)))
  const maxAct = Math.max(1, ...days.map((x2) => x2.review + x2.practice + x2.exam + x2.cards))
  const bw = Math.max(2, Math.min(18, ((W - L - R) / Math.max(1, (end - start) / DAY)) * 0.7))
  const sc = d.scale
  const trend = d.trend.filter((p) => inView(ts(p.date)))
  // Zoom the score axis to the data (and the pass mark), so small movements stay visible.
  const vals = sc ? [sc.pass, ...trend.flatMap((p) => [p.low, p.high]), ...d.mocks.filter((m) => inView(m.at)).map((m) => m.score)] : []
  const yMin = sc ? Math.max(sc.min, Math.min(...vals) - (sc.max - sc.min) * 0.05) : 0
  const yMax = sc ? Math.min(sc.max, Math.max(...vals) + (sc.max - sc.min) * 0.05) : 1
  const ty = (v: number) => (sc ? tracks.trend.y + tracks.trend.h - ((v - yMin) / Math.max(1, yMax - yMin)) * tracks.trend.h : 0)
  const ticks = useMemo(() => {
    const out: number[] = []
    const step = Math.max(1, Math.round((end - start) / DAY / 8)) * DAY
    for (let t = Math.ceil(start / DAY) * DAY; t <= end; t += step) out.push(t)
    return out
  }, [start, end])

  const toT = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const vx = ((clientX - r.left) / r.width) * W
    return start + ((vx - L) / (W - L - R)) * (end - start)
  }

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full touch-none select-none"
      role="img"
      aria-label="Study timeline: daily activity, predicted score, milestones and plan adherence"
      onMouseDown={(e) => setDrag([toT(e.clientX), toT(e.clientX)])}
      onMouseMove={(e) => drag && setDrag([drag[0], toT(e.clientX)])}
      onMouseUp={() => {
        if (drag && Math.abs(drag[1] - drag[0]) > DAY / 2) onZoom([Math.min(...drag), Math.max(...drag)])
        setDrag(null)
      }}
      onMouseLeave={() => setDrag(null)}
      onDoubleClick={() => onZoom(null)}
    >
      {/* track labels */}
      {[
        ["Activity", tracks.act],
        ...(hasTrend ? ([["Predicted", tracks.trend]] as const) : []),
        ["Milestones", tracks.mil],
        ["Plan", tracks.plan],
      ].map(([label, t]) => (
        <text key={label as string} x={4} y={(t as { y: number }).y + 12} fontSize="10" fill="var(--ink-2)">
          {label as string}
        </text>
      ))}
      {/* shared time axis */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={4} y2={H - 20} stroke="var(--line)" strokeDasharray="2 4" />
          <text x={x(t)} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--ink-3)" className="font-mono">
            {new Date(t).toISOString().slice(5, 10)}
          </text>
        </g>
      ))}

      {/* 1. activity: stacked bars by mode */}
      {days.map((day) => {
        let y0 = tracks.act.y + tracks.act.h
        const cx = x(ts(day.date))
        return (
          <g key={day.date}>
            {MODES.map((m) => {
              const n = day[m.k]
              if (!n) return null
              const h = (n / maxAct) * tracks.act.h
              y0 -= h
              return <rect key={m.k} x={cx - bw / 2} y={y0} width={bw} height={Math.max(1, h - 1)} rx={1.5} fill={m.color} />
            })}
            <rect x={cx - bw / 2} y={tracks.act.y} width={bw} height={tracks.act.h} fill="transparent">
              <title>{`${day.date}: ${day.review} review, ${day.practice} practice, ${day.exam} mock, ${day.cards} cards · ${day.minutes} min${day.accuracy != null ? ` · ${Math.round(day.accuracy * 100)}% right` : ""}`}</title>
            </rect>
          </g>
        )
      })}

      {/* 2. predicted score with its interval, mock exams as points, the pass line */}
      {hasTrend && sc && (
        <g>
          {[yMin, yMax].map((v) => (
            <text key={v} x={L - 4} y={ty(v) + 3} textAnchor="end" fontSize="9" fill="var(--ink-3)" className="font-mono">
              {Math.round(v)}
            </text>
          ))}
          <line x1={L} x2={W - R} y1={ty(sc.pass)} y2={ty(sc.pass)} stroke="var(--ink)" strokeDasharray="4 3" opacity={0.6} />
          <text x={W - R} y={ty(sc.pass) - 3} textAnchor="end" fontSize="9" fill="var(--ink-2)">
            pass {sc.pass}
          </text>
          {trend.length > 1 && (
            <>
              <path
                d={`${trend.map((p, i) => `${i ? "L" : "M"}${x(ts(p.date))},${ty(p.high)}`).join(" ")} ${[...trend]
                  .reverse()
                  .map((p) => `L${x(ts(p.date))},${ty(p.low)}`)
                  .join(" ")} Z`}
                fill="var(--seq)"
                opacity={0.12}
              />
              <path d={trend.map((p, i) => `${i ? "L" : "M"}${x(ts(p.date))},${ty(p.score)}`).join(" ")} fill="none" stroke="var(--seq)" strokeWidth={2} />
            </>
          )}
          {trend.map((p) => (
            <circle key={p.date} cx={x(ts(p.date))} cy={ty(p.score)} r={3} fill="var(--seq)">
              <title>{`${p.date}: predicted ${p.score} (${p.low}–${p.high})`}</title>
            </circle>
          ))}
          {d.mocks
            .filter((m) => inView(m.at))
            .map((m) => (
              <circle key={m.at} cx={x(m.at)} cy={ty(m.score)} r={6} fill="var(--d2)" stroke="var(--surface)" strokeWidth={2} className="cursor-pointer" onClick={() => go("exam")}>
                <title>{`${m.date} · ${m.label}: ${m.score}`}</title>
              </circle>
            ))}
        </g>
      )}

      {/* 3. milestones */}
      {d.milestones
        .filter((m) => inView(m.at))
        .map((m, i) => (
          <text
            key={i}
            x={x(m.at)}
            y={tracks.mil.y + 14 + (i % 2) * 6}
            textAnchor="middle"
            fontSize="12"
            fill={MILESTONE[m.kind].color}
            className="cursor-pointer"
            onClick={() => (m.kind === "coach" ? go("coach", { tab: "activity" }) : m.ref ? go("graph", { node: m.ref }) : undefined)}
          >
            {MILESTONE[m.kind].sym}
            <title>{`${m.date}: ${m.label}`}</title>
          </text>
        ))}

      {/* 4. plan adherence */}
      {d.plan
        .filter((p) => inView(ts(p.date)))
        .map((p) => (
          <rect key={p.date} x={x(ts(p.date)) - bw / 2} y={tracks.plan.y} width={bw} height={tracks.plan.h} rx={2} fill={PLAN_COLOR[p.status]}>
            <title>{`${p.date}: plan ${p.status}`}</title>
          </rect>
        ))}

      {drag && <rect x={Math.min(x(drag[0]), x(drag[1]))} y={4} width={Math.abs(x(drag[1]) - x(drag[0]))} height={H - 24} fill="var(--seq)" opacity={0.1} />}
    </svg>
  )
}
