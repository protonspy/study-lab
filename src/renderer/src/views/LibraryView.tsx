import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DomainLabel, TopicChip } from "@/components/Domain"
import { Pager, usePaged } from "@/components/Pager"
import { QuestionCard } from "@/components/QuestionCard"
import { data, loadLectures, shortSetName } from "@/lib/data"
import { go, run, useNav } from "@/lib/nav"
import { excerpt, MarkQuery, plural } from "@/lib/text"
import type { Lecture } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

export function LibraryView() {
  const nav = useNav()
  const [q, setQ] = useState("")
  const [tab, setTab] = useState("lectures")
  return (
    <div>
      <PageHead eyebrow="Reference" title="Library">
        Search the full lecture transcripts, every practice question and every study card. Use it to look things up, not as a substitute for recall.
      </PageHead>
      <div className="relative mb-4 max-w-lg">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <Input id="library-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. Textract, top-p, Audit Manager" className="pl-9" />
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="lectures">Lectures</TabsTrigger>
          <TabsTrigger value="questions">Questions</TabsTrigger>
          <TabsTrigger value="cards">Cards</TabsTrigger>
        </TabsList>
        <TabsContent value="lectures" className="mt-4">
          <Lectures q={q} initial={nav.params.lecture ? Number(nav.params.lecture) : null} />
        </TabsContent>
        <TabsContent value="questions" className="mt-4">
          <Questions q={q} />
        </TabsContent>
        <TabsContent value="cards" className="mt-4">
          <Cards q={q} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Lectures({ q, initial }: { q: string; initial: number | null }) {
  const [lecs, setLecs] = useState<Lecture[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openN, setOpenN] = useState<number | null>(initial)
  useEffect(() => {
    loadLectures().then(setLecs, (e: Error) => setErr(e.message))
  }, [])
  const needle = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!lecs) return []
    if (needle.length < 3) return lecs
    return lecs
      .map((l) => {
        const inTitle = l.title.toLowerCase().includes(needle)
        const hits = l.p.filter((p) => p.toLowerCase().includes(needle))
        return { l, score: (inTitle ? 10 : 0) + hits.length, hit: hits[0] }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => ({ ...x.l, hit: x.hit }))
  }, [lecs, needle])

  if (err) return <p className="text-sm text-bad">{err}</p>
  if (!lecs) return <Skeleton className="h-64" />
  const lec = openN != null ? lecs.find((l) => l.n === openN) : undefined
  if (lec) {
    const topics = data().topics.filter((t) => t.lectures.includes(lec.n))
    return (
      <article className="max-w-3xl">
        <Button variant="ghost" size="sm" onClick={() => setOpenN(null)}>
          <ArrowLeft /> All lectures
        </Button>
        <p className="eyebrow mt-3">{lec.sec}</p>
        <h2 className="mt-1 text-2xl font-semibold">
          {lec.n}. {lec.title}
        </h2>
        {topics.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {topics.map((t) => (
              <TopicChip key={t.id} id={t.id} />
            ))}
          </div>
        )}
        <div className="mt-5 space-y-3 leading-relaxed text-ink-2">
          {lec.p.length ? (
            lec.p.map((p, i) => (
              <p key={i}>
                <MarkQuery text={p} q={q} />
              </p>
            ))
          ) : (
            <p className="text-ink-3">This lecture has no English transcript.</p>
          )}
        </div>
      </article>
    )
  }
  let lastSec = ""
  return (
    <div className="flex flex-col">
      {needle.length >= 3 && <p className="mb-2 text-sm text-ink-3">{plural(filtered.length, "lecture")} mention “{q.trim()}”</p>}
      {filtered.map((l) => {
        const head = needle.length < 3 && l.sec !== lastSec ? l.sec : null
        lastSec = l.sec
        return (
          <div key={l.n}>
            {head && <p className="eyebrow mb-1 mt-5 first:mt-0">{head}</p>}
            <button type="button" onClick={() => setOpenN(l.n)} className="flex w-full gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-2">
              <span className="w-8 shrink-0 text-right font-mono text-xs leading-6 text-ink-3">{l.n}</span>
              <span className="min-w-0">
                <span className={cn("block text-sm", !l.p.length && "text-ink-3")}>{l.title}</span>
                {"hit" in l && typeof l.hit === "string" && (
                  <span className="block text-xs text-ink-3">
                    <MarkQuery text={excerpt(l.hit, 180)} q={q} />
                  </span>
                )}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Questions({ q }: { q: string }) {
  const [open, setOpen] = useState<string | null>(null)
  const needle = q.trim().toLowerCase()
  const hits = useMemo(() => {
    if (needle.length < 3) return []
    return data()
      .questions.filter((x) => x.stem.toLowerCase().includes(needle) || x.opts.some((o) => o.toLowerCase().includes(needle)) || x.explanation.toLowerCase().includes(needle))
  }, [needle])
  const page = usePaged(hits, { reset: needle })
  if (needle.length < 3) return <p className="text-sm text-ink-3">Type at least three characters to search {data().questions.length} questions.</p>
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-3">{plural(hits.length, "question")}</p>
      {page.rows.map((x) => (
        <div key={x.id} className="rounded-lg border border-line bg-surface">
          <button type="button" className="w-full px-3.5 py-3 text-left" onClick={() => setOpen((o) => (o === x.id ? null : x.id))}>
            <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <DomainLabel d={x.d} /> {shortSetName(x.set)} · Q{x.n}
            </span>
            <span className="mt-1 block text-sm">
              <MarkQuery text={excerpt(x.stem, 220)} q={q} />
            </span>
          </button>
          {open === x.id && (
            <div className="flex flex-col gap-3 border-t border-line px-3.5 py-4">
              <Button className="self-start" size="sm" onClick={() => run("Practice", [{ kind: "q", id: x.id }], "library")}>
                Answer it first
              </Button>
              <QuestionCard q={x} mode="review" reviewPicks={x.ans} order={x.opts.map((_, i) => i)} />
            </div>
          )}
        </div>
      ))}
      <Pager p={page} />
    </div>
  )
}

function Cards({ q }: { q: string }) {
  const needle = q.trim().toLowerCase()
  const hits = useMemo(() => {
    if (needle.length < 3) return []
    return data()
      .cards.filter((c) => c.f.toLowerCase().includes(needle) || c.b.toLowerCase().includes(needle))
  }, [needle])
  const page = usePaged(hits, { size: 50, reset: needle })
  if (needle.length < 3) return <p className="text-sm text-ink-3">Type at least three characters to search {data().cards.length.toLocaleString()} cards.</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-3">{plural(hits.length, "card")}</p>
        {hits.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => run(`Cards matching “${q.trim()}”`, hits.slice(0, 40).map((c) => ({ kind: "c" as const, id: c.id })), "library")}>
            Study these
          </Button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {page.rows.map((c) => (
          <div key={c.id} className="rounded-lg border border-line bg-surface p-3.5 text-sm">
            <p className="font-medium">
              <MarkQuery text={c.k === "trigger" ? `“${c.f}”` : c.f} q={q} />
            </p>
            <p className="mt-1.5 text-ink-2">
              <MarkQuery text={c.b} q={q} />
            </p>
            <button type="button" className="mt-2 text-[0.7rem] text-ink-3 hover:underline" onClick={() => go("notes", { topic: c.t })}>
              {data().topicById.get(c.t)?.title}
            </button>
          </div>
        ))}
      </div>
      <Pager p={page} />
    </div>
  )
}
