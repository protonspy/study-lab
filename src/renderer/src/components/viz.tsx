import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/*
  Visual primitives for the progress views (docs/visualization.md). Hand-rolled SVG so theme
  tokens apply directly. Uncertainty is always visible, as an opacity gradient rather than error
  bars; colours are a single sequential hue, grey when there is too little data.
*/

const pct = (x: number) => `${Math.round(x * 100)}%`

/** Hover tooltip anchored inside a relatively positioned container. */
export function useHoverTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null)
  const node = tip ? (
    <div
      role="status"
      className="pointer-events-none absolute z-20 w-max max-w-64 -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-md border border-line bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.body}
    </div>
  ) : null
  return { show: (x: number, y: number, body: ReactNode) => setTip({ x, y, body }), hide: () => setTip(null), node }
}

/**
 * Mastery meter: the bar reaches the estimate; a gradient spreads over its 80% interval; a tick marks
 * the target; a hollow marker shows where it was 14 days ago.
 */
export function MasteryMeter({ mastery, sd, ghost, target = 0.8, className, attempts }: { mastery: number | null; sd: number | null; ghost?: number | null; target?: number; className?: string; attempts?: number }) {
  const thin = mastery == null || (attempts != null && attempts < 3)
  const m = mastery ?? 0
  const lo = Math.max(0, m - 1.28 * (sd ?? 0))
  const hi = Math.min(1, m + 1.28 * (sd ?? 0))
  return (
    <div className={cn("relative h-3 w-full rounded-full bg-surface-2", className)} role="img" aria-label={mastery == null ? "No data yet" : `Mastery ${pct(m)}, likely between ${pct(lo)} and ${pct(hi)}`}>
      {mastery != null && (
        <>
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${m * 100}%`, background: thin ? "var(--ink-3)" : "var(--seq)", opacity: thin ? 0.45 : 0.9 }} />
          {hi - lo > 0.01 && (
            <div
              className="absolute inset-y-0"
              style={{
                left: `${lo * 100}%`,
                width: `${(hi - lo) * 100}%`,
                background: `linear-gradient(90deg, transparent, ${thin ? "var(--ink-3)" : "var(--seq)"} ${((m - lo) / Math.max(0.001, hi - lo)) * 100}%, transparent)`,
                opacity: 0.35,
              }}
            />
          )}
        </>
      )}
      <div className="absolute -inset-y-0.5 w-0.5 rounded bg-ink/60" style={{ left: `${target * 100}%` }} title={`Target ${pct(target)}`} />
      {ghost != null && <div className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-2 bg-surface" style={{ left: `${ghost * 100}%` }} title={`14 days ago: ${pct(ghost)}`} />}
    </div>
  )
}

/** Quantile dotplot: 20 equally likely outcomes; count the dots past the pass line. */
export function QuantileDotplot({ dots, min, max, pass }: { dots: number[]; min: number; max: number; pass: number }) {
  const W = 520
  const H = 120
  const pad = { l: 12, r: 12, t: 10, b: 24 }
  const x = (v: number) => pad.l + ((v - min) / Math.max(1, max - min)) * (W - pad.l - pad.r)
  const r = 7
  // Stack dots that would overlap into columns.
  const cols = new Map<number, number>()
  const placed = [...dots].sort((a, b) => a - b).map((v) => {
    const cx = Math.round(x(v) / (2 * r)) * 2 * r
    const k = cols.get(cx) ?? 0
    cols.set(cx, k + 1)
    return { v, cx, cy: H - pad.b - r - k * (2 * r + 1) }
  })
  const passing = dots.filter((v) => v >= pass).length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`In ${passing} of ${dots.length} likely outcomes the score reaches the pass mark of ${pass}`}>
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--line)" />
      {[min, Math.round((min + max) / 2), max].map((v) => (
        <text key={v} x={x(v)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--ink-3)" className="font-mono">
          {v}
        </text>
      ))}
      <line x1={x(pass)} x2={x(pass)} y1={pad.t} y2={H - pad.b + 4} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="4 3" />
      <text x={x(pass) + 4} y={pad.t + 8} fontSize="10" fill="var(--ink-2)">
        pass {pass}
      </text>
      {placed.map((p, i) => (
        <circle key={i} cx={p.cx} cy={p.cy} r={r - 1} fill={p.v >= pass ? "var(--good)" : "var(--ink-3)"} opacity={p.v >= pass ? 0.9 : 0.55} stroke="var(--surface)" strokeWidth={1.5}>
          <title>{Math.round(p.v)}</title>
        </circle>
      ))}
    </svg>
  )
}

/** Recall forecast if you stopped reviewing: mean with a p10–p90 band; the dashed line is FSRS's 90% target. */
export function RetentionCurve({ points, examDate }: { points: { date: string; mean: number; p10: number; p90: number }[]; examDate: string | null }) {
  const W = 360
  const H = 170
  const pad = { l: 34, r: 10, t: 10, b: 24 }
  if (points.length < 2) return <p className="text-sm text-ink-3">Study some items first; the forecast needs reviewed material.</p>
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b)
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.mean).toFixed(1)}`).join(" ")
  const band = `${points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.p90).toFixed(1)}`).join(" ")} ${[...points]
    .reverse()
    .map((p, i) => `L${x(points.length - 1 - i).toFixed(1)},${y(p.p10).toFixed(1)}`)
    .join(" ")} Z`
  const examIdx = examDate ? points.findIndex((p) => p.date >= examDate) : -1
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Forecast of how much you would remember without further review">
        {[0.5, 0.7, 0.9, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0.9 ? "var(--ink-3)" : "var(--line)"} strokeDasharray={v === 0.9 ? "4 3" : undefined} />
            <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--ink-3)" className="font-mono">
              {Math.round(v * 100)}
            </text>
          </g>
        ))}
        <path d={band} fill="var(--seq)" opacity={0.15} />
        <path d={line} fill="none" stroke="var(--seq)" strokeWidth={2} />
        {examIdx >= 0 && (
          <g>
            <line x1={x(examIdx)} x2={x(examIdx)} y1={pad.t} y2={H - pad.b} stroke="var(--ink)" strokeWidth={1} />
            <text x={x(examIdx) - 3} y={pad.t + 9} textAnchor="end" fontSize="9" fill="var(--ink-2)">
              exam
            </text>
          </g>
        )}
        <text x={pad.l} y={H - 6} fontSize="9" fill="var(--ink-3)">
          today
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" fontSize="9" fill="var(--ink-3)">
          {points[points.length - 1].date.slice(5)}
        </text>
        {points.map((p, i) => (
          <rect key={p.date} x={x(i) - (W - pad.l - pad.r) / points.length / 2} y={pad.t} width={(W - pad.l - pad.r) / points.length} height={H - pad.t - pad.b} fill="transparent">
            <title>{`${p.date}: ${pct(p.mean)} recalled on average (10–90%: ${pct(p.p10)}–${pct(p.p90)})`}</title>
          </rect>
        ))}
      </svg>
    </div>
  )
}

/** Reliability diagram for three confidence levels: stated confidence vs observed accuracy, with intervals. */
export function CalibrationChart({ rows }: { rows: { conf: string; stated: number; n: number; acc: number | null; lo: number | null; hi: number | null }[] }) {
  const W = 300
  const H = 200
  const pad = { l: 34, r: 12, t: 10, b: 30 }
  const x = (v: number) => pad.l + v * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Calibration: ${rows.map((r) => `${r.conf} ${r.acc == null ? "no data" : pct(r.acc)}`).join(", ")}`}>
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--ink-3)" className="font-mono">
            {v * 100}
          </text>
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--ink-3)" strokeDasharray="4 3" />
      <text x={x(0.98)} y={y(0.98) + 12} textAnchor="end" fontSize="9" fill="var(--ink-3)">
        well calibrated
      </text>
      {rows.map((r) => (
        <g key={r.conf}>
          {r.lo != null && r.hi != null && <line x1={x(r.stated)} x2={x(r.stated)} y1={y(r.lo)} y2={y(r.hi)} stroke="var(--seq)" strokeWidth={3} opacity={0.35} strokeLinecap="round" />}
          {r.acc != null && (
            <circle cx={x(r.stated)} cy={y(r.acc)} r={Math.min(9, 3 + Math.sqrt(r.n))} fill="var(--seq)" stroke="var(--surface)" strokeWidth={2}>
              <title>
                {r.conf}: {pct(r.acc)} right of {r.n}
              </title>
            </circle>
          )}
          <text x={x(r.stated)} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--ink-2)">
            {r.conf}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function calibrationVerdict(bias: number | null, brier: number | null): { label: string; tone: "good" | "warn" } | null {
  if (bias == null || brier == null) return null
  if (bias > 0.08) return { label: "You tend to be overconfident: your “sure” answers are wrong more often than you expect.", tone: "warn" }
  if (bias < -0.08) return { label: "You tend to be underconfident: you know more than you think.", tone: "warn" }
  return { label: "Well calibrated: your confidence matches how often you are right.", tone: "good" }
}

/** Speed × accuracy per topic, with the exam pace as a reference line. */
export function SpeedAccuracy({ rows, pace, onPick }: { rows: { topic: string; title: string; medianSec: number; accuracy: number; n: number; rapid: number }[]; pace: number | null; onPick?: (topic: string) => void }) {
  const W = 300
  const H = 200
  const pad = { l: 34, r: 12, t: 10, b: 28 }
  const maxX = Math.max(pace ?? 0, ...rows.map((r) => r.medianSec), 30) * 1.1
  const x = (v: number) => pad.l + (v / maxX) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b)
  if (!rows.length) return <p className="text-sm text-ink-3">Answer a few questions per topic to see this.</p>
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Median time per answer and accuracy, per topic">
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--ink-3)" className="font-mono">
              {v * 100}
            </text>
          </g>
        ))}
        {pace && (
          <g>
            <line x1={x(pace)} x2={x(pace)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-3)" strokeDasharray="4 3" />
            <text x={x(pace) + 3} y={pad.t + 9} fontSize="9" fill="var(--ink-2)">
              exam pace
            </text>
          </g>
        )}
        <text x={W - pad.r} y={H - 8} textAnchor="end" fontSize="9" fill="var(--ink-3)">
          median seconds →
        </text>
        {rows.map((r) => (
          <circle
            key={r.topic}
            cx={x(r.medianSec)}
            cy={y(r.accuracy)}
            r={Math.min(8, 3 + Math.sqrt(r.n) / 2)}
            fill={r.rapid / r.n > 0.15 ? "var(--warn)" : "var(--seq)"}
            opacity={0.8}
            stroke="var(--surface)"
            strokeWidth={1.5}
            className={onPick ? "cursor-pointer" : undefined}
            onClick={() => onPick?.(r.topic)}
          >
            <title>{`${r.title}: ${Math.round(r.accuracy * 100)}% right, ${r.medianSec}s median, ${r.n} answers${r.rapid ? `, ${r.rapid} rushed` : ""}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}

/** Slope chart: each domain then vs now (self-referenced progress). Labels are nudged apart so they never overlap. */
export function SlopeChart({ rows }: { rows: { name: string; before: number | null; now: number | null }[] }) {
  const W = 340
  const H = Math.max(160, rows.length * 22 + 40)
  const pad = { l: 30, r: 150, t: 22, b: 12 }
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b)
  const labelled = rows
    .map((r, i) => ({ r, i, y: r.now == null ? null : y(r.now) }))
    .filter((x): x is { r: (typeof rows)[number]; i: number; y: number } => x.y != null)
    .sort((a, b) => a.y - b.y)
  for (let k = 1; k < labelled.length; k++) if (labelled[k].y - labelled[k - 1].y < 13) labelled[k].y = labelled[k - 1].y + 13
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Domain mastery 30 days ago and now: ${rows.map((r) => `${r.name} ${r.before == null ? "–" : pct(r.before)} to ${r.now == null ? "–" : pct(r.now)}`).join("; ")}`}>
      <text x={pad.l} y={12} textAnchor="middle" fontSize="9" fill="var(--ink-3)">
        30 days ago
      </text>
      <text x={W - pad.r} y={12} textAnchor="middle" fontSize="9" fill="var(--ink-3)">
        now
      </text>
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="var(--line)" />
      <line x1={W - pad.r} x2={W - pad.r} y1={pad.t} y2={H - pad.b} stroke="var(--line)" />
      {rows.map((r, i) => {
        const up = r.before != null && r.now != null && r.now >= r.before
        return (
          <g key={i}>
            {r.before != null && r.now != null && <line x1={pad.l} x2={W - pad.r} y1={y(r.before)} y2={y(r.now)} stroke={up ? "var(--seq)" : "var(--ink-3)"} strokeWidth={2} />}
            {r.before != null && <circle cx={pad.l} cy={y(r.before)} r={4} fill="var(--ink-3)" />}
            {r.now != null && <circle cx={W - pad.r} cy={y(r.now)} r={4} fill="var(--seq)" />}
          </g>
        )
      })}
      {labelled.map(({ r, i, y: ly }) => (
        <text key={i} x={W - pad.r + 9} y={ly + 3} fontSize="10" fill="var(--ink-2)">
          {r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name} · {pct(r.now!)}
        </text>
      ))}
    </svg>
  )
}
