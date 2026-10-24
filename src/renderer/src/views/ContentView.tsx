import { useEffect, useMemo, useState } from "react"
import { Archive, ArchiveRestore, Pause, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { JobStrip, startCoachJob } from "@/components/Jobs"
import { DomainDot } from "@/components/Domain"
import { data, LAB, sourceName, useDataVersion } from "@/lib/data"
import { api, reloadContent } from "@/lib/lab"
import { useAppState } from "@/lib/store"
import type { ItemStatus } from "@/lib/types"
import type { SourceInfo } from "@shared/api"
import { ImportPanel } from "@/components/ImportPanel"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

export function ContentView() {
  useDataVersion()
  const lab = LAB!
  const d = data()
  const noTopics = !d.topics.length
  return (
    <div>
      <PageHead eyebrow={lab.name} title="Content">
        Bring material in, let the coach organise it into topics, notes and flashcards, and manage what stays in rotation.
      </PageHead>
      <div className="grid gap-6 lg:grid-cols-2">
        <ImportCard />
        <KnowledgeBaseCard highlight={noTopics && (lab.counts.lectures > 0 || d.allQuestions.length > 0)} />
      </div>
      <ItemManager />
    </div>
  )
}

function ImportCard() {
  const lab = LAB!
  const [sources, setSources] = useState<SourceInfo[]>([])
  const load = () => void api().sources(lab.id).then(setSources)
  useEffect(load, [lab.id])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import</CardTitle>
        <CardDescription>Every format becomes a standard content package. Re-importing the same course updates it and keeps your progress.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ImportPanel
          labId={lab.id}
          compact
          onImported={async () => {
            await reloadContent()
            load()
          }}
        />
        {!!sources.length && (
          <div>
            <p className="eyebrow mb-1.5">Sources in this lab</p>
            <ul className="flex flex-col gap-1 text-sm">
              {sources.map((x) => (
                <li key={x.id} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{x.title}</span>
                  <span className="shrink-0 text-xs text-ink-3">
                    {x.provider} · {x.stats.documents} docs · {x.stats.items} questions
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function KnowledgeBaseCard({ highlight }: { highlight: boolean }) {
  const lab = LAB!
  const d = data()
  const [cards, setCards] = useState("10")
  const [instructions, setInstructions] = useState("")
  const [keep, setKeep] = useState(true)
  const has = d.topics.length > 0
  return (
    <Card className={cn(highlight && "border-ink")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" /> Knowledge base
        </CardTitle>
        <CardDescription>
          {has
            ? `${d.topics.length} topics · ${d.allCards.length.toLocaleString()} flashcards · ${Object.keys(d.kb.tags).length} of ${d.allQuestions.length} questions tagged.`
            : "No topics yet. The coach can read the lecture transcripts and questions and build domains, topics, notes, exam tips and flashcards, then tag every question."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="kb-cards">Flashcards per topic</Label>
            <Input id="kb-cards" value={cards} onChange={(e) => setCards(e.target.value)} className="w-24 font-mono" inputMode="numeric" />
          </div>
          {has && (
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Checkbox checked={keep} onCheckedChange={(v) => setKeep(!!v)} /> Keep existing topics, only fill gaps
            </label>
          )}
        </div>
        <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional: guidance for the coach (e.g. follow the official exam guide's domains)." />
        <Button
          className="w-fit"
          onClick={() => void startCoachJob(lab.id, "build-kb", { cardsPerTopic: Number(cards) || 10, instructions: instructions.trim() || undefined, keep: has ? keep : false })}
          disabled={!lab.counts.lectures && !d.allQuestions.length}
        >
          <Sparkles /> {has ? "Rebuild with the coach" : "Build with the coach"}
        </Button>
        <p className="text-xs text-ink-3">Every topic and card it creates is logged in Coach → Activity and can be undone in one click.</p>
        <JobStrip kinds={["build-kb"]} />
      </CardContent>
    </Card>
  )
}

type Kind = "q" | "c"

function ItemManager() {
  useDataVersion()
  const s = useAppState()
  const d = data()
  const lab = LAB!
  const [kind, setKind] = useState<Kind>("q")
  const [topic, setTopic] = useState("all")
  const [status, setStatus] = useState<ItemStatus | "all">("all")
  const [src, setSrc] = useState("all")
  const [q, setQ] = useState("")
  const [sel, setSel] = useState<Set<string>>(new Set())

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const st = (x: { status?: ItemStatus }) => x.status ?? "active"
    if (kind === "q") {
      return d.allQuestions
        .filter((x) => (topic === "all" || (d.kb.tags[x.id] ?? []).includes(topic)) && (status === "all" || st(x) === status) && (src === "all" || x.src === src) && (!needle || x.stem.toLowerCase().includes(needle)))
        .map((x) => {
          const r = s.srsq[x.id]
          return { id: x.id, text: x.stem, status: st(x), src: sourceName(x.src, x.src_name), d: x.d, learned: !!r && r.i >= 21 && r.la === 1, stat: r ? `${r.c}/${r.c + r.w} right · ${Math.round(r.i)}d` : "new" }
        })
    }
    return d.allCards
      .filter((x) => (topic === "all" || x.t === topic) && (status === "all" || st(x) === status) && (src === "all" || (src === "agent" ? x.s === "A" : x.s !== "A")) && (!needle || `${x.f} ${x.b}`.toLowerCase().includes(needle)))
      .map((x) => {
        const r = s.srsc[x.id]
        return { id: x.id, text: x.f, status: st(x), src: x.s === "A" ? "Coach" : x.s === "Q" ? "Questions" : "Lectures", d: d.topicById.get(x.t)?.d ?? 0, learned: !!r && r.i >= 21, stat: r ? `${Math.round(r.i)}d · ${r.l} lapses` : "new" }
      })
  }, [d, s.srsq, s.srsc, kind, topic, status, src, q])

  const shown = rows.slice(0, 300)
  const learned = rows.filter((r) => r.learned && r.status === "active")
  const srcOptions = kind === "q" ? [...new Set(d.allQuestions.map((x) => x.src))] : ["agent", "course"]

  async function apply(ids: string[], next: ItemStatus) {
    if (!ids.length) return
    await api().setItemStatus(lab.id, kind, ids, next)
    await reloadContent()
    setSel(new Set())
    toast.success(`${ids.length} ${kind === "q" ? "questions" : "cards"} → ${next}`)
  }

  async function remove(ids: string[]) {
    await api().deleteItems(lab.id, kind, ids)
    await reloadContent()
    setSel(new Set())
    toast(`Deleted ${ids.length}`)
  }

  const toggle = (id: string) => setSel((x) => (x.has(id) ? (x.delete(id), new Set(x)) : new Set(x.add(id))))

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Manage material</CardTitle>
        <CardDescription>
          Archive what you have learned to lighten daily reviews, suspend what is broken or off-scope. Archived and suspended items leave every queue but keep their history.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" variant="outline" value={kind} onValueChange={(v) => v && (setKind(v as Kind), setSel(new Set()), setSrc("all"))}>
            <ToggleGroupItem value="q">Questions</ToggleGroupItem>
            <ToggleGroupItem value="c">Flashcards</ToggleGroupItem>
          </ToggleGroup>
          <Select value={topic} onValueChange={setTopic}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-96">
              <SelectItem value="all">All topics</SelectItem>
              {d.topics.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as ItemStatus | "all")}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={src} onValueChange={setSrc}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any source</SelectItem>
              {srcOptions.map((x) => (
                <SelectItem key={x} value={x}>
                  {x === "agent" ? "Coach" : sourceName(x)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text" className="w-48" />
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
          <span className="text-ink-2">
            {rows.length.toLocaleString()} items{sel.size ? ` · ${sel.size} selected` : ""}
          </span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {!!learned.length && !sel.size && (
              <Button size="sm" variant="outline" onClick={() => apply(learned.map((r) => r.id), "archived")}>
                <Archive /> Archive {learned.length} learned
              </Button>
            )}
            {!!sel.size && (
              <>
                <Button size="sm" variant="outline" onClick={() => apply([...sel], "archived")}>
                  <Archive /> Archive
                </Button>
                <Button size="sm" variant="outline" onClick={() => apply([...sel], "suspended")}>
                  <Pause /> Suspend
                </Button>
                <Button size="sm" variant="outline" onClick={() => apply([...sel], "active")}>
                  <ArchiveRestore /> Restore
                </Button>
                <Button size="sm" variant="ghost" className="text-bad" onClick={() => remove([...sel])}>
                  <Trash2 /> Delete
                </Button>
              </>
            )}
          </div>
        </div>

        <ul className="divide-y divide-line rounded-md border border-line">
          {shown.map((r) => (
            <li key={r.id} className={cn("flex items-start gap-3 px-3 py-2 text-sm", r.status !== "active" && "opacity-60")}>
              <Checkbox checked={sel.has(r.id)} onCheckedChange={() => toggle(r.id)} className="mt-0.5" aria-label="Select" />
              <DomainDot d={r.d} className="mt-1.5" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2">{r.text}</span>
                <span className="mt-0.5 block text-xs text-ink-3">
                  {r.src} · {r.stat}
                  {r.learned && <span className="text-good"> · learned</span>}
                </span>
              </span>
              {r.status !== "active" && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[0.7rem] text-ink-2">{r.status}</span>}
            </li>
          ))}
          {!shown.length && <li className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches.</li>}
        </ul>
        {rows.length > shown.length && <p className="text-xs text-ink-3">Showing the first 300. Narrow the filters to see the rest.</p>}
      </CardContent>
    </Card>
  )
}
