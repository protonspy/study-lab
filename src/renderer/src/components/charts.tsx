import { useState, type ReactNode } from "react"
import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react"
import { domainColor, DomainDot } from "@/components/Domain"
import { domainOf, EXAM_FACTS, PASS_ACC } from "@/lib/data"
import type { DomainStat } from "@/lib/stats"
import type { ExamResult } from "@/lib/types"
import { cn } from "@/lib/utils"

/* One floating tooltip, positioned from the hovered mark's box. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null)
  const show = (el: Element, body: ReactNode, container: Element | null) => {
    const r = el.getBoundingClientRect()
    const c = container?.getBoundingClientRect()
    if (!c) return
    setTip({ x: r.left - c.left + r.width / 2, y: r.top - c.top, body })
  }
  const node = tip ? (
    <div
      role="status"
      className="pointer-events-none absolute z-20 w-max max-w-56 -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-md border border-line bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.body}
    </div>
  ) : null
  return { show, hide: () => setTip(null), node }
}

export function statusOf(score: number) {
  if (score >= EXAM_FACTS.pass) return { label: "On track to pass", tone: "good" as const, Icon: CheckCircle2 }
  if (score >= EXAM_FACTS.pass - (EXAM_FACTS.max - EXAM_FACTS.min) * 0.09) return { label: "Close to the line", tone: "warn" as const, Icon: AlertTriangle }
  return { label: "Not there yet", tone: "bad" as const, Icon: CircleDashed }
}

/** The exam's reported scale (AWS: 100–1000, pass 700) with the pass mark drawn in. */
export function ScoreScale({ score, faint, label }: { score: number; faint?: boolean; label?: string }) {
  const { min, max } = EXAM_FACTS
  const pos = (v: number) => `${((v - min) / Math.max(1, max - min)) * 100}%`
  const mid = Math.round((min + max) / 2)
  const st = statusOf(score)
  const fill = st.tone === "good" ? "var(--good)" : st.tone === "warn" ? "var(--warn)" : "var(--bad)"
  return (
    <div className="w-full">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-ink-3">{label ?? "Estimated scaled score"}</p>
          <p className={cn("text-5xl font-semibold leading-none tracking-tight", faint && "text-ink-3")}>{score}</p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
            st.tone === "good" && "bg-good-bg text-good",
            st.tone === "warn" && "bg-warn-bg text-warn",
            st.tone === "bad" && "bg-bad-bg text-bad",
          )}
        >
          <st.Icon className="size-3.5" /> {st.label}
        </span>
      </div>
      <div className="relative mt-4 h-2.5 rounded-full bg-surface-2" aria-hidden>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pos(score), background: fill, opacity: faint ? 0.45 : 1 }} />
        <div className="absolute -inset-y-1.5 w-0.5 rounded bg-ink" style={{ left: pos(EXAM_FACTS.pass) }} />
      </div>
      <div className="relative mt-1.5 h-4 font-mono text-[0.68rem] text-ink-3 tabular">
        <span className="absolute left-0">{min}</span>
        {Math.abs(mid - EXAM_FACTS.pass) > (max - min) * 0.12 && (
          <span className="absolute -translate-x-1/2" style={{ left: pos(mid) }}>
            {mid}
          </span>
        )}
        <span className="absolute -translate-x-1/2 font-semibold text-ink" style={{ left: pos(EXAM_FACTS.pass) }}>
          {EXAM_FACTS.pass} pass
        </span>
        <span className="absolute right-0">{max}</span>
      </div>
    </div>
  )
}

export function DomainBars({ per }: { per: DomainStat[] }) {
  return (
    <div className="flex flex-col gap-3.5">
      {per.map((p) => {
        const dom = domainOf(p.d) ?? { short: `Domain ${p.d}`, w: 0 }
        const acc = p.firstN ? Math.round((100 * p.firstOk) / p.firstN) : null
        const cover = Math.round((100 * p.seen) / Math.max(1, p.total))
        return (
          <div key={p.d} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <DomainDot d={p.d} />
              <span className="truncate">{dom.short}</span>
              <span className="font-mono text-xs text-ink-3">{dom.w}%</span>
            </div>
            <span className="text-right font-mono text-sm tabular">{acc == null ? "—" : `${acc}%`}</span>
            <div className="col-span-2 flex items-center gap-2">
              <div className="relative h-2 flex-1 rounded-full bg-surface-2">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${acc ?? 0}%`, background: domainColor(p.d) }}
                  title={acc == null ? "No first attempts yet" : `${acc}% first-attempt accuracy`}
                />
                <div className="absolute -inset-y-0.5 w-px bg-ink/50" style={{ left: `${PASS_ACC}%` }} />
              </div>
              <span className="w-24 text-right text-[0.7rem] text-ink-3 tabular">
                {p.seen}/{p.total} seen · {cover}%
              </span>
            </div>
          </div>
        )
      })}
      <p className="text-xs text-ink-3">
        Bars show first-attempt accuracy, which predicts the real exam better than repeat attempts. The tick marks {PASS_ACC}%, roughly a {EXAM_FACTS.pass}.
      </p>
    </div>
  )
}

const HEAT = ["var(--heat-0)", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"]

export function Heatmap({ days }: { days: { key: string; date: Date; count: number; ok: number; bad: number; sec: number }[] }) {
  const tip = useTip()
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const level = (n: number) => (n === 0 ? 0 : n < 15 ? 1 : n < 40 ? 2 : n < 90 ? 3 : 4)
  const weeks: (typeof days)[] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  return (
    <div ref={setBox} className="relative">
      <div className="flex gap-[3px] overflow-x-auto pb-1" onMouseLeave={tip.hide}>
        <div className="mr-1 flex flex-col gap-[3px] pt-0 text-[0.62rem] leading-[13px] text-ink-3">
          {["Mon", "", "Wed", "", "Fri", "", "Sun"].map((d, i) => (
            <span key={i} className="h-[13px]">
              {d}
            </span>
          ))}
        </div>
        {weeks.map((w, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {w.map((d) => {
              const acc = d.ok + d.bad ? Math.round((100 * d.ok) / (d.ok + d.bad)) : null
              const body = (
                <>
                  <p className="font-medium">{d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</p>
                  <p className="text-ink-2">
                    {d.count} items{acc != null ? ` · ${acc}% correct` : ""}
                    {d.sec ? ` · ${Math.round(d.sec / 60)} min` : ""}
                  </p>
                </>
              )
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-label={`${d.key}: ${d.count} items`}
                  className="size-[13px] rounded-[3px] outline-offset-1"
                  style={{ background: HEAT[level(d.count)] }}
                  onMouseEnter={(e) => tip.show(e.currentTarget, body, box)}
                  onFocus={(e) => tip.show(e.currentTarget, body, box)}
                  onBlur={tip.hide}
                />
              )
            })}
          </div>
        ))}
      </div>
      {tip.node}
      <div className="mt-2 flex items-center gap-1.5 text-[0.68rem] text-ink-3">
        Less
        {HEAT.map((c, i) => (
          <span key={i} className="size-[11px] rounded-[3px]" style={{ background: c }} />
        ))}
        More
      </div>
    </div>
  )
}

export function ExamHistory({ exams }: { exams: ExamResult[] }) {
  const tip = useTip()
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const W = 560
  const H = 180
  const pad = { l: 36, r: 16, t: 14, b: 26 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const { min, max } = EXAM_FACTS
  const y = (v: number) => pad.t + ih - ((v - min) / Math.max(1, max - min)) * ih
  const x = (i: number) => pad.l + (exams.length === 1 ? iw / 2 : (i / (exams.length - 1)) * iw)
  const path = exams.map((e, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(e.score).toFixed(1)}`).join(" ")
  const area = exams.length > 1 ? `${path} L${x(exams.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z` : ""
  return (
    <div ref={setBox} className="relative w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[320px]" role="img" aria-label="Mock exam scores over time" onMouseLeave={tip.hide}>
        {[...new Set([min, Math.round(min + (max - min) / 3), EXAM_FACTS.pass, max])].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === EXAM_FACTS.pass ? "var(--ink-3)" : "var(--line)"} strokeWidth={1} />
            <text x={pad.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--ink-3)" className="font-mono">
              {v}
            </text>
          </g>
        ))}
        <text x={W - pad.r} y={y(EXAM_FACTS.pass) - 5} textAnchor="end" fontSize="10" fill="var(--ink-2)">
          Pass {EXAM_FACTS.pass}
        </text>
        {area && <path d={area} fill="var(--d1)" opacity={0.1} />}
        {exams.length > 1 && <path d={path} fill="none" stroke="var(--d1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {exams.map((e, i) => (
          <g key={e.at}>
            <circle cx={x(i)} cy={y(e.score)} r={6} fill="var(--d1)" stroke="var(--surface)" strokeWidth={2} />
            <circle
              cx={x(i)}
              cy={y(e.score)}
              r={14}
              fill="transparent"
              tabIndex={0}
              onMouseEnter={(ev) =>
                tip.show(
                  ev.currentTarget,
                  <>
                    <p className="font-medium">
                      {e.score} · {e.correct}/{e.total}
                    </p>
                    <p className="text-ink-2">
                      {e.label} · {new Date(e.at).toLocaleDateString()}
                    </p>
                  </>,
                  box,
                )
              }
              onFocus={(ev) => tip.show(ev.currentTarget, <p className="font-medium">{e.score}</p>, box)}
              onBlur={tip.hide}
            />
          </g>
        ))}
        {exams.length > 0 && (
          <text x={x(exams.length - 1)} y={y(exams[exams.length - 1].score) - 11} textAnchor="middle" fontSize="11" fontWeight={600} fill="var(--ink)">
            {exams[exams.length - 1].score}
          </text>
        )}
        <text x={pad.l} y={H - 6} fontSize="10" fill="var(--ink-3)">
          Attempt 1
        </text>
        {exams.length > 1 && (
          <text x={W - pad.r} y={H - 6} textAnchor="end" fontSize="10" fill="var(--ink-3)">
            Attempt {exams.length}
          </text>
        )}
      </svg>
      {tip.node}
    </div>
  )
}

export function Meter({ value, className, tone = "ink" }: { value: number; className?: string; tone?: "ink" | "good" | "warn" | "bad" }) {
  const color = tone === "ink" ? "var(--ink)" : `var(--${tone})`
  return (
    <div className={cn("relative h-1.5 w-full rounded-full bg-surface-2", className)}>
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  )
}
