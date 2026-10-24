import { Component, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  BarChart3,
  BookOpen,
  Bot,
  ChevronsUpDown,
  CircleAlert,
  Database,
  HardDrive,
  Layers,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Repeat,
  Search,
  Settings as SettingsIcon,
  Timer,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Runner } from "@/components/Runner"
import { LAB, useDataVersion } from "@/lib/data"
import { closeLab, lastLabId, openLab, startEventBridge, startSetup, useJobs, useOpenLab, useSetup } from "@/lib/lab"
import { go, useNav, type View } from "@/lib/nav"
import { useAppState, useSaveError } from "@/lib/store"
import { dueSummary } from "@/lib/stats"
import { applyThemeChoice } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { TodayView } from "@/views/TodayView"
import { CardsView } from "@/views/CardsView"
import { DrillView } from "@/views/DrillView"
import { PracticeView } from "@/views/PracticeView"
import { ExamView } from "@/views/ExamView"
import { NotesView } from "@/views/NotesView"
import { MistakesView } from "@/views/MistakesView"
import { LibraryView } from "@/views/LibraryView"
import { SettingsView } from "@/views/SettingsView"
import { ReviewView } from "@/views/ReviewView"
import { LabsView } from "@/views/LabsView"
import { CoachView } from "@/views/CoachView"
import { AnalyticsView } from "@/views/AnalyticsView"
import { ContentView } from "@/views/ContentView"
import { SetupWizard } from "@/views/SetupWizard"

type NavItem = { view: View; label: string; Icon: LucideIcon }

const STUDY: NavItem[] = [
  { view: "today", label: "Today", Icon: LayoutDashboard },
  { view: "review", label: "Daily review", Icon: Repeat },
  { view: "cards", label: "Flashcards", Icon: Layers },
  { view: "drill", label: "Exam cues", Icon: Zap },
  { view: "practice", label: "Practice", Icon: ListChecks },
  { view: "exam", label: "Mock exam", Icon: Timer },
  { view: "notes", label: "Notes", Icon: BookOpen },
  { view: "mistakes", label: "Mistakes", Icon: CircleAlert },
  { view: "library", label: "Library", Icon: Search },
]

const LEARN: NavItem[] = [
  { view: "coach", label: "Coach", Icon: Bot },
  { view: "analytics", label: "Analytics", Icon: BarChart3 },
]

const LAB_NAV: NavItem[] = [
  { view: "content", label: "Content", Icon: Database },
  { view: "settings", label: "Settings", Icon: SettingsIcon },
]

export default function App() {
  const open = useOpenLab()
  const setup = useSetup()
  const [booting, setBooting] = useState(true)
  const [firstRun, setFirstRun] = useState(false)

  useEffect(() => {
    const stop = startEventBridge()
    void (async () => {
      const labs = await window.studyLab.api.listLabs()
      if (!labs.length) {
        setFirstRun(true)
        startSetup()
      } else {
        const last = lastLabId()
        if (last && labs.some((l) => l.id === last)) await openLab(last).catch(() => undefined)
      }
      setBooting(false)
    })()
    return stop
  }, [])

  return (
    <TooltipProvider delayDuration={250}>
      {booting ? (
        <div className="flex min-h-dvh items-center justify-center">
          <Loader2 className="size-6 animate-spin text-ink-3" />
        </div>
      ) : setup ? (
        <SetupWizard firstRun={firstRun} />
      ) : open ? (
        <Shell key={open} />
      ) : (
        <LabsView />
      )}
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}

function Shell() {
  const nav = useNav()
  const s = useAppState()
  useDataVersion()
  const due = useMemo(() => dueSummary(s), [s.srsc, s.srsq, s.meta.log, LAB]) // eslint-disable-line react-hooks/exhaustive-deps
  const mistakesOpen = useMemo(() => Object.keys(s.meta.mistakes).filter((id) => s.srsq[id]?.la === 0).length, [s.meta.mistakes, s.srsq])
  const jobs = useJobs().filter((j) => j.status === "running")
  const saveError = useSaveError()

  useEffect(() => applyThemeChoice(s.meta.settings.theme), [s.meta.settings.theme])
  useEffect(() => {
    if (saveError) toast.error(`Progress could not be saved: ${saveError}`)
  }, [saveError])

  const badge: Partial<Record<View, number>> = {
    review: due.cards + due.cues + due.qs,
    mistakes: mistakesOpen,
    coach: jobs.length,
  }
  const lab = LAB!

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface">
        <button type="button" onClick={() => void closeLab()} className="mx-3 mb-2 mt-4 flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface-2" title="Switch lab">
          <BrandMark code={lab.config.exam?.code ?? lab.name} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate font-heading text-[0.98rem] font-semibold">{lab.name}</p>
            <p className="text-xs text-ink-3">Switch lab</p>
          </div>
          <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
        </button>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label="Sections">
          {STUDY.map((n) => (
            <NavButton key={n.view} item={n} active={nav.view === n.view} count={badge[n.view]} onClick={() => go(n.view)} />
          ))}
          <p className="eyebrow mb-1 mt-4 px-2.5">Learn smarter</p>
          {LEARN.map((n) => (
            <NavButton key={n.view} item={n} active={nav.view === n.view} count={badge[n.view]} onClick={() => go(n.view)} spin={n.view === "coach" && jobs.length > 0} />
          ))}
          <p className="eyebrow mb-1 mt-4 px-2.5">Lab</p>
          {LAB_NAV.map((n) => (
            <NavButton key={n.view} item={n} active={nav.view === n.view} count={badge[n.view]} onClick={() => go(n.view)} />
          ))}
        </nav>
        <div className="flex flex-col gap-2 border-t border-line p-3">
          <FocusTimer />
          <span className="inline-flex items-center gap-1.5 px-1 text-xs text-ink-3">
            <HardDrive className="size-3.5" /> Saved on this computer
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main" className="flex-1 pb-12 pt-8 gutter-x lg:px-10">
          <div className="mx-auto w-full max-w-6xl">
            <ViewBoundary key={nav.view}>
              <CurrentView view={nav.view} />
            </ViewBoundary>
          </div>
        </main>
      </div>
    </div>
  )
}

/** One broken view shows its error instead of blanking the whole window. */
class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex max-w-xl flex-col gap-3 py-10">
        <p className="eyebrow">Something broke</p>
        <h1 className="text-2xl font-semibold">This page hit an error</h1>
        <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-bad">{this.state.error.message}</pre>
        <p className="text-sm text-ink-2">Your progress is saved. Open another section, or reload with Ctrl+R.</p>
      </div>
    )
  }
}

function CurrentView({ view }: { view: View }) {
  const nav = useNav()
  switch (view) {
    case "review":
      return nav.run ? <Runner key={nav.run.key} spec={nav.run} /> : <ReviewView />
    case "cards":
      return <CardsView />
    case "drill":
      return <DrillView />
    case "practice":
      return <PracticeView />
    case "exam":
      return <ExamView />
    case "notes":
      return <NotesView />
    case "mistakes":
      return <MistakesView />
    case "library":
      return <LibraryView />
    case "coach":
      return <CoachView />
    case "analytics":
      return <AnalyticsView />
    case "content":
      return <ContentView />
    case "settings":
      return <SettingsView />
    default:
      return <TodayView />
  }
}

function BrandMark({ code }: { code: string }) {
  const short = code.replace(/[^A-Za-z0-9]/g, "").slice(-3).toUpperCase() || "SL"
  return (
    <span aria-hidden className="relative flex size-9 shrink-0 items-center justify-center rounded-md bg-ink font-mono text-[0.68rem] font-semibold text-primary-foreground">
      {short}
      <span className="absolute -bottom-0.5 left-1 right-1 h-1.5 rounded-sm bg-marker" />
    </span>
  )
}

function NavButton({ item, active, count, onClick, spin }: { item: NavItem; active: boolean; count?: number; onClick: () => void; spin?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
        active ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2/60 hover:text-ink",
      )}
    >
      <item.Icon className="size-4 shrink-0" />
      <span className={cn("flex-1", active && "hl")}>{item.label}</span>
      {spin ? (
        <Loader2 className="size-3.5 animate-spin text-ink-3" />
      ) : (
        !!count && <span className="rounded-full bg-surface-2 px-1.5 font-mono text-[0.68rem] text-ink-2 tabular">{count > 999 ? "999+" : count}</span>
      )}
    </button>
  )
}

/* Pomodoro: 25 minutes of focus, 5 of rest. Short focused blocks beat long sessions. */
function FocusTimer() {
  const [phase, setPhase] = useState<"focus" | "break">("focus")
  const [left, setLeft] = useState(25 * 60)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    if (left > 0) return
    const next = phase === "focus" ? "break" : "focus"
    setPhase(next)
    setLeft(next === "break" ? 5 * 60 : 25 * 60)
    toast(next === "break" ? "Focus block done. Take 5 minutes away from the screen." : "Break over. Start the next focus block.")
  }, [left, phase])

  const mm = String(Math.floor(left / 60)).padStart(2, "0")
  const ss = String(left % 60).padStart(2, "0")
  return (
    <button
      type="button"
      onClick={() => setRunning((r) => !r)}
      className={cn(
        "flex items-center gap-2 rounded-md border border-line px-2.5 py-2 text-left text-xs transition-colors hover:border-ink-3",
        running && phase === "focus" && "text-ink",
        !running && "text-ink-3",
      )}
      aria-label={running ? "Pause focus timer" : "Start focus timer"}
    >
      {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      <span className="font-mono tabular">
        {mm}:{ss}
      </span>
      <span className="text-ink-3">{phase === "focus" ? "focus block" : "break"}</span>
    </button>
  )
}
