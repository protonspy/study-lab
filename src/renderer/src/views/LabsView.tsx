import { useEffect, useState } from "react"
import { BookOpenCheck, Bot, FileUp, FlaskConical, GraduationCap, Languages, Library, Loader2, Plus, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AiSettingsPanel, useAiSettings } from "@/components/AiSettingsPanel"
import { api, openLab, startSetup } from "@/lib/lab"
import type { LabInfo, LabKind } from "@/lib/types"

const KIND_ICON: Record<LabKind, typeof GraduationCap> = {
  certification: GraduationCap,
  language: Languages,
  course: Library,
  other: FlaskConical,
}

function ago(ms: number | null) {
  if (!ms) return "not studied yet"
  const d = Math.floor((Date.now() - ms) / 86400000)
  return d <= 0 ? "studied today" : d === 1 ? "studied yesterday" : `studied ${d} days ago`
}

function daysLeft(date: string | null) {
  if (!date) return null
  const [y, m, d] = date.split("-").map(Number)
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return Math.round((new Date(y, m - 1, d).getTime() - t.getTime()) / 86400000)
}

export function LabsView() {
  const [labs, setLabs] = useState<LabInfo[] | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [ai] = useAiSettings()
  const [opening, setOpening] = useState<string | null>(null)

  const load = () => void api().listLabs().then(setLabs)
  useEffect(load, [])

  async function open(id: string) {
    setOpening(id)
    try {
      await openLab(id)
    } catch (e) {
      toast.error((e as Error).message)
      setOpening(null)
    }
  }

  async function importFile() {
    const [p] = await api().pickFiles("json")
    if (!p) return
    try {
      const lab = await api().importLabFile(p)
      toast.success(`Imported “${lab.name}”`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="gutter-x mx-auto flex min-h-dvh max-w-6xl flex-col py-10 lg:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="relative flex size-11 items-center justify-center rounded-lg bg-ink font-mono text-sm font-semibold text-primary-foreground">
            SL
            <span className="absolute -bottom-0.5 left-1.5 right-1.5 h-1.5 rounded-sm bg-marker" />
          </span>
          <div>
            <p className="eyebrow">Study Lab</p>
            <h1 className="text-3xl font-semibold sm:text-4xl">Your labs</h1>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setAiOpen(true)}>
            <Bot /> AI coach {ai && !ai.ready && <span className="size-2 rounded-full bg-warn" />}
          </Button>
          <Button variant="outline" onClick={importFile}>
            <FileUp /> Import lab
          </Button>
          <Button onClick={startSetup}>
            <Plus /> New lab
          </Button>
        </div>
      </header>
      <p className="mt-3 max-w-2xl text-ink-2">
        A lab is a study workspace: a certification, a language, a course. Each has its own content, schedule, analytics and AI coach.
      </p>

      {!labs ? (
        <Loader2 className="mt-10 size-5 animate-spin text-ink-3" />
      ) : !labs.length ? (
        <EmptyState onCreate={startSetup} />
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {labs.map((l) => {
            const Icon = KIND_ICON[l.kind] ?? FlaskConical
            const left = daysLeft(l.progress.examDate)
            const seen = l.counts.questions ? Math.round((100 * l.progress.seen) / l.counts.questions) : 0
            return (
              <button key={l.id} type="button" onClick={() => open(l.id)} className="text-left" disabled={!!opening}>
                <Card className="h-full transition-colors hover:border-ink-3">
                  <CardContent className="flex h-full flex-col gap-4">
                    <div className="flex items-start gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-2">
                        {opening === l.id ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
                      </span>
                      <div className="min-w-0">
                        <p className="font-heading text-lg font-semibold leading-tight">{l.name}</p>
                        <p className="mt-0.5 text-xs text-ink-3">
                          {l.config.exam?.code ?? l.kind} · {ago(l.progress.lastStudied)}
                        </p>
                      </div>
                    </div>
                    {l.description && <p className="line-clamp-2 text-sm text-ink-2">{l.description}</p>}
                    <div className="mt-auto grid grid-cols-3 gap-2 text-center">
                      <Mini label="questions" value={l.counts.questions} />
                      <Mini label="cards" value={l.counts.cards} />
                      <Mini label="lectures" value={l.counts.lectures} />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-ink-3">
                        <span>{seen}% of questions seen</span>
                        <span>
                          {l.progress.accuracy != null ? `${Math.round(l.progress.accuracy * 100)}% recent accuracy` : ""}
                          {left != null && left >= 0 ? ` · ${left}d to exam` : ""}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-ink" style={{ width: `${seen}%` }} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </button>
            )
          })}
        </div>
      )}

      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>AI coach</DialogTitle>
            <DialogDescription>One AI setup (your Claude plan or an OpenRouter key) for every lab.</DialogDescription>
          </DialogHeader>
          <AiSettingsPanel compact />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-2 px-2 py-1.5">
      <p className="font-mono text-sm font-semibold tabular">{value.toLocaleString()}</p>
      <p className="text-[0.68rem] text-ink-3">{label}</p>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="mt-8">
      <CardContent className="flex flex-col gap-5 py-10 sm:flex-row sm:items-center">
        <BookOpenCheck className="size-12 shrink-0 text-ink-3" />
        <div className="flex-1 space-y-2">
          <p className="font-heading text-xl font-semibold">Create your first lab</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
            <li>Pick a template: a certification exam, a course, a language or any subject.</li>
            <li>Import content: a Udemy Study Export, a content package, a Study Lab data folder or your own notes.</li>
            <li>
              Let the coach build topics, notes and flashcards, then study. It watches your time, repeated errors and confusions and turns them into a plan. <Sparkles className="inline size-3.5" />
            </li>
          </ol>
        </div>
        <Button onClick={onCreate}>
          <Plus /> New lab
        </Button>
      </CardContent>
    </Card>
  )
}
