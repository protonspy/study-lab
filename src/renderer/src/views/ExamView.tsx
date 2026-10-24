import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, ArrowRight, Check, ChevronDown, Flag, Grid3x3, Pause, Play, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ExamHistory, ScoreScale } from "@/components/charts"
import { domainColor, DomainDot, DomainLabel } from "@/components/Domain"
import { QuestionCard } from "@/components/QuestionCard"
import { Stat } from "@/components/Runner"
import { abandonExam, examLeaveQuestion, examPick, examUsedMs, finishExam, isCorrect, patchExam, shuffled, startExam, updateSettings } from "@/lib/actions"
import { data, DOMAINS, EXAM_FACTS, EXAM_MIX, shortSetName, sourceName } from "@/lib/data"
import { getState, useAppState } from "@/lib/store"
import { excerpt, fmtClock, fmtDuration, Highlighted, LETTERS } from "@/lib/text"
import type { ActiveExam, AppState, ExamResult } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

const half = () => Math.round(EXAM_FACTS.questions / 2)

function smartMix(s: AppState, scale: number): string[] {
  const out: string[] = []
  for (const d of DOMAINS) {
    const need = Math.round(EXAM_MIX[d.n] * scale)
    const pool = data().questions.filter((q) => q.d === d.n)
    const unseen = shuffled(pool.filter((q) => !s.srsq[q.id]))
    const seen = pool.filter((q) => s.srsq[q.id]).sort((a, b) => s.srsq[a.id].t - s.srsq[b.id].t)
    out.push(...[...unseen, ...seen].slice(0, need).map((q) => q.id))
  }
  return shuffled(out)
}

export function ExamView() {
  const s = useAppState()
  const [reviewAt, setReviewAt] = useState<number | null>(null)
  const active = s.meta.active
  if (active) return <ExamRunner a={active} onFinished={(r) => setReviewAt(r.at)} />
  const result = reviewAt != null ? s.meta.exams.find((e) => e.at === reviewAt) : undefined
  if (result) return <ExamResults r={result} onBack={() => setReviewAt(null)} />
  return <ExamSetup onReview={setReviewAt} />
}

function ExamSetup({ onReview }: { onReview: (at: number) => void }) {
  const s = useAppState()
  const [mode, setMode] = useState("smart")
  const [setName, setSetName] = useState(data().sets.find((x) => x.kind === "exam")?.name ?? "")
  const esl = s.meta.settings.esl
  const examSets = data().sets.filter((x) => x.kind === "exam")
  const n = mode === "set" ? (examSets.find((x) => x.name === setName)?.count ?? EXAM_FACTS.questions) : mode === "half" ? half() : EXAM_FACTS.questions
  // Shorter sets get the real exam's time per question.
  const extra = EXAM_FACTS.extraMinutes ?? 0
  const limit = Math.round(((EXAM_FACTS.minutes + (esl && extra ? extra : 0)) * n) / EXAM_FACTS.questions)

  function begin() {
    if (mode === "set") {
      const ids = data().questions.filter((q) => q.set === setName).map((q) => q.id)
      startExam("set", shortSetName(setName), ids, limit)
    } else if (mode === "half") {
      startExam("half", "Half-length smart mix", smartMix(s, 0.5), limit)
    } else {
      startExam("smart", "Smart mix", smartMix(s, 1), limit)
    }
  }

  return (
    <div>
      <PageHead eyebrow="Exam simulation" title="Mock exam">
        {EXAM_FACTS.questions} questions, {EXAM_FACTS.minutes} minutes, no feedback until you submit. Flag what you are unsure of and come back; never leave a
        question blank. Results land on the {EXAM_FACTS.min}–{EXAM_FACTS.max} scale with the pass mark at {EXAM_FACTS.pass}.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Set up</CardTitle>
            <CardDescription>Smart mix follows the exam guide weights and serves questions you have not seen first.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => v && setMode(v)} className="flex-wrap justify-start">
              <ToggleGroupItem value="smart">Smart mix · {EXAM_FACTS.questions}</ToggleGroupItem>
              <ToggleGroupItem value="set">Course practice exam</ToggleGroupItem>
              <ToggleGroupItem value="half">Half length · {half()}</ToggleGroupItem>
            </ToggleGroup>
            {mode === "set" && (
              <div className="space-y-1.5">
                <label htmlFor="exam-set" className="text-sm font-medium">
                  Exam
                </label>
                <Select value={setName} onValueChange={setSetName}>
                  <SelectTrigger id="exam-set" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {examSets.map((x) => (
                      <SelectItem key={x.name} value={x.name}>
                        {sourceName(x.src)} · {shortSetName(x.name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!!extra && (
              <>
                <div className="flex items-center gap-3">
                  <Switch id="esl" checked={esl} onCheckedChange={(v) => updateSettings({ esl: v })} />
                  <Label htmlFor="esl" className="font-normal">
                    {EXAM_FACTS.extraLabel ?? "Extra time"} (+{extra} minutes)
                  </Label>
                </div>
                <p className="text-xs text-ink-3">Practise with the time you will actually have on exam day.</p>
              </>
            )}
            <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
              <span className="font-mono tabular">{limit} min</span>
              <span className="text-ink-2">{n} questions · ≈ {(limit / n).toFixed(1)} min per question</span>
            </div>
            <Button size="lg" className="self-start" onClick={begin}>
              <Play /> Start the clock
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>{s.meta.exams.length ? "Select an attempt to review every question." : "Your attempts will appear here."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {s.meta.exams.length > 0 && <ExamHistory exams={s.meta.exams} />}
            <div className="flex flex-col divide-y divide-line">
              {[...s.meta.exams].reverse().map((e) => (
                <button key={e.at} type="button" onClick={() => onReview(e.at)} className="flex items-center gap-3 py-2.5 text-left hover:bg-surface-2/50">
                  <span className={cn("w-12 font-mono text-lg font-semibold tabular", e.score >= EXAM_FACTS.pass ? "text-good" : "text-bad")}>{e.score}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{e.label}</span>
                    <span className="block text-xs text-ink-3">
                      {new Date(e.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {e.correct}/{e.total} · {fmtDuration(e.sec)}
                    </span>
                  </span>
                  <ArrowRight className="size-4 text-ink-3" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ExamRunner({ a, onFinished }: { a: ActiveExam; onFinished: (r: ExamResult) => void }) {
  const [, tick] = useState(0)
  const [showGrid, setShowGrid] = useState(false)
  const [confirm, setConfirm] = useState<"submit" | "quit" | null>(null)
  const highlight = useAppState().meta.settings.highlight
  const running = a.since > 0
  const usedMs = examUsedMs(a)
  const leftMs = a.limitMin * 60000 - usedMs
  const id = a.ids[a.cur]
  const q = data().qById.get(id)!
  const order = a.order[id] ?? q.opts.map((_, i) => i)
  const picks = a.picks[id] ?? []
  const flagged = a.flags.includes(id)
  const answered = a.ids.filter((x) => (a.picks[x] ?? []).length > 0).length
  const unanswered = a.ids.length - answered

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    if (leftMs <= 0 && getState().meta.active) {
      const r = finishExam()
      toast("Time is up. Your exam was submitted.")
      if (r) onFinished(r)
    }
  })

  function toggle(orig: number) {
    const need = q.ans.length
    let next: number[]
    if (need === 1) next = [orig]
    else if (picks.includes(orig)) next = picks.filter((x) => x !== orig)
    else next = picks.length >= need ? [...picks.slice(1), orig] : [...picks, orig]
    patchExam(examPick(a, id, next))
  }
  const goTo = (i: number) => patchExam({ ...examLeaveQuestion(a), cur: Math.max(0, Math.min(a.ids.length - 1, i)) })
  const toggleFlag = () => patchExam({ flags: flagged ? a.flags.filter((x) => x !== id) : [...a.flags, id] })
  const pauseResume = () => (running ? patchExam({ ...examLeaveQuestion(a), used: usedMs, since: 0, qSince: 0 }) : patchExam({ since: Date.now(), qSince: Date.now() }))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || confirm) return
      const k = e.key.toUpperCase()
      const li = LETTERS.indexOf(k)
      if (li >= 0 && li < order.length && k !== "F") {
        e.preventDefault()
        toggle(order[li])
      } else if (k === "F") toggleFlag()
      else if (e.key === "ArrowRight" || k === "N") goTo(a.cur + 1)
      else if (e.key === "ArrowLeft" || k === "P") goTo(a.cur - 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  function submit() {
    setConfirm(null)
    const r = finishExam()
    if (r) onFinished(r)
  }

  const lowTime = leftMs < 10 * 60000

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-[calc(env(safe-area-inset-top,0px)+3.25rem)] z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 backdrop-blur md:top-[env(safe-area-inset-top,0px)]">
        <span className={cn("font-mono text-lg font-semibold tabular", lowTime && "text-bad")}>{fmtClock(leftMs)}</span>
        <Button variant="ghost" size="sm" onClick={pauseResume}>
          {running ? <Pause /> : <Play />} {running ? "Pause" : "Resume"}
        </Button>
        <span className="font-mono text-xs text-ink-3 tabular">
          Q {a.cur + 1}/{a.ids.length} · {answered} answered · {a.flags.length} flagged
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setShowGrid((g) => !g)} aria-expanded={showGrid}>
            <Grid3x3 /> <span className="hidden sm:inline">Navigator</span> <ChevronDown className={cn("transition-transform", showGrid && "rotate-180")} />
          </Button>
          <Button size="sm" onClick={() => setConfirm("submit")}>
            Review & submit
          </Button>
        </div>
      </div>

      {showGrid && <Navigator a={a} onPick={(i) => (goTo(i), setShowGrid(false))} />}

      {!running ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center">
          <Pause className="size-8 text-ink-3" />
          <p className="font-medium">Exam paused</p>
          <p className="max-w-sm text-sm text-ink-2">The question is hidden while the clock is stopped. The real exam has no pause, so use this sparingly.</p>
          <Button onClick={pauseResume}>
            <Play /> Resume
          </Button>
        </div>
      ) : (
        <article className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <header className="flex items-center gap-3">
            <span className="font-mono text-sm text-ink-3">Question {a.cur + 1}</span>
            <Button variant="ghost" size="sm" className={cn("ml-auto", flagged && "text-warn")} onClick={toggleFlag} aria-pressed={flagged}>
              <Flag className={cn(flagged && "fill-current")} /> {flagged ? "Flagged for review" : "Flag for review"}
            </Button>
          </header>
          <div className="space-y-3 text-[1.02rem] leading-relaxed">
            {q.stem.split("\n").filter(Boolean).map((p, i) => (
              <p key={i}>
                <Highlighted text={p} on={highlight} />
              </p>
            ))}
            {q.multi && <p className="eyebrow !text-ink-2">Select {q.ans.length === 2 ? "two" : "three"}</p>}
          </div>
          <ol className="flex flex-col gap-2.5">
            {order.map((orig, pos) => {
              const on = picks.includes(orig)
              return (
                <li key={orig}>
                  <button
                    type="button"
                    onClick={() => toggle(orig)}
                    aria-pressed={on}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors",
                      on ? "border-ink bg-surface-2" : "border-line hover:border-ink-3",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border font-mono text-xs",
                        on ? "border-ink bg-ink text-primary-foreground" : "border-line text-ink-2",
                      )}
                    >
                      {LETTERS[pos]}
                    </span>
                    <span className="min-w-0 flex-1">{q.opts[orig]}</span>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" onClick={() => goTo(a.cur - 1)} disabled={a.cur === 0}>
              <ArrowLeft /> Previous
            </Button>
            <span className="hidden text-xs text-ink-3 sm:inline">A–E choose · F flag · ← → move</span>
            {a.cur + 1 < a.ids.length ? (
              <Button onClick={() => goTo(a.cur + 1)}>
                Next <ArrowRight />
              </Button>
            ) : (
              <Button onClick={() => setConfirm("submit")}>Review & submit</Button>
            )}
          </div>
          <button type="button" className="self-center text-xs text-ink-3 underline underline-offset-4 hover:text-bad" onClick={() => setConfirm("quit")}>
            Abandon this attempt
          </button>
        </article>
      )}

      <AlertDialog open={confirm === "submit"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit the exam?</AlertDialogTitle>
            <AlertDialogDescription>
              {unanswered > 0
                ? `${unanswered} unanswered. Blank answers score zero, so guess before you submit.`
                : "Every question has an answer."}{" "}
              {a.flags.length > 0 && `${a.flags.length} flagged for review.`} {fmtClock(leftMs)} left on the clock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Navigator a={a} onPick={(i) => (setConfirm(null), goTo(i))} />
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            <AlertDialogAction onClick={submit}>Submit and score</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "quit"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abandon this attempt?</AlertDialogTitle>
            <AlertDialogDescription>Your answers in this attempt are discarded and nothing is scored or scheduled.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the exam</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-primary-foreground hover:bg-bad/90"
              onClick={() => {
                setConfirm(null)
                abandonExam()
              }}
            >
              Abandon
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Navigator({ a, onPick }: { a: ActiveExam; onPick: (i: number) => void }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(2.1rem,1fr))] gap-1.5">
        {a.ids.map((qid, i) => {
          const done = (a.picks[qid] ?? []).length > 0
          const fl = a.flags.includes(qid)
          return (
            <button
              key={qid}
              type="button"
              onClick={() => onPick(i)}
              aria-label={`Question ${i + 1}${done ? ", answered" : ""}${fl ? ", flagged" : ""}`}
              className={cn(
                "relative h-8 rounded-md border font-mono text-xs tabular",
                done ? "border-ink bg-ink text-primary-foreground" : "border-line text-ink-2",
                i === a.cur && "ring-2 ring-[var(--focus)] ring-offset-1 ring-offset-surface",
              )}
            >
              {i + 1}
              {fl && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border border-surface bg-marker" />}
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[0.7rem] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-ink" /> Answered
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-line" /> Blank
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-marker" /> Flagged
        </span>
      </div>
    </div>
  )
}

type Filter = "all" | "wrong" | "flagged" | "right"

function ExamResults({ r, onBack }: { r: ExamResult; onBack: () => void }) {
  const [filter, setFilter] = useState<Filter>("wrong")
  const [open, setOpen] = useState<string | null>(null)
  const rows = useMemo(
    () =>
      r.ids
        .map((id, i) => {
          const q = data().qById.get(id)
          if (!q) return null
          const p = r.picks[i] ?? []
          return { i, q, p, ok: isCorrect(q, p), flagged: r.flags.includes(id) }
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
    [r],
  )
  const shown = rows.filter((x) => (filter === "all" ? true : filter === "wrong" ? !x.ok : filter === "right" ? x.ok : x.flagged))
  const flaggedOk = rows.filter((x) => x.flagged && x.ok).length
  const flaggedN = rows.filter((x) => x.flagged).length

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> All attempts
        </Button>
        <p className="eyebrow mt-3">{new Date(r.at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}</p>
        <h1 className="mt-1 text-3xl font-semibold">{r.label}</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card>
          <CardContent className="flex flex-col gap-5">
            <ScoreScale score={r.score} label="Estimated scaled score" />
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Correct" value={`${r.correct}/${r.total}`} />
              <Stat label="Time used" value={fmtDuration(r.sec)} sub={`of ${r.limitMin} min`} />
              <Stat label="Flagged right" value={flaggedN ? `${flaggedOk}/${flaggedN}` : "—"} />
            </div>
            <p className="text-xs text-ink-3">
              The estimate maps your raw percentage linearly onto the {EXAM_FACTS.min}–{EXAM_FACTS.max} scale. Real exams often use scaled, compensatory scoring, so treat it as a trend, not a promise.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By domain</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {DOMAINS.map((d) => {
              const [ok, n] = r.perD[String(d.n)] ?? [0, 0]
              const pct = n ? Math.round((100 * ok) / n) : 0
              return (
                <div key={d.n} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <DomainDot d={d.n} /> {d.short}
                    </span>
                    <span className="font-mono tabular">
                      {ok}/{n} · {pct}%
                    </span>
                  </div>
                  <div className="relative h-2 rounded-full bg-surface-2">
                    <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: domainColor(d.n) }} />
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold">Review</h2>
          <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(v) => v && setFilter(v as Filter)}>
            <ToggleGroupItem value="wrong">Wrong ({rows.filter((x) => !x.ok).length})</ToggleGroupItem>
            <ToggleGroupItem value="flagged">Flagged ({flaggedN})</ToggleGroupItem>
            <ToggleGroupItem value="right">Right ({r.correct})</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex flex-col gap-2">
          {shown.map((x) => (
            <div key={x.q.id} className="rounded-lg border border-line bg-surface">
              <button
                type="button"
                className="flex w-full items-start gap-3 px-3.5 py-3 text-left"
                onClick={() => setOpen((o) => (o === x.q.id ? null : x.q.id))}
                aria-expanded={open === x.q.id}
              >
                <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", x.ok ? "bg-good-bg text-good" : "bg-bad-bg text-bad")}>
                  {x.ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    Q{x.i + 1} <DomainLabel d={x.q.d} />
                    {x.flagged && <span className="text-warn">Flagged</span>}
                    {!x.p.length && <span className="text-warn">Blank</span>}
                  </span>
                  <span className="mt-0.5 block text-sm">{excerpt(x.q.stem, 180)}</span>
                </span>
                <ChevronDown className={cn("mt-1 size-4 shrink-0 text-ink-3 transition-transform", open === x.q.id && "rotate-180")} />
              </button>
              {open === x.q.id && (
                <div className="border-t border-line px-3.5 py-4">
                  <QuestionCard q={x.q} mode="review" reviewPicks={x.p} order={x.q.opts.map((_, i) => i)} />
                </div>
              )}
            </div>
          ))}
          {!shown.length && <p className="py-6 text-center text-sm text-ink-3">Nothing in this filter.</p>}
        </div>
      </section>
    </div>
  )
}
