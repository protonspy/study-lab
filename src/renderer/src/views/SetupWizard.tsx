import { useEffect, useState } from "react"
import { ArrowLeft, ArrowRight, Bot, Check, FlaskConical, GraduationCap, Languages, Library, Loader2, PenLine, Sparkles, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ConnectButton, ModelPicker, useAiSettings } from "@/components/AiSettingsPanel"
import { ImportPanel } from "@/components/ImportPanel"
import { JobStrip, startCoachJob } from "@/components/Jobs"
import { LANGUAGES, type LabPreset } from "@shared/defaults"
import { LAB, useDataVersion } from "@/lib/data"
import { api, finishSetup, openLab, reloadContent, useJobs } from "@/lib/lab"
import { updateSettings } from "@/lib/actions"
import type { ExamConfig, LabKind } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
  First run and "New lab": 1. connect the AI gateway (skipped when it is already set up),
  2. describe the lab, 3. import material, 4. let the coach build the knowledge base.
*/

type Step = "ai" | "lab" | "content" | "kb"
const STEPS: { id: Step; label: string }[] = [
  { id: "ai", label: "AI gateway" },
  { id: "lab", label: "Lab" },
  { id: "content", label: "Content" },
  { id: "kb", label: "Knowledge base" },
]

const KIND_ICON: Record<LabKind, typeof GraduationCap> = { certification: GraduationCap, language: Languages, course: Library, other: FlaskConical }

export function SetupWizard({ firstRun }: { firstRun: boolean }) {
  const [ai, setAi] = useAiSettings()
  const [step, setStep] = useState<Step | null>(null)
  const [labId, setLabId] = useState<string | null>(null)

  useEffect(() => {
    if (ai && !step) setStep(ai.hasKey ? "lab" : "ai")
  }, [ai, step])

  if (!ai || !step) return <Loader2 className="m-10 size-5 animate-spin text-ink-3" />
  const visible = STEPS.filter((s) => s.id !== "ai" || !ai.hasKey || step === "ai")
  const idx = visible.findIndex((s) => s.id === step)

  return (
    <div className="gutter-x mx-auto flex min-h-dvh max-w-3xl flex-col py-10">
      <header className="flex items-center gap-3">
        <span aria-hidden className="relative flex size-10 items-center justify-center rounded-lg bg-ink font-mono text-sm font-semibold text-primary-foreground">
          SL
          <span className="absolute -bottom-0.5 left-1.5 right-1.5 h-1.5 rounded-sm bg-marker" />
        </span>
        <div className="flex-1">
          <p className="eyebrow">{firstRun ? "Welcome to Study Lab" : "New lab"}</p>
          <h1 className="text-2xl font-semibold">Set up your study lab</h1>
        </div>
        {!firstRun && !labId && (
          <Button variant="ghost" size="icon" onClick={finishSetup} aria-label="Cancel">
            <X />
          </Button>
        )}
      </header>

      <ol className="mt-6 flex gap-2">
        {visible.map((s, i) => (
          <li key={s.id} className="flex flex-1 flex-col gap-1.5">
            <span className={cn("h-1 rounded-full", i <= idx ? "bg-ink" : "bg-surface-2")} />
            <span className={cn("text-xs", i === idx ? "font-medium text-ink" : "text-ink-3")}>
              {i + 1}. {s.label}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-8 flex-1">
        {step === "ai" && <AiStep ai={ai} setAi={setAi} onNext={() => setStep("lab")} />}
        {step === "lab" && (
          <LabStep
            onBack={!ai.hasKey ? undefined : visible.some((s) => s.id === "ai") ? () => setStep("ai") : undefined}
            onCreated={(id) => {
              setLabId(id)
              setStep("content")
            }}
          />
        )}
        {step === "content" && labId && <ContentStep labId={labId} onNext={() => setStep("kb")} />}
        {step === "kb" && labId && <KbStep labId={labId} />}
      </div>
    </div>
  )
}

/* ---------- 1. AI gateway ---------- */

function AiStep({ ai, setAi, onNext }: { ai: NonNullable<ReturnType<typeof useAiSettings>[0]>; setAi: (a: typeof ai) => void; onNext: () => void }) {
  const [key, setKey] = useState("")
  const [testing, setTesting] = useState(false)
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Bot className="size-5" /> Connect the AI coach
        </h2>
        <p className="mt-1 text-ink-2">
          The coach runs on <span className="font-medium text-ink">OpenRouter</span>, one account for hundreds of models. Sign in once; the key is stored encrypted on this computer.
        </p>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
        {ai.hasKey ? (
          <p className="flex items-center gap-2 text-sm">
            <Check className="size-4 text-good" /> Connected · key {ai.keyHint}
          </p>
        ) : (
          <ConnectButton onConnected={setAi} />
        )}
        {!ai.hasKey && (
          <div className="space-y-1.5">
            <Label htmlFor="wiz-key" className="text-xs text-ink-3">
              Or paste a key from openrouter.ai/keys
            </Label>
            <div className="flex gap-2">
              <Input id="wiz-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-v1-…" className="font-mono" autoComplete="off" />
              <Button variant="outline" disabled={!key.trim()} onClick={async () => setAi(await api().setAiKey(key.trim()))}>
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <ModelPicker value={ai.model} onChange={async (model) => setAi(await api().updateAiSettings({ model }))} />
        <div className="space-y-1.5">
          <Label>Coach language</Label>
          <Select value={ai.language} onValueChange={async (language) => setAi(await api().updateAiSettings({ language }))}>
            <SelectTrigger className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {ai.hasKey && (
          <Button
            variant="outline"
            disabled={testing}
            onClick={async () => {
              setTesting(true)
              const r = await api().testAi()
              setTesting(false)
              if (r.ok) toast.success(r.message)
              else toast.error(r.message)
            }}
          >
            {testing ? <Loader2 className="animate-spin" /> : <Check />} Test
          </Button>
        )}
        <Button onClick={onNext} disabled={!ai.hasKey}>
          Continue <ArrowRight />
        </Button>
      </div>
    </section>
  )
}

/* ---------- 2. Lab ---------- */

function LabStep({ onCreated, onBack }: { onCreated: (id: string) => void; onBack?: () => void }) {
  const [presets, setPresets] = useState<LabPreset[]>([])
  const [preset, setPreset] = useState("certification")
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [date, setDate] = useState("")
  const [minutes, setMinutes] = useState("45")
  const [exam, setExam] = useState<ExamConfig | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api().presets().then(setPresets)
  }, [])
  const p = presets.find((x) => x.id === preset)
  useEffect(() => setExam(p?.config.exam ? { ...p.config.exam } : null), [p])
  const setE = (k: keyof ExamConfig, v: string) => setExam((e) => (e ? { ...e, [k]: k === "code" ? v : Number(v) || 0 } : e))

  async function create() {
    if (!name.trim()) return toast.error("Give the lab a name.")
    setBusy(true)
    try {
      const lab = await api().createLab({ name: name.trim(), description: goal.trim(), preset })
      if (exam) await api().updateLab(lab.id, { config: { exam: { ...exam, scored: exam.scored || exam.questions } } })
      await openLab(lab.id)
      updateSettings({ examDate: date || null, minutesPerDay: Math.max(10, Number(minutes) || 45) })
      onCreated(lab.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">What are you studying?</h2>
        <p className="mt-1 text-ink-2">A lab holds one goal: an exam, a course, a language. The template only sets the basic shape; topics come from your material.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {presets.map((x) => {
          const Icon = KIND_ICON[x.kind]
          return (
            <button
              key={x.id}
              type="button"
              onClick={() => setPreset(x.id)}
              className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors", preset === x.id ? "border-ink bg-surface" : "border-line hover:border-ink-3")}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block text-sm font-medium">{x.name}</span>
                <span className="mt-0.5 block text-xs text-ink-3">{x.description}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="wiz-name">Name</Label>
          <Input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cloud certification, Spanish B1, Linear algebra" autoFocus />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="wiz-goal">Goal (the coach reads this)</Label>
          <Textarea id="wiz-goal" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Pass with a comfortable margin; I can study on weekdays after work." />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wiz-date">{exam ? "Exam date" : "Target date (optional)"}</Label>
          <Input id="wiz-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wiz-min">Minutes a day</Label>
          <Input id="wiz-min" value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" className="font-mono" />
        </div>
      </div>
      {exam && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-sm font-medium">Exam format</p>
          <p className="text-xs text-ink-3">From the official exam guide. You can change it later.</p>
          <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
            {(
              [
                ["code", "Code"],
                ["questions", "Questions"],
                ["minutes", "Minutes"],
                ["pass", "Pass mark"],
                ["min", "Scale min"],
                ["max", "Scale max"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label className="text-xs text-ink-3">{label}</Label>
                <Input value={String(exam[k] ?? "")} onChange={(e) => setE(k, e.target.value)} className={k === "code" ? "" : "font-mono"} />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex justify-between gap-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={() => void create()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null} Create lab <ArrowRight />
        </Button>
      </div>
    </section>
  )
}

/* ---------- 3. Content ---------- */

function ContentStep({ labId, onNext }: { labId: string; onNext: () => void }) {
  const [imported, setImported] = useState(false)
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Bring in your material</h2>
        <p className="mt-1 text-ink-2">
          Lectures, readings and question banks. Each format is converted to Study Lab's standard content package, so the coach works the same way on any source.
        </p>
      </div>
      <ImportPanel
        labId={labId}
        onImported={async () => {
          await reloadContent()
          setImported(true)
        }}
      />
      <div className="flex justify-end gap-2">
        {!imported && (
          <Button variant="ghost" onClick={finishSetup}>
            Skip, I'll add content later
          </Button>
        )}
        <Button onClick={onNext} disabled={!imported}>
          Continue <ArrowRight />
        </Button>
      </div>
    </section>
  )
}

/* ---------- 4. Knowledge base ---------- */

function KbStep({ labId }: { labId: string }) {
  useDataVersion()
  const jobs = useJobs().filter((j) => j.kind === "build-kb")
  const running = jobs.some((j) => j.status === "running")
  const finished = jobs.some((j) => j.status === "done")
  const [instructions, setInstructions] = useState("")
  const [cards, setCards] = useState("10")
  const hasTopics = (LAB?.counts.topics ?? 0) > 0
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Sparkles className="size-5" /> Build the knowledge base
        </h2>
        <p className="mt-1 text-ink-2">
          The coach reads your material and maps it: domains, topics and knowledge components, how they depend on each other and which ones get confused. It writes notes and flashcards
          grounded in the source, then tags every question. Analytics and plans work on this map.
        </p>
      </div>
      {hasTopics && !jobs.length && (
        <p className="rounded-md bg-good-bg px-3 py-2 text-sm text-good">
          <Check className="mr-1.5 inline size-4" />
          The imported content already has a knowledge base ({LAB?.counts.topics} topics). You can start studying, or have the coach extend it.
        </p>
      )}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
        <div className="flex items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="wiz-cards">Flashcards per topic</Label>
            <Input id="wiz-cards" value={cards} onChange={(e) => setCards(e.target.value)} className="w-24 font-mono" inputMode="numeric" />
          </div>
        </div>
        <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional guidance, e.g. follow the official exam guide's domains; skip the hands-on lab lectures." />
        <Button
          className="w-fit"
          disabled={running}
          onClick={() => void startCoachJob(labId, "build-kb", { cardsPerTopic: Number(cards) || 10, instructions: instructions.trim() || undefined, keep: hasTopics })}
        >
          {running ? <Loader2 className="animate-spin" /> : <Sparkles />} {hasTopics ? "Extend with the coach" : "Build with the coach"}
        </Button>
        <JobStrip kinds={["build-kb"]} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant={finished || hasTopics ? "default" : "ghost"} onClick={finishSetup}>
          {running ? "Keep building in the background" : finished || hasTopics ? "Start studying" : "Skip for now"} <PenLine />
        </Button>
      </div>
    </section>
  )
}
