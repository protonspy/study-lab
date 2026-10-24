import { useEffect, useMemo, useState } from "react"
import { ArrowDownRight, ArrowRight, ArrowUpRight, Loader2, Play, Repeat2, Shuffle, Timer, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DomainDot } from "@/components/Domain"
import { Meter } from "@/components/charts"
import { TOPIC_STATE_LABEL, type LearnerSnapshot, type TopicReport, type TopicState } from "@shared/analytics"
import { data, LAB, useDataVersion } from "@/lib/data"
import { api } from "@/lib/lab"
import { go, run } from "@/lib/nav"
import { flush, useAppState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

/*
  Deterministic learning analytics, computed from the event log. The coach reads the same numbers,
  so what you see here is what it reasons about.
*/

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`)
const STATE_TONE: Record<TopicState, string> = {
  new: "bg-surface-2 text-ink-2",
  weak: "bg-bad-bg text-bad",
  learning: "bg-warn-bg text-warn",
  solid: "bg-good-bg text-good",
  mastered: "bg-good-bg text-good",
}

export function useSnapshot() {
  const s = useAppState()
  const v = useDataVersion()
  const [snap, setSnap] = useState<LearnerSnapshot | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      await flush()
      api()
        .snapshot(LAB!.id)
        .then((x) => live && setSnap(x))
        .catch((e: Error) => live && setErr(e.message))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [s.srsq, s.srsc, v])
  return { snap, err }
}

export function AnalyticsView() {
  const { snap, err } = useSnapshot()
  const [sort, setSort] = useState<"need" | "mastery" | "attempts" | "title">("need")
  const topics = useMemo(() => {
    if (!snap) return []
    const t = [...snap.topics]
    if (sort === "title") return t.sort((a, b) => a.title.localeCompare(b.title))
    if (sort === "attempts") return t.sort((a, b) => b.attempts - a.attempts)
    if (sort === "mastery") return t.sort((a, b) => b.mastery - a.mastery)
    const rank: Record<TopicState, number> = { weak: 0, learning: 1, new: 2, solid: 3, mastered: 4 }
    return t.sort((a, b) => rank[a.state] - rank[b.state] || a.mastery - b.mastery)
  }, [snap, sort])

  if (err) return <p className="text-bad">{err}</p>
  if (!snap) return <Loader2 className="size-5 animate-spin text-ink-3" />
  const o = snap.overview
  const tm = snap.time

  return (
    <div>
      <PageHead eyebrow={LAB!.name} title="Analytics">
        How you learn, measured from every attempt: speed, repeated errors, look-alike topics, confidence and forgetting. The AI coach reads these same numbers.
      </PageHead>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Attempts" value={o.attempts.toLocaleString()} sub={`${o.questionsSeen}/${o.questions} questions seen`} />
        <Tile label="First-try accuracy" value={pct(o.firstTry)} sub="predicts the exam best" />
        <Tile label="Last 50 answers" value={pct(o.recent)} sub={o.recent != null && o.firstTry != null ? (o.recent >= o.firstTry ? "above first-try" : "below first-try") : ""} />
        <Tile label="Study time" value={o.minutes >= 90 ? `${(o.minutes / 60).toFixed(1)} h` : `${o.minutes} min`} sub={`${o.activeDays14}/14 days active`} />
        <Tile label="Streak" value={`${o.streak} d`} sub={o.daysToExam != null ? `${o.daysToExam} days to exam` : "no exam date"} />
        <Tile label="Learned items" value={o.learnedItems.toLocaleString()} sub="interval of 3+ weeks" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Timer className="size-4" /> Time per answer
            </CardTitle>
            <CardDescription>{tm.paceSec ? `Exam pace is ${tm.paceSec}s per question.` : "No exam pace set for this lab."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <Row label="Median" value={tm.medianSec != null ? `${tm.medianSec}s` : "—"} />
            <Row label="Median when right" value={tm.medianRightSec != null ? `${tm.medianRightSec}s` : "—"} />
            <Row label="Median when wrong" value={tm.medianWrongSec != null ? `${tm.medianWrongSec}s` : "—"} />
            {tm.paceSec != null && <Row label="Slower than exam pace" value={pct(tm.overPace)} />}
            <Row label="Rapid answers" value={`${tm.rapid}${tm.rapid ? ` · ${pct(tm.rapidAccuracy)} right` : ""}`} hint="Faster than a third of the time needed to read the question" />
            <Row label="Right but slow (1.5× pace)" value={String(tm.slowRight)} hint="Known, but not fluent yet" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="size-4" /> Calibration
            </CardTitle>
            <CardDescription>Accuracy for each confidence you chose. Well calibrated: “sure” is nearly always right.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snap.calibration.map((c) => (
              <div key={c.conf} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="capitalize">{c.conf}</span>
                  <span className="font-mono tabular">
                    {pct(c.accuracy)} <span className="text-ink-3">of {c.n}</span>
                  </span>
                </div>
                <Meter value={(c.accuracy ?? 0) * 100} tone={c.accuracy == null ? "ink" : c.accuracy >= 0.85 ? "good" : c.accuracy >= 0.6 ? "warn" : "bad"} />
              </div>
            ))}
            <div className="mt-2 border-t border-line pt-3 text-sm">
              <p className="font-medium">Changing your answer</p>
              <p className="text-ink-2">
                {snap.changes.changed
                  ? `${snap.changes.changed} changed answers: ${snap.changes.toRight} wrong→right, ${snap.changes.toWrong} right→wrong.`
                  : "No changed answers recorded yet."}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Domains</CardTitle>
            <CardDescription>First-try accuracy by domain.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snap.domains.map((d) => (
              <div key={d.d} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <DomainDot d={d.d} /> <span className="truncate">{d.name}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular">{pct(d.accuracy)}</span>
                </div>
                <Meter value={(d.accuracy ?? 0) * 100} />
                <p className="text-[0.7rem] text-ink-3">
                  {d.seen}/{d.total} seen · weight {d.w}%
                </p>
              </div>
            ))}
            {!!snap.byHour.length && (
              <div className="mt-2 border-t border-line pt-3">
                <p className="text-sm font-medium">Accuracy by hour</p>
                <div className="mt-2 flex items-end gap-1" role="img" aria-label="Accuracy by hour of day">
                  {snap.byHour.map((h) => (
                    <div key={h.hour} className="flex flex-1 flex-col items-center gap-1" title={`${h.hour}:00 · ${pct(h.accuracy)} of ${h.n}`}>
                      <div className="flex h-16 w-full items-end">
                        <div className="w-full rounded-t-[4px] bg-ink/70" style={{ height: `${Math.max(4, h.accuracy * 100)}%` }} />
                      </div>
                      <span className="font-mono text-[0.6rem] text-ink-3">{h.hour}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Topics</CardTitle>
            <CardDescription>Mastery weighs recent attempts more. The curve shows the error rate over your 1st–3rd, 4th–6th, 7th–10th and later attempts; it should fall.</CardDescription>
          </div>
          <div className="flex gap-1 text-xs">
            {(["need", "mastery", "attempts", "title"] as const).map((k) => (
              <Button key={k} variant={sort === k ? "secondary" : "ghost"} size="sm" onClick={() => setSort(k)}>
                {k === "need" ? "Needs work" : k[0].toUpperCase() + k.slice(1)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="pb-2 font-normal">Topic</th>
                <th className="pb-2 font-normal">State</th>
                <th className="w-40 pb-2 font-normal">Mastery</th>
                <th className="pb-2 text-right font-normal">Attempts</th>
                <th className="pb-2 text-right font-normal">Accuracy</th>
                <th className="pb-2 text-right font-normal">Median</th>
                <th className="pb-2 text-right font-normal">Repeats</th>
                <th className="pb-2 pl-4 font-normal">Curve</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {topics.map((t) => (
                <TopicRow key={t.id} t={t} />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Repeat2 className="size-4" /> Repeated errors
            </CardTitle>
            <CardDescription>Missed twice or more. “Same pick” means you chose the same wrong option again: a misconception, not a slip.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {snap.repeated.slice(0, 8).map((r) => (
              <QLine key={r.qid} qid={r.qid} meta={`${r.wrong}× wrong${r.samePick ? " · same pick" : ""}`} bad={r.samePick} />
            ))}
            {!snap.repeated.length && <p className="text-sm text-ink-3">None yet.</p>}
            {!!snap.repeated.length && (
              <Button size="sm" variant="outline" className="mt-1 w-fit" onClick={() => run("Repeated errors", snap.repeated.map((r) => ({ kind: "q", id: r.qid })), "analytics")}>
                <Play /> Practise these
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shuffle className="size-4" /> Look-alike topics
            </CardTitle>
            <CardDescription>Pairs of topics that keep showing up together in your misses.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {snap.confusions.slice(0, 8).map((c) => {
              const a = data().topicById.get(c.a)
              const b = data().topicById.get(c.b)
              return (
                <button
                  key={`${c.a}|${c.b}`}
                  type="button"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => run(`${a?.title} vs ${b?.title}`, c.qids.map((id) => ({ kind: "q", id })), "analytics")}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {a?.title ?? c.a} <span className="text-ink-3">↔</span> {b?.title ?? c.b}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-ink-3">{c.misses} misses</span>
                </button>
              )
            })}
            {!snap.confusions.length && <p className="text-sm text-ink-3">No pattern yet.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Forgotten</CardTitle>
            <CardDescription>Right once, then wrong after 3+ days: memory, not understanding. More spaced retrieval fixes these.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {snap.forgotten.slice(0, 8).map((f) => (
              <QLine key={f.qid} qid={f.qid} meta={`after ${f.gapDays}d`} />
            ))}
            {!snap.forgotten.length && <p className="text-sm text-ink-3">Nothing forgotten so far.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-ink-3">{label}</p>
        <p className="mt-1 font-heading text-2xl font-semibold tabular">{value}</p>
        {sub && <p className="mt-0.5 truncate text-[0.7rem] text-ink-3">{sub}</p>}
      </CardContent>
    </Card>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <span className="text-ink-2">{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  )
}

function TopicRow({ t }: { t: TopicReport }) {
  const Trend = t.trend === "up" ? ArrowUpRight : t.trend === "down" ? ArrowDownRight : t.trend === "flat" ? ArrowRight : null
  return (
    <tr>
      <td className="py-2 pr-3">
        <button type="button" className="flex items-center gap-2 text-left hover:underline" onClick={() => go("notes", { topic: t.id })}>
          <DomainDot d={t.d} />
          <span className="line-clamp-1">{t.title}</span>
        </button>
      </td>
      <td className="py-2 pr-3">
        <span className={cn("rounded-full px-2 py-0.5 text-[0.7rem] font-medium", STATE_TONE[t.state])}>{TOPIC_STATE_LABEL[t.state]}</span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <Meter value={t.mastery * 100} tone={t.state === "weak" ? "bad" : t.state === "learning" ? "warn" : t.state === "new" ? "ink" : "good"} className="w-24" />
          <span className="font-mono text-xs tabular">{Math.round(t.mastery * 100)}</span>
          {Trend && <Trend className={cn("size-3.5", t.trend === "up" ? "text-good" : t.trend === "down" ? "text-bad" : "text-ink-3")} aria-label={`trend ${t.trend}`} />}
        </div>
      </td>
      <td className="py-2 text-right font-mono tabular">{t.attempts}</td>
      <td className="py-2 text-right font-mono tabular">{pct(t.accuracy)}</td>
      <td className="py-2 text-right font-mono tabular">{t.medianSec != null ? `${t.medianSec}s` : "—"}</td>
      <td className={cn("py-2 text-right font-mono tabular", t.repeatWrong > 0 && "text-bad")}>{t.repeatWrong || "—"}</td>
      <td className="py-2 pl-4">
        <Curve values={t.curve} />
      </td>
      <td className="py-2 pl-2 text-right">
        <Button
          size="sm"
          variant="ghost"
          disabled={!t.questions}
          onClick={() => run(`Practice · ${t.title}`, (data().qByTopic.get(t.id) ?? []).slice(0, 15).map((q) => ({ kind: "q", id: q.id })), "analytics")}
        >
          <Play /> Practise
        </Button>
      </td>
    </tr>
  )
}

/** Error rate by practice opportunity, as four small bars (lower is better). */
function Curve({ values }: { values: (number | null)[] }) {
  const labels = ["1–3", "4–6", "7–10", "11+"]
  return (
    <div className="flex h-6 items-end gap-0.5" role="img" aria-label={`Error rate: ${values.map((v, i) => `${labels[i]} ${v == null ? "none" : pct(v)}`).join(", ")}`}>
      {values.map((v, i) => (
        <div key={i} className="flex h-full w-3 items-end" title={`attempts ${labels[i]}: ${v == null ? "no data" : `${pct(v)} wrong`}`}>
          {v == null ? <div className="h-px w-full bg-line" /> : <div className="w-full rounded-t-[3px] bg-bad/80" style={{ height: `${Math.max(8, v * 100)}%` }} />}
        </div>
      ))}
    </div>
  )
}

function QLine({ qid, meta, bad }: { qid: string; meta: string; bad?: boolean }) {
  const q = data().qById.get(qid)
  if (!q) return null
  return (
    <button type="button" className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => run("Question", [{ kind: "q", id: qid }], "analytics")}>
      <span className="line-clamp-2 min-w-0 flex-1">{q.stem}</span>
      <span className={cn("shrink-0 font-mono text-[0.7rem]", bad ? "text-bad" : "text-ink-3")}>{meta}</span>
    </button>
  )
}
