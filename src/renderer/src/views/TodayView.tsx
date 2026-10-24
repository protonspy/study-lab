import { useMemo } from "react"
import { ArrowRight, Brain, CalendarClock, Flame, Gauge, Layers, ListChecks, Repeat, Shuffle, Sparkles, Timer, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DomainBars, ExamHistory, Heatmap, Meter, ScoreScale } from "@/components/charts"
import { DomainDot } from "@/components/Domain"
import { updateSettings } from "@/lib/actions"
import { data, EXAM_FACTS, HAS_EXAM, LAB, PASS_ACC, useDataVersion } from "@/lib/data"
import { CoachPanel } from "@/components/CoachPanel"
import { go, run } from "@/lib/nav"
import { daysUntil } from "@/lib/srs"
import { buildDaily, dueSummary, heatmap, questionSprint, readiness, streak, suggestedNewPerDay, totals, weakTopics } from "@/lib/stats"
import { useAppState } from "@/lib/store"
import { fmtDuration, plural } from "@/lib/text"

const METHODS = [
  { Icon: Repeat, name: "Spaced repetition", body: "Each card and question returns just before you would forget it, with intervals capped by your exam date." },
  { Icon: Brain, name: "Retrieval practice", body: "You answer before you see anything. Pulling a fact out of memory strengthens it far more than re-reading." },
  { Icon: Shuffle, name: "Interleaving", body: "Sessions mix topics and domains, so you learn to tell similar services apart, the way the exam demands." },
  { Icon: Gauge, name: "Confidence marking", body: "Saying how sure you are exposes confident misses, the mistakes that are corrected best when reviewed right away." },
  { Icon: Zap, name: "Exam cues", body: "Scenario phrases mapped to the answer they point to: “LEAST overhead”, “find PII in S3”, “more creative output”." },
  { Icon: ListChecks, name: "Elaboration", body: "Every wrong option has a rationale. Explain why it fails before revealing it, and tag why you missed it." },
]

export function TodayView() {
  useDataVersion()
  const s = useAppState()
  const due = useMemo(() => dueSummary(s), [s])
  const ready = useMemo(() => readiness(s), [s.srsq, s.meta.exams]) // eslint-disable-line react-hooks/exhaustive-deps
  const weak = useMemo(() => weakTopics(s, 6), [s.srsq, s.srsc]) // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => heatmap(s, 14), [s.meta.log]) // eslint-disable-line react-hooks/exhaustive-deps
  const tot = totals(s)
  const st = streak(s)
  const left = daysUntil(s.meta.settings.examDate)
  const suggest = suggestedNewPerDay(s)
  const active = s.meta.active
  const reviewCount = due.cards + due.cues + due.qs
  const newAvail = Math.max(0, s.meta.settings.newCards - 0)
  const totalCards = data().cards.length

  return (
    <div className="flex flex-col gap-6">
      {active && (
        <div className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn-bg px-4 py-3 sm:flex-row sm:items-center">
          <Timer className="size-5 text-warn" />
          <p className="flex-1 text-sm">
            <span className="font-medium">Mock exam in progress:</span> {active.label}, question {active.cur + 1} of {active.ids.length}.
          </p>
          <Button size="sm" onClick={() => go("exam")}>
            Resume exam
          </Button>
        </div>
      )}

      {!data().topics.length && (
        <div className="flex flex-col gap-3 rounded-lg border border-ink bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <Sparkles className="size-5 shrink-0" />
          <p className="flex-1 text-sm">
            {data().allQuestions.length || LAB!.counts.lectures ? (
              <>
                <span className="font-medium">This lab has no topics yet.</span> Let the coach turn its {LAB!.counts.lectures} lectures and {data().allQuestions.length} questions into topics,
                notes and flashcards, so analytics and plans can work per topic.
              </>
            ) : (
              <>
                <span className="font-medium">This lab is empty.</span> Import a Udemy Study Export or a Study Lab data folder to begin.
              </>
            )}
          </p>
          <Button size="sm" onClick={() => go("content")}>
            {data().allQuestions.length || LAB!.counts.lectures ? "Build the knowledge base" : "Import content"}
          </Button>
        </div>
      )}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div>
            <p className="eyebrow">{LAB!.name}{HAS_EXAM ? ` · ${EXAM_FACTS.code}` : ""}</p>
            <h1 className="mt-2 text-4xl font-semibold leading-tight sm:text-5xl">
              {reviewCount > 0 ? (
                <>
                  <span className="hl">{plural(reviewCount, "review")}</span> due today
                </>
              ) : due.doneToday > 0 ? (
                <>Today's reviews are done</>
              ) : (
                <>Start your first session</>
              )}
            </h1>
            <p className="mt-3 max-w-xl text-ink-2">
              {left == null
                ? "Set your exam date and the scheduler will pace new material so everything gets reviewed before test day."
                : left < 0
                  ? "Your exam date has passed. Set the next one to keep the schedule exam-aware."
                  : left === 0
                    ? "Exam day. Skim your exam cues and mistakes, then go in rested."
                    : `${plural(left, "day")} to the exam. ${suggest ? `To see everything with time left to review, introduce about ${suggest.cards} cards and ${suggest.qs} questions a day.` : ""}`}
            </p>
          </div>

          <Card className="gap-4">
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <PlanStat label="Flashcards due" value={due.cards} />
                <PlanStat label="Exam cues due" value={due.cues} />
                <PlanStat label="Questions due" value={due.qs} />
                <PlanStat label="New today" value={`${due.newToday}`} sub={`limit ${newAvail} cards · ${s.meta.settings.newQs} Qs`} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="lg" onClick={() => run("Daily review", buildDaily(s), "today")}>
                  Start daily review <ArrowRight />
                </Button>
                <Button size="lg" variant="outline" onClick={() => run("20-question sprint", questionSprint(s, 20), "today")}>
                  <ListChecks /> 20-question sprint
                </Button>
                <Button size="lg" variant="outline" onClick={() => go("exam")}>
                  <Timer /> Mock exam
                </Button>
              </div>
              <p className="text-xs text-ink-3">
                The daily review mixes due flashcards, exam cues and questions with a few new ones, three cards to each question.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{HAS_EXAM ? "Exam readiness" : "Readiness"}</CardTitle>
            <CardDescription>
              {ready.reliable
                ? `From ${plural(ready.n, "first attempt")}, weighted by the exam guide.`
                : `Answer ${40 - ready.n} more new questions for a dependable estimate.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <ScoreScale score={ready.score} faint={!ready.reliable} />
            {ready.examAvg != null && (
              <p className="text-sm text-ink-2">
                Recent mock exams average <span className="font-semibold text-ink">{Math.round(ready.examAvg)}</span>.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="exam-date">Exam date</Label>
              <Input
                id="exam-date"
                type="date"
                value={s.meta.settings.examDate ?? ""}
                onChange={(e) => updateSettings({ examDate: e.target.value || null })}
                className="max-w-48"
              />
            </div>
          </CardContent>
        </Card>
      </section>

      <CoachPanel />

      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Domains</CardTitle>
            <CardDescription>Weighted by the lab's domain weights.</CardDescription>
          </CardHeader>
          <CardContent>
            <DomainBars per={ready.per} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where to focus next</CardTitle>
            <CardDescription>Lowest accuracy first; untested topics rank by exam weight.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-line">
            {!weak.length && <p className="text-sm text-ink-3">Topics appear here once the lab has a knowledge base.</p>}
            {weak.map(({ topic, st: ts, acc }) => (
              <div key={topic.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <DomainDot d={topic.d} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => go("notes", { topic: topic.id })}>
                  <p className="truncate text-sm font-medium hover:underline">{topic.title}</p>
                  <p className="text-xs text-ink-3">
                    {acc == null ? `Untested · ${ts.qTotal} questions` : `${Math.round(acc * 100)}% right · ${ts.qSeen}/${ts.qTotal} questions seen`}
                  </p>
                </button>
                <div className="hidden w-20 sm:block">
                  <Meter value={acc == null ? 0 : acc * 100} tone={acc == null ? "ink" : acc * 100 >= PASS_ACC ? "good" : acc >= 0.55 ? "warn" : "bad"} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => run(`Drill · ${topic.title}`, [...questionSprint(s, 8, { topic: topic.id })], "today")}
                >
                  Drill
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Study rhythm
              {st > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-marker-soft px-2 py-0.5 text-xs font-medium">
                  <Flame className="size-3.5" /> {plural(st, "day")} in a row
                </span>
              )}
            </CardTitle>
            <CardDescription>
              {fmtDuration(tot.sec)} studied · {tot.seenC.toLocaleString()} of {totalCards.toLocaleString()} cards and {tot.seenQ} of {data().questions.length} questions seen
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Heatmap days={days} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mock exams</CardTitle>
            <CardDescription>
              {s.meta.exams.length
                ? `${plural(s.meta.exams.length, "attempt")}. Aim for three in a row above ${EXAM_FACTS.pass} before test day.`
                : "No attempts yet. Take one early as a baseline, then one a week."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {s.meta.exams.length ? (
              <ExamHistory exams={s.meta.exams} />
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line p-4 text-sm text-ink-2">
                <CalendarClock className="size-5 text-ink-3" />
                {EXAM_FACTS.questions} questions in exam proportions, {EXAM_FACTS.minutes} minutes, scored on the {EXAM_FACTS.min}–{EXAM_FACTS.max} scale.
                <Button size="sm" variant="outline" onClick={() => go("exam")}>
                  Set up a mock exam
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">How the lab makes it stick</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {METHODS.map((m) => (
            <div key={m.name} className="flex gap-3 rounded-lg border border-line bg-surface p-4">
              <m.Icon className="mt-0.5 size-4 shrink-0 text-ink-2" />
              <div>
                <p className="text-sm font-medium">{m.name}</p>
                <p className="mt-0.5 text-sm text-ink-2">{m.body}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
          <Layers className="size-3.5" /> {totalCards.toLocaleString()} cards and {data().questions.length} practice questions in rotation.
        </p>
      </section>
    </div>
  )
}

function PlanStat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-ink-3">{label}</p>
      <p className="text-2xl font-semibold tabular">{typeof value === "number" ? value.toLocaleString() : value}</p>
      {sub && <p className="text-[0.7rem] text-ink-3">{sub}</p>}
    </div>
  )
}
