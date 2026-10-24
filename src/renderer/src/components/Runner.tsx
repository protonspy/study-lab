import { useRef, useState } from "react"
import { ArrowLeft, CheckCircle2, Layers, ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { FlashCard } from "@/components/FlashCard"
import { QuestionCard } from "@/components/QuestionCard"
import { data } from "@/lib/data"
import { endRun, go, type RunSpec } from "@/lib/nav"
import type { Grade } from "@/lib/srs"
import type { QueueItem } from "@/lib/stats"
import { useAppState } from "@/lib/store"
import { forecast } from "@/lib/stats"
import { fmtDuration, plural } from "@/lib/text"

interface Tally {
  cards: number
  again: number
  qs: number
  qOk: number
}

export function Runner({ spec }: { spec: RunSpec }) {
  const s = useAppState()
  const [queue, setQueue] = useState<QueueItem[]>(spec.items)
  const [idx, setIdx] = useState(0)
  const [tally, setTally] = useState<Tally>({ cards: 0, again: 0, qs: 0, qOk: 0 })
  const [answered, setAnswered] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const started = useRef(Date.now())

  const item = queue[idx]
  const done = idx >= queue.length

  function advance() {
    setAnswered(false)
    setAttempt((a) => a + 1)
    setIdx((i) => i + 1)
  }

  function onGraded(g: Grade) {
    setTally((t) => ({ ...t, cards: t.cards + 1, again: t.again + (g === 1 ? 1 : 0) }))
    if (g === 1 && item) {
      // Relearn inside the session: the card returns a few items later.
      setQueue((q) => {
        const next = [...q]
        next.splice(Math.min(next.length, idx + 5), 0, item)
        return next
      })
    }
    advance()
  }

  if (!queue.length) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
        <CheckCircle2 className="size-10 text-good" />
        <h2 className="text-2xl font-semibold">Nothing to study here right now</h2>
        <p className="text-ink-2">Everything in this selection is scheduled for later. Pick another topic, or run a practice set.</p>
        <Button variant="outline" onClick={endRun}>
          <ArrowLeft /> Back
        </Button>
      </div>
    )
  }

  if (done) {
    const sec = (Date.now() - started.current) / 1000
    const fc = forecast(s, 2)
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 py-8">
        <div>
          <p className="eyebrow">Session complete</p>
          <h2 className="mt-1 text-3xl font-semibold">{spec.title}: done</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Flashcards" value={tally.cards} />
          <Stat label="Relearned" value={tally.again} />
          <Stat label="Questions" value={tally.qs} />
          <Stat label="Question accuracy" value={tally.qs ? `${Math.round((100 * tally.qOk) / tally.qs)}%` : "—"} />
        </div>
        <p className="text-ink-2">
          {fmtDuration(sec)} of focused retrieval. Tomorrow {plural(fc[1], "item")} come back on schedule. Stopping here and returning tomorrow beats
          cramming: spacing is what moves facts into long-term memory.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={endRun}>
            <ArrowLeft /> Back
          </Button>
          <Button variant="outline" onClick={() => go("mistakes")}>
            <ListChecks /> Review mistakes
          </Button>
          <Button variant="outline" onClick={() => go("notes")}>
            <Layers /> Open notes
          </Button>
        </div>
      </div>
    )
  }

  const pct = Math.round((100 * idx) / queue.length)
  const position = `${idx + 1} / ${queue.length}`

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={endRun}>
          <ArrowLeft /> End
        </Button>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">{spec.title}</span>
            <span className="font-mono text-xs text-ink-3 tabular">{queue.length - idx} left</span>
          </div>
          <Progress value={pct} aria-label="Session progress" />
        </div>
      </div>

      {item.kind === "c" ? (
        (() => {
          const card = data().cardById.get(item.id)
          if (!card) return <Skip onSkip={advance} />
          return <FlashCard key={`${item.id}-${attempt}`} card={card} onGraded={onGraded} position={position} />
        })()
      ) : (
        (() => {
          const q = data().qById.get(item.id)
          if (!q) return <Skip onSkip={advance} />
          return (
            <QuestionCard
              key={`${item.id}-${attempt}`}
              q={q}
              position={position}
              onAnswered={(ok) => {
                if (answered) return
                setAnswered(true)
                setTally((t) => ({ ...t, qs: t.qs + 1, qOk: t.qOk + (ok ? 1 : 0) }))
              }}
              onNext={advance}
              nextLabel={idx + 1 >= queue.length ? "Finish" : "Next"}
            />
          )
        })()
      )}
    </div>
  )
}

function Skip({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="py-10 text-center text-ink-2">
      This item is no longer in the study set.{" "}
      <Button variant="link" onClick={onSkip}>
        Skip it
      </Button>
    </div>
  )
}

export function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold">{typeof value === "number" ? value.toLocaleString() : value}</p>
      {sub && <p className="text-xs text-ink-3">{sub}</p>}
    </div>
  )
}
