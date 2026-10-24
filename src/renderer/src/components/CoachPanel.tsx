import { ArrowRight, Bot, CalendarRange, Pin, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TopicChip } from "@/components/Domain"
import { startCoachJob } from "@/components/Jobs"
import { LAB, data, useDataVersion } from "@/lib/data"
import { go } from "@/lib/nav"
import { currentDay, planProgress } from "@/lib/plan"
import { TaskRow, useInsights, usePlans } from "@/views/CoachView"

/** What the coach wants you to do today: the plan's tasks, pinned focus topics and the latest insight. */
export function CoachPanel() {
  useDataVersion()
  const [plans, setPlans] = usePlans()
  const [insights] = useInsights()
  const lab = LAB!
  const plan = plans?.find((p) => p.status === "active") ?? null
  const day = plan ? currentDay(plan) : null
  const focus = lab.config.focus.filter((t) => data().topicById.has(t))
  const latest = insights?.[0]
  if (!plans || !insights) return null

  if (!plan && !focus.length && !latest)
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Bot className="size-6 shrink-0 text-ink-3" />
          <p className="flex-1 text-sm text-ink-2">
            The AI coach can read how you study, find patterns in your mistakes and lay out a day-by-day plan here. Study a bit first, then ask it.
          </p>
          <Button variant="outline" onClick={() => go("coach", { tab: "plan" })}>
            <Sparkles /> Open the coach
          </Button>
        </CardContent>
      </Card>
    )

  const update = (p: typeof plan) => p && setPlans((ps) => ps?.map((x) => (x.id === p.id ? p : x)) ?? null)
  const prog = plan ? planProgress(plan) : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow flex items-center gap-1.5">
              <Bot className="size-3.5" /> Coach
            </p>
            <CardTitle className="mt-1 text-xl">{day ? `Day ${day.day}: ${day.focus}` : plan ? plan.title : "Your focus"}</CardTitle>
            {plan && (
              <CardDescription>
                {plan.title} · {prog!.done}/{prog!.total} tasks done
              </CardDescription>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => go("coach", { tab: "plan" })}>
            Plan <ArrowRight />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {day && (
          <ul className="divide-y divide-line">
            {day.tasks.map((t) => (
              <TaskRow key={t.id} plan={plan!} task={t} onChange={update} />
            ))}
          </ul>
        )}
        {plan && !day && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
            <CalendarRange className="size-4" /> This plan has ended.
            <Button size="sm" variant="outline" onClick={() => void startCoachJob(lab.id, "plan", { days: 7 })}>
              <Sparkles /> Plan the next week
            </Button>
          </div>
        )}
        {!!focus.length && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-3">
              <Pin className="size-3.5" /> Focus topics
            </p>
            <div className="flex flex-wrap gap-1.5">
              {focus.map((t) => (
                <TopicChip key={t} id={t} />
              ))}
            </div>
          </div>
        )}
        {latest && (
          <button type="button" onClick={() => go("coach", { tab: "insights" })} className="rounded-md bg-surface-2 px-3 py-2.5 text-left text-sm hover:bg-surface-2/70">
            <span className="text-xs text-ink-3">Latest insight · {new Date(latest.at).toLocaleDateString()}</span>
            <span className="mt-0.5 block font-medium">{latest.headline}</span>
          </button>
        )}
      </CardContent>
    </Card>
  )
}
