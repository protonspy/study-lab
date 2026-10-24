import { useEffect, useRef, useState } from "react"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { TopicChip } from "@/components/Domain"
import { recordCard } from "@/lib/actions"
import { capFromExam, previewIntervals, STRENGTH_LABEL, strength, type Grade } from "@/lib/srs"
import { useAppState } from "@/lib/store"
import type { Card } from "@/lib/types"
import { cn } from "@/lib/utils"

const KIND_LABEL: Record<Card["k"], string> = {
  fact: "Fact",
  concept: "Concept",
  compare: "Compare",
  scenario: "Scenario",
  list: "List",
  trigger: "Exam cue",
}

const GRADES: { g: Grade; label: string; hint: string; cls: string }[] = [
  { g: 1, label: "Again", hint: "Forgot", cls: "border-bad/50 text-bad hover:bg-bad-bg" },
  { g: 2, label: "Hard", hint: "Slow or partial", cls: "border-warn/50 text-warn hover:bg-warn-bg" },
  { g: 3, label: "Good", hint: "Recalled it", cls: "border-good/50 text-good hover:bg-good-bg" },
  { g: 4, label: "Easy", hint: "Instant", cls: "border-line text-ink hover:bg-surface-2" },
]

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
}

export function FlashCard({ card, onGraded, position }: { card: Card; onGraded: (g: Grade) => void; position?: string }) {
  const s = useAppState()
  const [flipped, setFlipped] = useState(false)
  const [typed, setTyped] = useState("")
  const started = useRef(Date.now())
  const rec = s.srsc[card.id]
  const previews = previewIntervals(rec, "c", capFromExam(s.meta.settings.examDate))
  const isCue = card.k === "trigger"

  function grade(g: Grade) {
    recordCard(card, g, (Date.now() - started.current) / 1000)
    onGraded(g)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTyping(e)) {
        if (!flipped && e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          setFlipped(true)
        }
        return
      }
      if (!flipped && (e.key === " " || e.key === "Enter")) {
        e.preventDefault()
        setFlipped(true)
      } else if (flipped && "1234".includes(e.key)) {
        e.preventDefault()
        grade(Number(e.key) as Grade)
      } else if (flipped && e.key === " ") {
        e.preventDefault()
        grade(3)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="index-card flex min-h-[19rem] flex-col">
        <div className="flex h-[3.25rem] items-center gap-2 px-4">
          <span className="eyebrow">{KIND_LABEL[card.k]}</span>
          <span className="text-xs text-ink-3">· {STRENGTH_LABEL[strength(rec)]}</span>
          {position && <span className="ml-auto font-mono text-xs text-ink-3 tabular">{position}</span>}
        </div>
        <div className="flex flex-1 flex-col gap-4 px-5 pb-5 pt-5 sm:px-7">
          {isCue && <p className="text-sm text-ink-3">When the scenario says…</p>}
          <p className={cn("text-lg font-medium leading-snug sm:text-xl", isCue && "italic")}>{isCue ? `“${card.f}”` : card.f}</p>

          {!flipped && s.meta.settings.typeAnswer && (
            <div className="space-y-1.5">
              <label htmlFor={`typed-${card.id}`} className="eyebrow">
                Answer from memory first
              </label>
              <Textarea
                id={`typed-${card.id}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                rows={2}
                placeholder="Type what you remember, then press Enter"
                autoFocus
              />
            </div>
          )}

          {flipped && (
            <div className="space-y-3 border-t border-dashed border-line pt-4">
              {isCue && <p className="text-sm text-ink-3">…pick</p>}
              <p className="text-base leading-relaxed sm:text-[1.05rem]">
                <span className="hl">{card.b}</span>
              </p>
              {card.x && <p className="text-sm text-ink-2">Because {card.x.charAt(0).toLowerCase() + card.x.slice(1)}</p>}
              {typed.trim() && (
                <div className="rounded-md bg-surface-2 px-3 py-2 text-sm">
                  <span className="eyebrow mr-2">You wrote</span>
                  <span className="text-ink-2">{typed}</span>
                </div>
              )}
            </div>
          )}

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            <TopicChip id={card.t} />
            <span className="text-xs text-ink-3">{card.s === "L" ? "From the lectures" : "From practice-exam explanations"}</span>
          </div>
        </div>
      </div>

      {!flipped ? (
        <Button size="lg" className="h-11 w-full sm:w-auto sm:self-center sm:px-8" onClick={() => setFlipped(true)}>
          <RotateCcw /> Show answer <Kbd className="hidden bg-white/15 text-inherit sm:inline-flex">Space</Kbd>
        </Button>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {GRADES.map((x, i) => (
            <button
              key={x.g}
              type="button"
              onClick={() => grade(x.g)}
              className={cn("flex flex-col items-center gap-0.5 rounded-lg border bg-surface px-3 py-2.5 transition-colors", x.cls)}
            >
              <span className="text-sm font-semibold">{x.label}</span>
              <span className="text-[0.7rem] text-ink-3">
                {x.hint} · <span className="font-mono tabular">{previews[i]}</span>
              </span>
              <Kbd className="mt-1 hidden sm:inline-flex">{x.g}</Kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
