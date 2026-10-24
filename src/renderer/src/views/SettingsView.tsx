import { useEffect, useState } from "react"
import { Download, FolderOpen, Plus, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Kbd } from "@/components/ui/kbd"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AiSettingsPanel } from "@/components/AiSettingsPanel"
import { ConnectionsCard, SkillsCard } from "@/components/HarnessPanel"
import { DomainDot } from "@/components/Domain"
import { updateSettings } from "@/lib/actions"
import { data, LAB, useDataVersion } from "@/lib/data"
import { api, closeLab, openLab, updateLabConfig } from "@/lib/lab"
import { useNav } from "@/lib/nav"
import { flush, resetAll, useAppState } from "@/lib/store"
import { suggestedNewPerDay } from "@/lib/stats"
import type { Domain, ExamConfig, LabKind, Settings } from "@/lib/types"
import { PageHead } from "@/views/ReviewView"

function NumberSetting({ id, label, value, min, max, onChange, hint }: { id: string; label: string; value: number; min: number; max: number; onChange: (n: number) => void; hint?: string }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Math.max(min, Math.min(max, Math.round(Number(v) || 0)))
          setV(String(n))
          if (n !== value) onChange(n)
        }}
        className="w-28"
      />
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  )
}

function ToggleSetting({ id, label, hint, k }: { id: string; label: string; hint: string; k: keyof Settings }) {
  const s = useAppState()
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={!!s.meta.settings[k]} onCheckedChange={(v) => updateSettings({ [k]: v } as Partial<Settings>)} className="mt-0.5" />
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-ink-3">{hint}</p>
      </div>
    </div>
  )
}

export function SettingsView() {
  const nav = useNav()
  const [tab, setTab] = useState(nav.params.tab ?? "study")
  useEffect(() => {
    if (nav.params.tab) setTab(nav.params.tab)
  }, [nav.params.tab])
  return (
    <div>
      <PageHead eyebrow={LAB?.name ?? "Preferences"} title="Settings" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="study">Study</TabsTrigger>
          <TabsTrigger value="lab">Lab setup</TabsTrigger>
          <TabsTrigger value="ai">AI coach</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>
        <TabsContent value="study">
          <StudySettings />
        </TabsContent>
        <TabsContent value="lab">
          <LabSetup />
        </TabsContent>
        <TabsContent value="ai">
          <div className="flex flex-col gap-6">
            <AiSettingsPanel />
            <div className="grid gap-6 lg:grid-cols-2">
              <SkillsCard />
              <ConnectionsCard />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="data">
          <DataSettings />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function StudySettings() {
  const s = useAppState()
  const st = s.meta.settings
  const sug = suggestedNewPerDay(s)
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>The scheduler caps intervals so every item returns before the exam date.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="space-y-1.5">
            <Label htmlFor="set-exam-date">Exam or goal date</Label>
            <Input id="set-exam-date" type="date" value={st.examDate ?? ""} onChange={(e) => updateSettings({ examDate: e.target.value || null })} className="w-48" />
            {sug && (
              <p className="text-xs text-ink-3">
                {sug.left} days left. Suggested: {sug.cards} new cards and {sug.qs} new questions per day.{" "}
                <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => updateSettings({ newCards: Math.min(300, sug.cards), newQs: Math.min(100, sug.qs) })}>
                  Use these
                </button>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-6">
            <NumberSetting id="set-new-cards" label="New cards per day" value={st.newCards} min={0} max={300} onChange={(n) => updateSettings({ newCards: n })} />
            <NumberSetting id="set-new-qs" label="New questions per day" value={st.newQs} min={0} max={100} onChange={(n) => updateSettings({ newQs: n })} />
            <NumberSetting id="set-max" label="Session cap" value={st.sessionMax} min={10} max={500} onChange={(n) => updateSettings({ sessionMax: n })} hint="Items per daily review" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Study behaviour</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ToggleSetting id="set-shuffle" k="shuffle" label="Shuffle answer options" hint="Stops you memorizing letter positions." />
          <ToggleSetting id="set-highlight" k="highlight" label="Highlight constraint words" hint="Marks LEAST, MOST, NOT, “operational overhead”, “real-time” and similar in question stems." />
          <ToggleSetting id="set-confidence" k="confidence" label="Ask how sure I am" hint="Sure, unsure or guessing before feedback. Confident misses get priority review, and the coach uses it to check your calibration." />
          <ToggleSetting id="set-type" k="typeAnswer" label="Type flashcard answers before flipping" hint="Slower, but generating the answer yourself makes it stick better." />
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Theme</p>
            <ToggleGroup type="single" variant="outline" value={st.theme} onValueChange={(v) => v && updateSettings({ theme: v as Settings["theme"] })}>
              <ToggleGroupItem value="system">System</ToggleGroupItem>
              <ToggleGroupItem value="light">Light</ToggleGroupItem>
              <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keyboard</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>
              <Kbd>A</Kbd>–<Kbd>E</Kbd>
            </dt>
            <dd className="text-ink-2">Choose an option</dd>
            <dt>
              <Kbd>S</Kbd> <Kbd>U</Kbd> <Kbd>G</Kbd>
            </dt>
            <dd className="text-ink-2">Lock in as sure, unsure or guessing</dd>
            <dt>
              <Kbd>Enter</Kbd>
            </dt>
            <dd className="text-ink-2">Lock in (sure) · next question</dd>
            <dt>
              <Kbd>Space</Kbd>
            </dt>
            <dd className="text-ink-2">Flip a flashcard</dd>
            <dt>
              <Kbd>1</Kbd>–<Kbd>4</Kbd>
            </dt>
            <dd className="text-ink-2">Grade a card: again, hard, good, easy</dd>
            <dt>
              <Kbd>F</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd>
            </dt>
            <dd className="text-ink-2">Mock exam: flag, previous, next</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}

const KINDS: { v: LabKind; label: string }[] = [
  { v: "certification", label: "Certification" },
  { v: "language", label: "Language" },
  { v: "course", label: "Course" },
  { v: "other", label: "Other" },
]

function LabSetup() {
  useDataVersion()
  const lab = LAB!
  const [name, setName] = useState(lab.name)
  const [desc, setDesc] = useState(lab.description)
  const [memory, setMemory] = useState(lab.config.memory)
  const [domains, setDomains] = useState<Domain[]>(lab.config.domains)
  const [exam, setExam] = useState<ExamConfig | null>(lab.config.exam)
  useEffect(() => {
    setName(lab.name)
    setDesc(lab.description)
    setMemory(lab.config.memory)
    setDomains(lab.config.domains)
    setExam(lab.config.exam)
  }, [lab])
  const weight = domains.reduce((a, d) => a + (Number(d.w) || 0), 0)

  async function save() {
    const ds = domains.filter((d) => d.name.trim()).map((d, i) => ({ ...d, n: d.n || i + 1, short: d.short.trim() || d.name.trim(), w: Number(d.w) || 0 }))
    if (!ds.length) return toast.error("Keep at least one domain.")
    await updateLabConfig({ name, description: desc, config: { memory, domains: ds, exam } })
    toast.success("Lab saved")
  }

  const setD = (i: number, patch: Partial<Domain>) => setDomains((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const setE = (patch: Partial<ExamConfig>) => setExam((e) => (e ? { ...e, ...patch } : e))

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>About this lab</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="lab-name">Name</Label>
            <Input id="lab-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <ToggleGroup type="single" variant="outline" value={lab.kind} onValueChange={(v) => v && void updateLabConfig({ kind: v as LabKind })}>
              {KINDS.map((k) => (
                <ToggleGroupItem key={k.v} value={k.v}>
                  {k.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-desc">Goal and context</Label>
            <Textarea id="lab-desc" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What you are preparing for, why, and anything the coach should keep in mind." />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-memory">Coach memory</Label>
            <Textarea id="lab-memory" rows={5} value={memory} onChange={(e) => setMemory(e.target.value)} className="font-mono text-xs" placeholder="The coach adds durable notes here (your schedule, preferences, recurring weak spots). You can edit them." />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exam format</CardTitle>
          <CardDescription>Drives the mock exam, the score estimate and the coach's pacing advice.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Switch
              id="has-exam"
              checked={!!exam}
              onCheckedChange={(v) => setExam(v ? (lab.config.exam ?? { code: lab.name.slice(0, 12), questions: 50, scored: 50, minutes: 90, pass: 700, min: 100, max: 1000 }) : null)}
            />
            <Label htmlFor="has-exam">This lab prepares for a timed exam</Label>
          </div>
          {exam && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Code" value={exam.code} onChange={(v) => setE({ code: v })} />
              <Field label="Questions" value={exam.questions} num onChange={(v) => setE({ questions: Number(v) || 1 })} />
              <Field label="Minutes" value={exam.minutes} num onChange={(v) => setE({ minutes: Number(v) || 1 })} />
              <Field label="Scale min" value={exam.min} num onChange={(v) => setE({ min: Number(v) || 0 })} />
              <Field label="Scale max" value={exam.max} num onChange={(v) => setE({ max: Number(v) || 100 })} />
              <Field label="Pass mark" value={exam.pass} num onChange={(v) => setE({ pass: Number(v) || 0 })} />
              <Field label="Extra time (min)" value={exam.extraMinutes ?? 0} num onChange={(v) => setE({ extraMinutes: Number(v) || 0 })} />
              <Field label="Extra time label" value={exam.extraLabel ?? ""} onChange={(v) => setE({ extraLabel: v })} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Domains</CardTitle>
          <CardDescription>
            The big areas of the syllabus and their weight. Weights sum to <span className={weight === 100 ? "text-good" : "text-warn"}>{weight}%</span>. Topics point at domains by number, so keep numbers stable.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {domains.map((d, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <DomainDot d={d.n} />
              <span className="w-8 font-mono text-xs text-ink-3">D{d.n}</span>
              <Input value={d.name} onChange={(e) => setD(i, { name: e.target.value })} placeholder="Name" className="min-w-48 flex-1" />
              <Input value={d.short} onChange={(e) => setD(i, { short: e.target.value })} placeholder="Short label" className="w-44" />
              <Input value={String(d.w)} onChange={(e) => setD(i, { w: Number(e.target.value) || 0 })} className="w-20 font-mono" inputMode="numeric" aria-label="Weight %" />
              <span className="text-xs text-ink-3">%</span>
              <Button variant="ghost" size="icon" disabled={domains.length === 1} onClick={() => setDomains((ds) => ds.filter((_, j) => j !== i))} aria-label="Remove domain">
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <Button variant="outline" size="sm" disabled={domains.length >= 8} onClick={() => setDomains((ds) => [...ds, { n: Math.max(0, ...ds.map((d) => d.n)) + 1, name: "", short: "", w: 0 }])}>
              <Plus /> Add domain
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        <Button onClick={save}>Save lab setup</Button>
      </div>
    </div>
  )
}

/** Edits locally and commits on blur, so typing a number never fights the parser. */
function Field({ label, value, onChange, num }: { label: string; value: string | number; onChange: (v: string) => void; num?: boolean }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  return (
    <div className="space-y-1">
      <Label className="text-xs text-ink-3">{label}</Label>
      <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onChange(v)} inputMode={num ? "numeric" : undefined} className={num ? "font-mono" : undefined} />
    </div>
  )
}

function DataSettings() {
  useDataVersion()
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null)
  const [word, setWord] = useState("")
  const [info, setInfo] = useState<{ dbPath: string; version: string } | null>(null)
  useEffect(() => {
    void api().appInfo().then(setInfo)
  }, [])
  const lab = LAB!

  async function exportLab() {
    await flush()
    const p = await api().exportLab(lab.id)
    if (p) toast.success(`Saved ${p}`)
  }

  async function importOld() {
    const [p] = await api().pickFiles("json")
    if (!p) return
    await flush()
    const r = await api().importProgress(lab.id, p)
    if (!r.ok) return toast.error(r.error)
    toast.success("Progress merged. Reopening the lab…")
    await openLab(lab.id)
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Backup and move</CardTitle>
          <CardDescription>Everything lives in one SQLite file on this computer{info ? `: ${info.dbPath}` : "."}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportLab}>
              <Download /> Export this lab
            </Button>
            <Button variant="outline" onClick={importOld}>
              <Upload /> Merge progress from the browser Study Lab
            </Button>
          </div>
          <p className="text-xs text-ink-3">
            An export holds the lab's content, progress, event log, plans and reports in one .studylab.json file. Import it from the lab picker. The browser version of the AIF-C01/AIP-C01
            Study Lab exports progress from its Settings page; merge it here into a lab built from the same content.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About the content</CardTitle>
          <CardDescription>
            {data().allQuestions.length} questions · {data().allCards.length.toLocaleString()} cards · {data().topics.length} topics{data().kb.builtAt ? ` · built ${data().kb.builtAt.slice(0, 10)}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-ink-2">
          {!!data().kb.conflicts.length && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm">
                  Where the sources may be outdated ({data().kb.conflicts.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-3 flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-2 text-xs">
                  {data().kb.conflicts.map((c, i) => (
                    <li key={i} className="rounded bg-surface-2 px-2.5 py-1.5">
                      {c}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void api().openExternal("https://github.com/protonspy/study-lab")}>
            <FolderOpen /> Project on GitHub {info && `· v${info.version}`}
          </Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setConfirm("reset")}>
            Reset progress in this lab
          </Button>
          <Button variant="destructive" onClick={() => setConfirm("delete")}>
            Delete this lab
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={!!confirm} onOpenChange={(o) => (o ? null : (setConfirm(null), setWord("")))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? `Delete “${lab.name}”?` : "Reset all progress in this lab?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? "The lab's content, progress, plans, reports and chats are removed from this computer. Export it first if you may want it back."
                : "Every review, attempt, mistake, note and mock exam in this lab is erased. Content and settings stay."}{" "}
              Type <span className="font-mono">{confirm}</span> to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={word} onChange={(e) => setWord(e.target.value)} placeholder={confirm ?? ""} autoComplete="off" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={word.trim().toLowerCase() !== confirm}
              className="bg-bad text-primary-foreground hover:bg-bad/90"
              onClick={async () => {
                if (confirm === "reset") {
                  await resetAll()
                  toast("Progress reset")
                } else {
                  const id = lab.id
                  await closeLab()
                  await api().deleteLab(id)
                  toast("Lab deleted")
                }
              }}
            >
              {confirm === "delete" ? "Delete lab" : "Erase progress"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
