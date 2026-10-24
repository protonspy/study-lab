import { useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  Bot,
  CalendarRange,
  Check,
  CircleAlert,
  Lightbulb,
  ListTodo,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { TopicChip } from "@/components/Domain"
import { JobStrip, startCoachJob } from "@/components/Jobs"
import { Markdown } from "@/components/Markdown"
import { dayKey } from "@shared/analytics"
import { data, LAB, useDataVersion } from "@/lib/data"
import { api, onChat, useCoachVersion, useJobs } from "@/lib/lab"
import { go, useNav } from "@/lib/nav"
import { canStart, planProgress, startTask } from "@/lib/plan"
import { flush } from "@/lib/store"
import type { ChangeEntry, ChatMessage, ChatThread, InsightReport, PlanTask, StudyPlan } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"
import { useSnapshot } from "@/views/AnalyticsView"

export function CoachView() {
  const nav = useNav()
  const [tab, setTab] = useState(nav.params.tab ?? "plan")
  useEffect(() => {
    if (nav.params.tab) setTab(nav.params.tab)
  }, [nav.params.tab])
  return (
    <div>
      <PageHead eyebrow={LAB!.name} title="Coach">
        Your AI study coach reads your analytics, finds what is holding you back, plans your days and writes new material. Everything it changes can be undone.
      </PageHead>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="plan">
            <CalendarRange /> Plan
          </TabsTrigger>
          <TabsTrigger value="insights">
            <Lightbulb /> Insights
          </TabsTrigger>
          <TabsTrigger value="chat">
            <MessageSquare /> Chat
          </TabsTrigger>
          <TabsTrigger value="create">
            <Sparkles /> Create
          </TabsTrigger>
          <TabsTrigger value="activity">
            <ListTodo /> Activity
          </TabsTrigger>
        </TabsList>
        <TabsContent value="plan">
          <PlanTab />
        </TabsContent>
        <TabsContent value="insights">
          <InsightsTab />
        </TabsContent>
        <TabsContent value="chat">
          <ChatTab />
        </TabsContent>
        <TabsContent value="create">
          <CreateTab />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ---------- shared ---------- */

export function usePlans() {
  const v = useCoachVersion()
  const [plans, setPlans] = useState<StudyPlan[] | null>(null)
  useEffect(() => {
    void api().plans(LAB!.id).then(setPlans)
  }, [v])
  return [plans, setPlans] as const
}

export function useInsights() {
  const v = useCoachVersion()
  const [list, setList] = useState<InsightReport[] | null>(null)
  useEffect(() => {
    void api().insights(LAB!.id).then(setList)
  }, [v])
  return [list, setList] as const
}

const TASK_LABEL: Record<PlanTask["type"], string> = {
  review: "Review",
  practice: "Practice",
  cards: "Flashcards",
  cues: "Exam cues",
  notes: "Notes",
  guide: "Guide",
  exam: "Mock exam",
  collection: "Practice set",
  mistakes: "Mistakes",
  custom: "Task",
}

export function TaskRow({ plan, task, onChange }: { plan: StudyPlan; task: PlanTask; onChange: (p: StudyPlan) => void }) {
  return (
    <li className={cn("flex items-start gap-3 py-2", task.done && "opacity-60")}>
      <Checkbox
        checked={!!task.done}
        className="mt-0.5"
        aria-label="Done"
        onCheckedChange={async (v) => onChange(await api().setTaskDone(LAB!.id, plan.id, task.id, !!v))}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium", task.done && "line-through")}>
          {task.title} <span className="font-mono text-xs font-normal text-ink-3">· {task.minutes} min</span>
        </p>
        <p className="text-xs text-ink-3">
          {TASK_LABEL[task.type]}
          {task.count ? ` · ${task.count} items` : ""}
          {task.why ? ` · ${task.why}` : ""}
        </p>
        {!!task.topics.length && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {task.topics.map((t) => (
              <TopicChip key={t} id={t} />
            ))}
          </div>
        )}
      </div>
      {canStart(task) && !task.done && (
        <Button size="sm" variant="outline" onClick={() => startTask(task)}>
          <Play /> Start
        </Button>
      )}
    </li>
  )
}

/* ---------- plan ---------- */

function PlanTab() {
  const [plans, setPlans] = usePlans()
  const active = plans?.find((p) => p.status === "active") ?? null
  const past = plans?.filter((p) => p.status !== "active") ?? []
  const [days, setDays] = useState("7")
  const [minutes, setMinutes] = useState("60")
  const [instructions, setInstructions] = useState("")
  const running = useJobs().some((j) => j.kind === "plan" && j.status === "running")
  const today = dayKey()

  const make = () => void startCoachJob(LAB!.id, "plan", { days: Number(days) || 7, minutesPerDay: Number(minutes) || 60, instructions: instructions.trim() || undefined })
  const update = (p: StudyPlan) => setPlans((ps) => ps?.map((x) => (x.id === p.id ? p : x)) ?? null)

  if (!plans) return <Loader2 className="size-5 animate-spin text-ink-3" />
  const prog = active ? planProgress(active) : null

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        {active ? (
          <Card>
            <CardHeader>
              <p className="eyebrow">
                Active plan · from {active.start} · {prog!.done}/{prog!.total} tasks
              </p>
              <CardTitle className="text-xl">{active.title}</CardTitle>
              <CardDescription>{active.goal}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Collapsible>
                <CollapsibleTrigger className="text-sm underline underline-offset-2">Why this plan</CollapsibleTrigger>
                <CollapsibleContent>
                  <Markdown text={active.rationale} className="mt-2 text-sm text-ink-2" />
                </CollapsibleContent>
              </Collapsible>
              {active.days.map((d) => (
                <div key={d.day} className={cn("rounded-lg border px-4 py-3", d.date === today ? "border-ink bg-surface" : "border-line", d.date < today && "opacity-75")}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-medium">
                      Day {d.day} <span className="font-normal text-ink-3">· {new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
                      {d.date === today && <span className="ml-2 rounded-full bg-marker px-2 py-0.5 text-[0.7rem] font-semibold text-marker-ink">today</span>}
                    </p>
                    <p className="font-mono text-xs text-ink-3">{d.tasks.reduce((a, t) => a + t.minutes, 0)} min</p>
                  </div>
                  <p className="text-sm text-ink-2">{d.focus}</p>
                  <ul className="mt-1 divide-y divide-line">
                    {d.tasks.map((t) => (
                      <TaskRow key={t.id} plan={active} task={t} onChange={update} />
                    ))}
                  </ul>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await api().setPlanStatus(LAB!.id, active.id, "archived")
                    setPlans(await api().plans(LAB!.id))
                  }}
                >
                  <Archive /> Archive plan
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 py-8">
              <CalendarRange className="size-8 text-ink-3" />
              <p className="font-heading text-xl font-semibold">No active plan</p>
              <p className="max-w-lg text-sm text-ink-2">
                The coach looks at your weakest and untouched topics, your mistakes and your exam date, then pins focus topics, builds practice sets and lays out each day. Study a little first so
                it has data to work with.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{active ? "Replan" : "Make a plan"}</CardTitle>
            <CardDescription>A new plan replaces the active one (the old one is archived).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="plan-days">Days</Label>
                <Input id="plan-days" value={days} onChange={(e) => setDays(e.target.value)} className="w-20 font-mono" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan-min">Minutes a day</Label>
                <Input id="plan-min" value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-24 font-mono" inputMode="numeric" />
              </div>
            </div>
            <Textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Anything to respect? e.g. no study on Sundays, mock exam every Saturday, focus on D3." />
            <div className="flex flex-wrap gap-2">
              <Button onClick={make} disabled={running}>
                {running ? <Loader2 className="animate-spin" /> : <Sparkles />} {active ? "Replan with the coach" : "Plan with the coach"}
              </Button>
              <Button
                variant="outline"
                disabled={running}
                onClick={async () => {
                  await api().autoPlan(LAB!.id, Number(days) || 7, Number(minutes) || undefined)
                  setPlans(await api().plans(LAB!.id))
                  toast.success("Plan computed from your learner model")
                }}
              >
                <CalendarRange /> Plan without AI
              </Button>
            </div>
            <p className="text-xs text-ink-3">
              Both start from the same deterministic schedule (spaced reviews, retests, mock exams, highest-priority concepts). The coach adds explanations and adjusts within limits.
            </p>
            <JobStrip kinds={["plan"]} />
          </CardContent>
        </Card>
        {!!past.length && (
          <Card>
            <CardHeader>
              <CardTitle>Earlier plans</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {past.slice(0, 8).map((p) => {
                const pr = planProgress(p)
                return (
                  <div key={p.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    <span className="font-mono text-xs text-ink-3">
                      {pr.done}/{pr.total}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api().setPlanStatus(LAB!.id, p.id, "active")
                        setPlans(await api().plans(LAB!.id))
                      }}
                    >
                      Reactivate
                    </Button>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

/* ---------- insights ---------- */

const SEV: Record<string, string> = {
  high: "bg-bad-bg text-bad",
  medium: "bg-warn-bg text-warn",
  low: "bg-surface-2 text-ink-2",
  positive: "bg-good-bg text-good",
}

function InsightsTab() {
  const [list, setList] = useInsights()
  const { snap } = useSnapshot()
  const running = useJobs().some((j) => j.kind === "analyze" && j.status === "running")
  const [idx, setIdx] = useState(0)
  const r = list?.[idx]
  if (!list) return <Loader2 className="size-5 animate-spin text-ink-3" />
  const attempts = snap?.overview.attempts ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void startCoachJob(LAB!.id, "analyze", {}, () => setIdx(0))} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <Sparkles />} Analyse my learning
        </Button>
        {attempts < 30 && <p className="text-sm text-ink-3">Only {attempts} answers so far; insights get sharper after 50–100.</p>}
        {list.length > 1 && (
          <div className="ml-auto flex gap-1">
            {list.slice(0, 6).map((x, i) => (
              <Button key={x.id} size="sm" variant={i === idx ? "secondary" : "ghost"} onClick={() => setIdx(i)}>
                {new Date(x.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
              </Button>
            ))}
          </div>
        )}
      </div>
      <JobStrip kinds={["analyze"]} />
      {!r ? (
        <Card>
          <CardContent className="py-8 text-sm text-ink-2">
            No reports yet. The coach reads your analytics and actual wrong answers and tells you what is really going on: gaps, misconceptions, forgetting, rushing, look-alike topics.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <p className="eyebrow">
                  {new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {r.model}
                </p>
                <CardTitle className="text-xl leading-snug">{r.headline}</CardTitle>
              </CardHeader>
              <CardContent>
                <Markdown text={r.summary} className="text-ink-2" />
              </CardContent>
            </Card>
            {r.insights.map((i, k) => (
              <Card key={k}>
                <CardContent className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] font-medium", SEV[i.severity])}>{i.severity}</span>
                    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[0.7rem] text-ink-3">{i.kind}</span>
                    <p className="font-medium leading-snug">{i.title}</p>
                  </div>
                  <Markdown text={i.detail} className="text-sm text-ink-2" />
                  {!!i.topics.length && (
                    <div className="flex flex-wrap gap-1">
                      {i.topics.map((t) => (
                        <TopicChip key={t} id={t} />
                      ))}
                    </div>
                  )}
                  {!!i.evidence.length && <p className="font-mono text-[0.7rem] text-ink-3">{i.evidence.join(" · ")}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            {!!r.next.length && (
              <Card>
                <CardHeader>
                  <CardTitle>Next actions</CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                    {r.next.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ol>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => go("coach", { tab: "plan" })}>
                      <CalendarRange /> Turn into a plan
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => go("coach", { tab: "create" })}>
                      <Sparkles /> Create material
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
            {!!r.misconceptions.length && (
              <Card>
                <CardHeader>
                  <CardTitle>Misconceptions</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  {r.misconceptions.map((m, i) => (
                    <div key={i} className="rounded-md bg-surface-2 px-3 py-2">
                      <p className="text-bad">✗ {m.belief}</p>
                      <p className="mt-1 text-good">✓ {m.correction}</p>
                      {data().topicById.has(m.topic) && <TopicChip id={m.topic} className="mt-2" />}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            {!!r.strengths.length && (
              <Card>
                <CardHeader>
                  <CardTitle>Going well</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
                    {r.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="w-fit text-ink-3"
              onClick={async () => {
                await api().deleteInsight(LAB!.id, r.id)
                setList(await api().insights(LAB!.id))
                setIdx(0)
              }}
            >
              <Trash2 /> Delete this report
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- chat ---------- */

const STARTERS = [
  "What should I study today, and why?",
  "Which topics do I keep confusing? Make me a comparison guide.",
  "Am I rushing? Look at my time per answer.",
  "Archive the cards I have clearly learned.",
  "Create 5 hard questions on my weakest topic.",
]

function ChatTab() {
  const lab = LAB!
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [live, setLive] = useState<ChatMessage | null>(null)
  const [text, setText] = useState("")
  const busy = useJobs().some((j) => j.kind === "chat" && j.status === "running")
  const end = useRef<HTMLDivElement>(null)

  const loadThreads = () => void api().threads(lab.id).then(setThreads)
  useEffect(loadThreads, [lab.id])
  useEffect(() => {
    setLive(null)
    if (cur) void api().messages(lab.id, cur).then(setMsgs)
    else setMsgs([])
  }, [cur, lab.id])
  useEffect(
    () =>
      onChat((threadId, m) => {
        if (threadId !== cur) return
        if (m.id < 0) setLive(m)
        else {
          setMsgs((xs) => (xs.some((x) => x.id === m.id) ? xs : [...xs, m]))
          if (m.role === "assistant") setLive(null)
        }
      }),
    [cur],
  )
  useEffect(() => {
    // Chromium's scrollIntoView now returns a promise; never hand it to React as a cleanup.
    void end.current?.scrollIntoView({ block: "end" })
  }, [msgs, live])

  async function send(t = text) {
    const body = t.trim()
    if (!body || busy) return
    const ai = await api().aiSettings()
    if (!ai.hasKey) return toast.error("Add your OpenRouter key in Settings → AI coach first.")
    await flush()
    setText("")
    const r = await api().sendChat(lab.id, cur, body)
    if (r.threadId !== cur) {
      setCur(r.threadId)
      loadThreads()
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <Button variant="outline" size="sm" className="mb-2 justify-start" onClick={() => setCur(null)}>
          <Plus /> New chat
        </Button>
        {threads.map((t) => (
          <div key={t.id} className={cn("group flex items-center rounded-md", t.id === cur && "bg-surface-2")}>
            <button type="button" onClick={() => setCur(t.id)} className="min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-sm">
              {t.title}
            </button>
            <button
              type="button"
              aria-label="Delete chat"
              className="px-2 text-ink-3 opacity-0 group-hover:opacity-100"
              onClick={async () => {
                await api().deleteThread(lab.id, t.id)
                if (cur === t.id) setCur(null)
                loadThreads()
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <Card className="flex min-h-[60dvh] flex-col">
        <CardContent className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {!msgs.length && !live && (
            <div className="flex flex-col gap-3 py-6">
              <Bot className="size-8 text-ink-3" />
              <p className="text-ink-2">Ask about your progress, or ask the coach to change things: write cards, make a practice set, archive what you know, adjust your plan.</p>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <Button key={s} variant="outline" size="sm" className="h-auto whitespace-normal py-1.5 text-left" onClick={() => void send(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {live && <Bubble m={live} pending />}
          {busy && !live && (
            <p className="flex items-center gap-2 text-sm text-ink-3">
              <Loader2 className="size-4 animate-spin" /> Thinking…
            </p>
          )}
          <div ref={end} />
        </CardContent>
        <div className="flex items-end gap-2 border-t border-line p-3">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Message the coach (Enter to send, Shift+Enter for a new line)"
            className="min-h-0 flex-1 resize-none"
          />
          <Button onClick={() => void send()} disabled={busy || !text.trim()} aria-label="Send">
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function Bubble({ m, pending }: { m: ChatMessage; pending?: boolean }) {
  if (m.role === "user")
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-sm text-primary-foreground">
        <p className="whitespace-pre-wrap">{m.content}</p>
      </div>
    )
  return (
    <div className="max-w-[92%]">
      {!!m.tools?.length && (
        <div className="mb-2 flex flex-wrap gap-1">
          {m.tools.map((t, i) => (
            <span
              key={i}
              title={t.summary || t.args}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[0.68rem]", t.ok === false ? "border-bad/40 text-bad" : "border-line text-ink-3")}
            >
              <Wrench className="size-3" /> {t.name}
              {t.summary ? ` · ${t.summary}` : ""}
            </span>
          ))}
          {pending && <Loader2 className="size-3.5 animate-spin text-ink-3" />}
        </div>
      )}
      {m.content && <Markdown text={m.content} />}
    </div>
  )
}

/* ---------- create ---------- */

function CreateTab() {
  useDataVersion()
  const { snap } = useSnapshot()
  const lab = LAB!
  const d = data()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [cards, setCards] = useState("8")
  const [questions, setQuestions] = useState("4")
  const [guide, setGuide] = useState(true)
  const [instructions, setInstructions] = useState("")
  const running = useJobs().some((j) => j.kind === "generate" && j.status === "running")

  const ranked = useMemo(() => {
    if (!snap) return d.topics.map((t) => ({ id: t.id, title: t.title, note: "" }))
    return [...snap.topics]
      .sort((a, b) => (a.state === "weak" ? -1 : 0) - (b.state === "weak" ? -1 : 0) || a.mastery - b.mastery)
      .map((t) => ({ id: t.id, title: t.title, note: `${t.state} · ${Math.round(t.mastery * 100)}${t.repeatWrong ? ` · ${t.repeatWrong} repeats` : ""}` }))
  }, [snap, d.topics])

  const recent = useMemo(() => {
    const qs = d.allQuestions.filter((q) => q.src === "agent").map((q) => ({ id: q.id, kind: "Question", text: q.stem, at: q.created ?? 0 }))
    const cs = d.allCards.filter((c) => c.s === "A").map((c) => ({ id: c.id, kind: "Card", text: c.f, at: c.created ?? 0 }))
    const gs = d.topics.flatMap((t) => (t.guides ?? []).map((g) => ({ id: g.id, kind: "Guide", text: `${g.title} — ${t.title}`, at: g.at, topic: t.id })))
    return [...qs, ...cs, ...gs].sort((a, b) => b.at - a.at).slice(0, 30)
  }, [d])

  const toggle = (id: string) => setPicked((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))))

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Create study material</CardTitle>
          <CardDescription>
            The coach reads your mistakes and the course transcripts, then writes a guide aimed at your misconceptions, flashcards and new exam-style questions. Leave topics empty and it picks
            where you need it most.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="max-h-64 overflow-y-auto rounded-md border border-line">
            {ranked.map((t) => (
              <label key={t.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2">
                <Checkbox checked={picked.has(t.id)} onCheckedChange={() => toggle(t.id)} />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 text-[0.7rem] text-ink-3">{t.note}</span>
              </label>
            ))}
            {!ranked.length && <p className="px-3 py-4 text-sm text-ink-3">No topics yet. Build the knowledge base in Content first.</p>}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="gen-cards">Flashcards / topic</Label>
              <Input id="gen-cards" value={cards} onChange={(e) => setCards(e.target.value)} className="w-24 font-mono" inputMode="numeric" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gen-qs">Questions / topic</Label>
              <Input id="gen-qs" value={questions} onChange={(e) => setQuestions(e.target.value)} className="w-24 font-mono" inputMode="numeric" />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Switch checked={guide} onCheckedChange={setGuide} /> Study guide
            </label>
          </div>
          <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional: e.g. focus on scenario questions, compare services in a table, write in Portuguese." />
          <Button
            className="w-fit"
            disabled={running || !d.topics.length}
            onClick={() =>
              void startCoachJob(lab.id, "generate", {
                topics: [...picked],
                cards: Number(cards) || 0,
                questions: Number(questions) || 0,
                guide,
                instructions: instructions.trim() || undefined,
              })
            }
          >
            {running ? <Loader2 className="animate-spin" /> : <Sparkles />} Create with the coach
          </Button>
          <JobStrip kinds={["generate"]} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Made by the coach</CardTitle>
          <CardDescription>New items join your daily reviews. Manage or retire them in Content.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {recent.map((x) => (
            <button
              key={x.id}
              type="button"
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
              onClick={() => ("topic" in x ? go("notes", { topic: x.topic as string, guide: x.id }) : go("content"))}
            >
              <span className="w-16 shrink-0 text-xs text-ink-3">{x.kind}</span>
              <span className="line-clamp-2 min-w-0 flex-1">{x.text}</span>
            </button>
          ))}
          {!recent.length && <p className="text-sm text-ink-3">Nothing yet.</p>}
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------- activity ---------- */

function ActivityTab() {
  const v = useCoachVersion()
  const lab = LAB!
  const [list, setList] = useState<ChangeEntry[] | null>(null)
  const load = () => void api().changes(lab.id).then(setList)
  useEffect(load, [v, lab.id])
  const jobs = useJobs()

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Changes to this lab</CardTitle>
          <CardDescription>Everything the coach or an MCP client wrote. Undo restores what was there before that change.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-line">
            {list?.map((c) => (
              <li key={c.id} className={cn("flex items-start gap-3 py-2.5 text-sm", c.undone && "opacity-50")}>
                <span className="w-24 shrink-0 font-mono text-[0.7rem] text-ink-3">
                  {new Date(c.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn(c.undone && "line-through")}>{c.summary}</p>
                  <p className="font-mono text-[0.68rem] text-ink-3">
                    {c.tool} · {c.actor}
                  </p>
                </div>
                {!c.undone && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const r = await api().undoChange(lab.id, c.id)
                      if (r.ok) toast.success("Undone")
                      else toast.error(r.error)
                      load()
                    }}
                  >
                    <Undo2 /> Undo
                  </Button>
                )}
              </li>
            ))}
            {list && !list.length && <li className="py-6 text-sm text-ink-3">The coach has not changed anything yet.</li>}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent coach runs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {jobs.map((j) => (
            <div key={j.id} className="flex items-center gap-2">
              {j.status === "running" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : j.status === "done" ? (
                <Check className="size-3.5 text-good" />
              ) : j.status === "error" ? (
                <CircleAlert className="size-3.5 text-bad" />
              ) : (
                <RotateCcw className="size-3.5 text-ink-3" />
              )}
              <span className="min-w-0 flex-1 truncate" title={j.error}>
                {j.title}
              </span>
              {j.usage && <span className="font-mono text-[0.7rem] text-ink-3">${j.usage.cost.toFixed(4)}</span>}
            </div>
          ))}
          {!jobs.length && <p className="text-ink-3">None in this session.</p>}
        </CardContent>
      </Card>
    </div>
  )
}
