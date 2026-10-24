import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Flag, Lightbulb, NotebookPen, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Kbd } from "@/components/ui/kbd"
import { DomainLabel, TopicChip } from "@/components/Domain"
import { isCorrect, optionOrder, recordQuestion, setMistakeReason, setNote, toggleFlag } from "@/lib/actions"
import { shortSetName, sourceName, topicsOf } from "@/lib/data"
import { useAppState } from "@/lib/store"
import { Highlighted, LETTERS, RichText } from "@/lib/text"
import type { Confidence, Question } from "@/lib/types"
import { cn } from "@/lib/utils"

export const MISTAKE_REASONS = [
  { id: "gap", label: "Knowledge gap" },
  { id: "constraint", label: "Misread the constraint" },
  { id: "confused", label: "Confused similar services" },
  { id: "overthought", label: "Overthought it" },
  { id: "careless", label: "Rushed or careless" },
] as const

interface Props {
  q: Question
  /** tutor: answer then see feedback; review: show a stored attempt read-only */
  mode?: "tutor" | "review"
  reviewPicks?: number[]
  order?: number[]
  onAnswered?: (correct: boolean) => void
  onNext?: () => void
  nextLabel?: string
  position?: string
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
}

export function QuestionCard({ q, mode = "tutor", reviewPicks, order: orderProp, onAnswered, onNext, nextLabel = "Next", position }: Props) {
  const s = useAppState()
  const settings = s.meta.settings
  const order = useMemo(() => orderProp ?? optionOrder(q, settings.shuffle), [q, orderProp]) // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<number[]>([])
  const [submitted, setSubmitted] = useState<{ picks: number[]; conf: Confidence } | null>(
    mode === "review" ? { picks: reviewPicks ?? [], conf: 2 } : null,
  )
  const [revealAll, setRevealAll] = useState(mode === "review")
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [noteOpen, setNoteOpen] = useState(false)
  const started = useRef(Date.now())
  const need = q.ans.length
  const flagged = !!s.meta.flags[q.id]?.on
  const noteKey = `q:${q.id}`
  const [noteDraft, setNoteDraft] = useState(s.notes[noteKey]?.t ?? "")

  const canSubmit = picked.length === need
  const correct = submitted ? isCorrect(q, submitted.picks) : null

  // How the answer evolved: the first complete selection and how often it changed afterwards.
  const firstPick = useRef<number[] | null>(null)
  const changes = useRef(0)

  function toggle(orig: number) {
    if (submitted) return
    const p = picked
    const next = need === 1 ? [orig] : p.includes(orig) ? p.filter((x) => x !== orig) : p.length >= need ? [...p.slice(1), orig] : [...p, orig]
    if (next.length === need) {
      if (!firstPick.current) firstPick.current = next
      else if (p.length === need && next.some((x) => !p.includes(x))) changes.current++
      else if (p.length < need && next.some((x) => !firstPick.current!.includes(x))) changes.current++
    }
    setPicked(next)
  }

  function submit(conf: Confidence) {
    if (!canSubmit || submitted) return
    const sec = (Date.now() - started.current) / 1000
    const ok = recordQuestion(q, picked, conf, sec, { changes: changes.current, first: firstPick.current ?? undefined })
    setSubmitted({ picks: picked, conf })
    onAnswered?.(ok)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toUpperCase()
      if (!submitted) {
        const li = LETTERS.indexOf(k)
        const ni = "123456".indexOf(k)
        const idx = li >= 0 && li < order.length ? li : ni >= 0 && ni < order.length ? ni : -1
        if (idx >= 0) {
          e.preventDefault()
          toggle(order[idx])
          return
        }
        if (!canSubmit) return
        if (e.key === "Enter") {
          e.preventDefault()
          submit(2)
        } else if (settings.confidence && k === "U") submit(1)
        else if (settings.confidence && k === "G") submit(0)
        else if (settings.confidence && k === "S") submit(2)
      } else if (onNext && (e.key === "Enter" || k === "N")) {
        e.preventDefault()
        onNext()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const tags = topicsOf(q.id)
  const mistake = s.meta.mistakes[q.id]
  const rec = s.srsq[q.id]

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <DomainLabel d={q.d} />
        <span className="text-xs text-ink-3">
          {sourceName(q.src, q.src_name)} · {shortSetName(q.set)} · Q{q.n}
        </span>
        {position && <span className="font-mono text-xs text-ink-3 tabular">{position}</span>}
        <div className="ml-auto flex items-center gap-2">
          {rec && mode === "tutor" && !submitted && (
            <span className="text-xs text-ink-3">
              Seen {rec.s}× · {rec.c} right
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => toggleFlag(q.id)} aria-pressed={flagged} className={cn(flagged && "text-warn")}>
            <Flag className={cn(flagged && "fill-current")} />
            {flagged ? "Flagged" : "Flag"}
          </Button>
        </div>
      </header>

      <div className="space-y-3 text-[1.02rem] leading-relaxed">
        {q.stem.split("\n").filter(Boolean).map((p, i) => (
          <p key={i}>
            <Highlighted text={p} on={settings.highlight} />
          </p>
        ))}
        {q.multi && (
          <p className="eyebrow !text-ink-2">
            Select {need === 2 ? "two" : need === 3 ? "three" : need} · {picked.length}/{need} chosen
          </p>
        )}
      </div>

      <ol className="flex flex-col gap-2.5" aria-label="Answer options">
        {order.map((orig, pos) => {
          const isPick = (submitted ? submitted.picks : picked).includes(orig)
          const isAns = q.ans.includes(orig)
          const show = !!submitted
          const showWhy = show && (revealAll || isAns || isPick || revealed.has(orig))
          return (
            <li key={orig}>
              <button
                type="button"
                onClick={() => toggle(orig)}
                disabled={!!submitted}
                aria-pressed={isPick}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors",
                  !show && "hover:border-ink-3",
                  !show && isPick && "border-ink bg-surface-2",
                  !show && !isPick && "border-line",
                  show && isAns && "border-good bg-good-bg",
                  show && isPick && !isAns && "border-bad bg-bad-bg",
                  show && !isAns && !isPick && "border-line opacity-80",
                  "disabled:cursor-default",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border font-mono text-xs font-medium",
                    !show && isPick ? "border-ink bg-ink text-primary-foreground" : "border-line text-ink-2",
                    show && isAns && "border-good bg-good text-primary-foreground",
                    show && isPick && !isAns && "border-bad bg-bad text-primary-foreground",
                  )}
                >
                  {show && isAns ? <Check className="size-3.5" /> : show && isPick ? <X className="size-3.5" /> : LETTERS[pos]}
                </span>
                <span className="min-w-0 flex-1">{q.opts[orig]}</span>
              </button>
              {show && q.why[orig] && (
                <div className="mt-1.5 pl-12 pr-2 text-sm text-ink-2">
                  {showWhy ? (
                    <p>
                      <span className={cn("font-medium", isAns ? "text-good" : "text-bad")}>{isAns ? "Why it fits: " : "Why not: "}</span>
                      {q.why[orig]}
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-ink-3 underline decoration-dotted underline-offset-4 hover:text-ink"
                      onClick={() => setRevealed((r) => new Set(r).add(orig))}
                    >
                      <ChevronDown className="size-3.5" /> Why is {LETTERS[pos]} wrong? Say it to yourself, then reveal
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {!submitted && mode === "tutor" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {settings.confidence ? (
            <>
              <span className="text-sm text-ink-2 sm:mr-1">Lock in, and say how sure you are:</span>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!canSubmit} onClick={() => submit(2)}>
                  Sure <Kbd className="hidden bg-white/15 text-inherit sm:inline-flex">S</Kbd>
                </Button>
                <Button variant="outline" disabled={!canSubmit} onClick={() => submit(1)}>
                  Unsure <Kbd className="hidden sm:inline-flex">U</Kbd>
                </Button>
                <Button variant="outline" disabled={!canSubmit} onClick={() => submit(0)}>
                  Guessing <Kbd className="hidden sm:inline-flex">G</Kbd>
                </Button>
              </div>
            </>
          ) : (
            <Button disabled={!canSubmit} onClick={() => submit(2)}>
              Check answer <Kbd className="hidden bg-white/15 text-inherit sm:inline-flex">Enter</Kbd>
            </Button>
          )}
          <span className="hidden text-xs text-ink-3 sm:ml-auto sm:inline">Keys: A–{LETTERS[order.length - 1]} to choose</span>
        </div>
      )}

      {submitted && (
        <section className="flex flex-col gap-4">
          {mode === "tutor" && <Verdict correct={!!correct} conf={submitted.conf} />}
          {mode === "review" && (
            <Verdict correct={!!correct} conf={submitted.picks.length ? 2 : 0} review unanswered={!submitted.picks.length} />
          )}
          {!revealAll && (
            <button type="button" className="self-start text-sm text-ink-2 underline underline-offset-4 hover:text-ink" onClick={() => setRevealAll(true)}>
              Reveal every rationale
            </button>
          )}
          {q.explanation && (
            <div className="rounded-lg border border-line bg-surface p-4 text-sm leading-relaxed">
              <p className="eyebrow mb-2 flex items-center gap-1.5">
                <Lightbulb className="size-3.5" /> Explanation
              </p>
              <RichText text={q.explanation} />
            </div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-3">Study the topic:</span>
              {tags.map((t) => (
                <TopicChip key={t} id={t} />
              ))}
            </div>
          )}
          {correct === false && mode === "tutor" && (
            <div className="rounded-lg border border-dashed border-line p-3.5">
              <p className="mb-2 text-sm font-medium">Why did you miss it? Naming the cause makes the next one easier.</p>
              <div className="flex flex-wrap gap-2">
                {MISTAKE_REASONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setMistakeReason(q.id, mistake?.cat === r.id ? undefined : r.id)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      mistake?.cat === r.id ? "border-ink bg-ink text-primary-foreground" : "border-line text-ink-2 hover:border-ink-3",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            {!noteOpen && !s.notes[noteKey]?.t ? (
              <Button variant="ghost" size="sm" onClick={() => setNoteOpen(true)}>
                <NotebookPen /> Add a note in your own words
              </Button>
            ) : (
              <div className="space-y-1.5">
                <label htmlFor={`note-${q.id}`} className="eyebrow">
                  Your note
                </label>
                <Textarea
                  id={`note-${q.id}`}
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onBlur={() => noteDraft !== (s.notes[noteKey]?.t ?? "") && setNote(noteKey, noteDraft)}
                  placeholder="The rule that decides this question, in one sentence."
                  rows={2}
                />
              </div>
            )}
          </div>
          {onNext && (
            <div className="sticky bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] z-10 flex justify-end md:bottom-4">
              <Button size="lg" onClick={onNext} className="shadow-lg">
                {nextLabel} <Kbd className="hidden bg-white/15 text-inherit sm:inline-flex">Enter</Kbd>
              </Button>
            </div>
          )}
        </section>
      )}
    </article>
  )
}

function Verdict({ correct, conf, review, unanswered }: { correct: boolean; conf: Confidence; review?: boolean; unanswered?: boolean }) {
  if (unanswered)
    return (
      <div className="rounded-lg border border-warn/40 bg-warn-bg px-4 py-3 text-sm">
        <p className="font-medium text-warn">Not answered</p>
        <p className="text-ink-2">An unanswered question scores the same as a wrong one. Always leave a best guess.</p>
      </div>
    )
  if (correct)
    return (
      <div className="flex items-start gap-3 rounded-lg border border-good/40 bg-good-bg px-4 py-3 text-sm">
        <Check className="mt-0.5 size-4 text-good" />
        <div>
          <p className="font-medium text-good">Correct</p>
          {!review && conf < 2 && <p className="text-ink-2">You weren't sure, so it comes back sooner. Read the rationales to make it solid.</p>}
        </div>
      </div>
    )
  return (
    <div className="flex items-start gap-3 rounded-lg border border-bad/40 bg-bad-bg px-4 py-3 text-sm">
      <X className="mt-0.5 size-4 text-bad" />
      <div>
        <p className="font-medium text-bad">{conf === 2 && !review ? "Confidently wrong" : "Incorrect"}</p>
        <p className="text-ink-2">
          {conf === 2 && !review
            ? "This is the most valuable kind of mistake: errors you were sure about are corrected best when you study the reason right now."
            : "It returns tomorrow. Read why each wrong option fails; the distractors repeat across exams."}
        </p>
        {conf === 2 && !review && (
          <Badge variant="outline" className="mt-2 border-bad/40 text-bad">
            Priority review
          </Badge>
        )}
      </div>
    </div>
  )
}
