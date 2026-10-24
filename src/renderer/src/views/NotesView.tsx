import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, BookOpen, Eye, EyeOff, Layers, ListChecks, PenLine, Search, Sparkles, TriangleAlert, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { startCoachJob } from "@/components/Jobs"
import { Markdown } from "@/components/Markdown"
import { Meter } from "@/components/charts"
import { DomainDot, DomainLabel } from "@/components/Domain"
import { setNote } from "@/lib/actions"
import { data, DOMAINS, LAB, loadLectures } from "@/lib/data"
import { go, run, useNav } from "@/lib/nav"
import { cardsQueue, questionSprint, topicStat } from "@/lib/stats"
import { useAppState } from "@/lib/store"
import { MarkQuery, plural } from "@/lib/text"
import type { Lecture, NoteTable, Topic } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

export function NotesView() {
  const nav = useNav()
  const topic = nav.params.topic ? data().topicById.get(nav.params.topic) : undefined
  return topic ? <TopicPage key={topic.id} t={topic} /> : <NotesIndex />
}

function NotesIndex() {
  const s = useAppState()
  const [q, setQ] = useState("")
  const needle = q.trim().toLowerCase()
  const hits = useMemo(() => {
    if (needle.length < 3) return []
    const out: { t: Topic; text: string; kind: string }[] = []
    for (const t of data().topics) {
      const add = (arr: string[], kind: string) => arr.forEach((p) => p.toLowerCase().includes(needle) && out.push({ t, text: p, kind }))
      add(t.lec.keyPoints, "Key point")
      add(t.exam.keyPoints, "Key point")
      add([...t.lec.examTips, ...t.exam.examTips], "Exam tip")
      add([...t.lec.pitfalls, ...t.exam.pitfalls], "Trap")
    }
    return out.slice(0, 80)
  }, [needle])

  return (
    <div>
      <PageHead eyebrow="Cheat sheets" title="Notes">
        Every topic of the exam guide, condensed from the lectures and the practice-exam explanations: key points, exam tips, traps, memory hooks and
        comparison tables.
      </PageHead>
      <div className="relative mb-6 max-w-lg">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <Input id="notes-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the notes, e.g. Clarify, RLHF, PII" className="pl-9" />
      </div>

      {needle.length >= 3 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-3">{plural(hits.length, "match", "matches")}{hits.length === 80 ? " (first 80)" : ""}</p>
          {hits.map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => go("notes", { topic: h.t.id })}
              className="rounded-lg border border-line bg-surface p-3 text-left text-sm hover:border-ink-3"
            >
              <span className="mb-1 flex items-center gap-2 text-xs text-ink-3">
                <DomainDot d={h.t.d} /> {h.t.title} · {h.kind}
              </span>
              <MarkQuery text={h.text} q={q} />
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {[
            ...DOMAINS.map((d) => ({ n: d.n, name: d.name, w: d.w })),
            { n: 0, name: "Exam strategy", w: 0 },
            ...[...new Set(data().topics.map((t) => t.d))].filter((n) => n > 0 && !DOMAINS.some((d) => d.n === n)).map((n) => ({ n, name: "Not in the lab's domains", w: 0 })),
          ]
            .filter((d) => data().topics.some((t) => t.d === d.n))
            .map((d) => (
            <section key={d.n}>
              <h2 className="mb-3 flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
                <span className="flex items-center gap-2">
                  <DomainDot d={d.n} /> {d.n ? `Domain ${d.n}` : "Before the exam"}
                </span>
                <span className="text-sm font-normal text-ink-2">{d.name}</span>
                {d.w > 0 && <span className="font-mono text-xs text-ink-3">{d.w}% of the exam</span>}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data()
                  .topics.filter((t) => t.d === d.n)
                  .map((t) => {
                    const st = topicStat(s, t.id)
                    const kp = t.lec.keyPoints.length + t.exam.keyPoints.length
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => go("notes", { topic: t.id })}
                        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 text-left transition-colors hover:border-ink-3"
                      >
                        <span className="font-medium">{t.title}</span>
                        <span className="line-clamp-2 text-sm text-ink-2">{t.covers}</span>
                        <span className="mt-auto flex items-center gap-3 pt-1 text-[0.7rem] text-ink-3">
                          <span>{kp} points</span>
                          <span>{st.cTotal} cards</span>
                          <span>{st.qTotal} questions</span>
                          <Meter value={(st.mastery ?? 0) * 100} className="ml-auto w-16" tone={st.mastery == null ? "ink" : st.mastery >= 0.7 ? "good" : st.mastery >= 0.45 ? "warn" : "bad"} />
                        </span>
                      </button>
                    )
                  })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function Guides({ t, open }: { t: Topic; open?: string }) {
  const guides = [...(t.guides ?? [])].sort((a, b) => b.at - a.at)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [open])
  if (!guides.length) return null
  return (
    <section ref={ref} className="flex flex-col gap-3">
      {guides.map((g, i) => (
        <Collapsible key={g.id} defaultOpen={g.id === open || (!open && i === 0)}>
          <div className="rounded-lg border border-line bg-surface">
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
              <Sparkles className="size-4 shrink-0 text-ink-3" />
              <span className="flex-1 font-medium">{g.title}</span>
              <span className="text-xs text-ink-3">Coach guide · {new Date(g.at).toLocaleDateString()}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Markdown text={g.md} className="border-t border-line px-4 py-4" />
            </CollapsibleContent>
          </div>
        </Collapsible>
      ))}
    </section>
  )
}

function TopicPage({ t }: { t: Topic }) {
  const nav = useNav()
  const s = useAppState()
  const st = topicStat(s, t.id)
  const [recall, setRecall] = useState(false)
  const [lectures, setLectures] = useState<Lecture[] | null>(null)
  const noteKey = `topic:${t.id}`
  const [draft, setDraft] = useState(s.notes[noteKey]?.t ?? "")
  const cards = data().cardsByTopic.get(t.id) ?? []
  const nCues = cards.filter((c) => c.k === "trigger").length

  useEffect(() => {
    if (t.lectures.length) loadLectures().then(setLectures).catch(() => setLectures([]))
  }, [t.lectures.length])

  const tips = [...t.lec.examTips, ...t.exam.examTips]
  const traps = [...t.lec.pitfalls, ...t.exam.pitfalls]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => go("notes")}>
          <ArrowLeft /> All topics
        </Button>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {t.d > 0 ? <DomainLabel d={t.d} full /> : <span className="eyebrow">Exam strategy</span>}
        </div>
        <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">{t.title}</h1>
        <p className="mt-1 text-ink-2">{t.covers}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run(`Flashcards · ${t.title}`, cardsQueue(s, { topic: t.id, kinds: "cards", scope: "due" }, 40), "notes")} disabled={!cards.length}>
          <Layers /> Flashcards ({cards.length - nCues})
        </Button>
        <Button variant="outline" onClick={() => run(`Exam cues · ${t.title}`, cardsQueue(s, { topic: t.id, kinds: "cues", scope: "due" }, 40), "notes")} disabled={!nCues}>
          <Zap /> Exam cues ({nCues})
        </Button>
        <Button variant="outline" onClick={() => run(`Questions · ${t.title}`, questionSprint(s, 15, { topic: t.id }), "notes")} disabled={!st.qTotal}>
          <ListChecks /> Questions ({st.qTotal})
        </Button>
        <Button variant="ghost" onClick={() => void startCoachJob(LAB!.id, "generate", { topics: [t.id], cards: 8, questions: 4, guide: true })}>
          <Sparkles /> Coach: create material
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MiniStat label="Questions right (latest)" value={st.qSeen ? `${Math.round((100 * st.qOk) / st.qSeen)}%` : "—"} sub={`${st.qSeen}/${st.qTotal} seen`} />
        <MiniStat label="Cards strong" value={`${Math.round(st.cStrong)}/${st.cTotal}`} sub={`${st.cSeen} seen`} />
        <MiniStat label="Mastery" value={st.mastery == null ? "—" : `${Math.round(st.mastery * 100)}%`} sub="60% questions · 40% cards" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Guides t={t} open={nav.params.guide} />

          {t.summary.length > 0 && (
            <div className="space-y-2 text-[1.02rem] leading-relaxed">
              {t.summary.slice(0, 3).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-2.5">
            <Switch id="recall-mode" checked={recall} onCheckedChange={setRecall} />
            <Label htmlFor="recall-mode" className="flex-1 font-normal">
              Recall mode: points stay blurred until you try to remember them and click
            </Label>
            {recall ? <EyeOff className="size-4 text-ink-3" /> : <Eye className="size-4 text-ink-3" />}
          </div>

          <PointList key={`l${recall}`} title="Key points from the lectures" items={t.lec.keyPoints} recall={recall} />
          <PointList key={`e${recall}`} title="Key points from the practice-exam explanations" items={t.exam.keyPoints} recall={recall} />

          {t.tables.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">Comparisons</h2>
              {t.tables.map((tb, i) => (
                <CompareTable key={i} tb={tb} />
              ))}
            </section>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          {t.mnemonics.length > 0 && (
            <section className="index-card px-5 pb-5 pt-[4.25rem]">
              <p className="eyebrow absolute left-4 top-4">Memory hooks</p>
              <ul className="flex flex-col gap-3">
                {t.mnemonics.map((m, i) => (
                  <li key={i} className="hand text-ink">
                    {m}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <PointList key={`t${recall}`} title="Exam tips" items={tips} recall={recall} icon={<Zap className="size-4" />} compact />
          <PointList key={`p${recall}`} title="Traps" items={traps} recall={recall} icon={<TriangleAlert className="size-4" />} compact />

          <Card>
            <CardContent className="flex flex-col gap-2">
              <p className="flex items-center gap-2 font-medium">
                <PenLine className="size-4" /> Explain it simply
              </p>
              <p className="text-sm text-ink-2">
                Without looking, explain {t.title.toLowerCase()} to a colleague in five sentences. Then compare with the key points and fix the gaps.
              </p>
              <Textarea
                id={`feynman-${t.id}`}
                rows={6}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => draft !== (s.notes[noteKey]?.t ?? "") && setNote(noteKey, draft)}
                placeholder="In plain words…"
              />
              {s.notes[noteKey]?.at && <p className="text-[0.7rem] text-ink-3">Saved {new Date(s.notes[noteKey].at).toLocaleString()}</p>}
            </CardContent>
          </Card>

          {t.lectures.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
                <BookOpen className="size-4" /> Source lectures
              </h2>
              <ul className="flex flex-col gap-1 text-sm">
                {t.lectures.map((n) => {
                  const lec = lectures?.find((l) => l.n === n)
                  return (
                    <li key={n}>
                      <button type="button" className="text-left text-ink-2 hover:text-ink hover:underline" onClick={() => go("library", { lecture: String(n) })}>
                        <span className="font-mono text-xs text-ink-3">{n}.</span> {lec?.title ?? "Lecture"}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      {sub && <p className="text-[0.7rem] text-ink-3">{sub}</p>}
    </div>
  )
}

function PointList({ title, items, recall, icon, compact }: { title: string; items: string[]; recall: boolean; icon?: React.ReactNode; compact?: boolean }) {
  const [all, setAll] = useState(false)
  const [shown, setShown] = useState<Set<number>>(new Set())
  if (!items.length) return null
  const limit = compact ? 8 : 14
  const visible = all ? items : items.slice(0, limit)
  return (
    <section>
      <h2 className={cn("mb-2.5 flex items-center gap-2 font-semibold", compact ? "text-base" : "text-lg")}>
        {icon} {title} <span className="font-mono text-xs font-normal text-ink-3">{items.length}</span>
      </h2>
      <ul className={cn("flex flex-col", compact ? "gap-2 text-sm" : "gap-2.5")}>
        {visible.map((p, i) => {
          const hidden = recall && !shown.has(i)
          return (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-ink-3" />
              <span
                className={cn("min-w-0", hidden && "blur-recall")}
                onClick={() => hidden && setShown((sh) => new Set(sh).add(i))}
                role={hidden ? "button" : undefined}
                tabIndex={hidden ? 0 : undefined}
                onKeyDown={(e) => hidden && (e.key === "Enter" || e.key === " ") && setShown((sh) => new Set(sh).add(i))}
              >
                {p}
              </span>
            </li>
          )
        })}
      </ul>
      {items.length > limit && (
        <Button variant="link" size="sm" className="mt-1 px-0" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </Button>
      )}
    </section>
  )
}

function CompareTable({ tb }: { tb: NoteTable }) {
  return (
    <div>
      {tb.title && <p className="mb-1.5 text-sm font-medium">{tb.title}</p>}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <thead className="bg-surface-2 text-left">
            <tr>
              {tb.head.map((h, i) => (
                <th key={i} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r, i) => (
              <tr key={i} className="border-t border-line bg-surface align-top">
                {r.map((c, j) => (
                  <td key={j} className={cn("px-3 py-2", j === 0 ? "font-medium" : "text-ink-2")}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
