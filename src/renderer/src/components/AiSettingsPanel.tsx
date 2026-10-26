import { useEffect, useMemo, useState } from "react"
import { Bot, Check, Copy, Cpu, Download, ExternalLink, KeyRound, Loader2, LogOut, RefreshCw, Search, Server, Wrench, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DEFAULT_MODEL, LANGUAGES } from "@shared/defaults"
import { api } from "@/lib/lab"
import { LAB } from "@/lib/data"
import type { AiProvider, AiSettings, EmbeddingDevice, EmbeddingSource, LocalModelStatus, ModelInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const price = (usdPerM: number) => (usdPerM === 0 ? "free" : usdPerM < 0.1 ? `$${usdPerM.toFixed(3)}` : `$${usdPerM.toFixed(2)}`)
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`
export const ipcError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method 'api': (Error: )?/, "")

/** The AI settings, kept current by the main process (installs, sign-in and downloads report as they go). */
export function useAiSettings() {
  const [ai, setAi] = useState<AiSettings | null>(null)
  useEffect(() => {
    void api().aiSettings().then(setAi)
    return window.studyLab.onEvent((e) => {
      if (e.type === "ai") setAi(e.ai)
    })
  }, [])
  return [ai, setAi] as const
}

type Setter = (a: AiSettings) => void

export function AiSettingsPanel({ compact }: { compact?: boolean }) {
  const [ai, setAi] = useAiSettings()
  const [usage, setUsage] = useState<{ today: number; month: number; total: number; calls: number } | null>(null)

  useEffect(() => {
    void api().usage().then(setUsage)
  }, [ai?.model, ai?.provider])

  if (!ai) return <Loader2 className="size-4 animate-spin text-ink-3" />

  return (
    <div className={cn("grid gap-6", !compact && "lg:grid-cols-2")}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4" /> AI coach
          </CardTitle>
          <CardDescription>Run the coach and the knowledge-base builder on your own Claude plan, or on any OpenRouter model with an API key.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ProviderPicker ai={ai} setAi={setAi} />
          {ai.provider === "claude-code" ? <ClaudeSetup ai={ai} setAi={setAi} /> : <OpenRouterSetup ai={ai} setAi={setAi} />}
          <LanguagePicker ai={ai} setAi={setAi} />
          <div className="flex flex-wrap items-center gap-3">
            <TestButton disabled={!ai.ready} />
            {usage && ai.provider === "openrouter" && (
              <p className="font-mono text-xs text-ink-3 tabular">
                Spent: ${usage.today.toFixed(3)} today · ${usage.month.toFixed(2)} this month · ${usage.total.toFixed(2)} total · {usage.calls} calls
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-6">
        <EmbeddingsCard ai={ai} setAi={setAi} />
        <McpCard ai={ai} onChange={setAi} />
      </div>
    </div>
  )
}

export function ProviderPicker({ ai, setAi }: { ai: AiSettings; setAi: Setter }) {
  return (
    <ToggleGroup type="single" variant="outline" value={ai.provider} onValueChange={async (v) => v && setAi(await api().updateAiSettings({ provider: v as AiProvider }))} className="w-full">
      <ToggleGroupItem value="claude-code" className="flex-1">
        Claude plan
      </ToggleGroupItem>
      <ToggleGroupItem value="openrouter" className="flex-1">
        OpenRouter key
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold", done ? "bg-good-bg text-good" : "bg-surface-2 text-ink-2")}>
        {done ? <Check className="size-3" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  )
}

const CLAUDE_MODELS = [
  { id: "sonnet", label: "Sonnet", hint: "The best balance for coaching and building (default)." },
  { id: "opus", label: "Opus", hint: "The most capable; uses up your plan's limit fastest." },
  { id: "haiku", label: "Haiku", hint: "The fastest and the lightest on your limit." },
]

/** Claude Code inside the app: the pinned install, then the learner's Claude account. */
export function ClaudeSetup({ ai, setAi }: { ai: AiSettings; setAi: Setter }) {
  const c = ai.claude
  const installed = c.binary === "ok"
  const call = async (fn: () => Promise<AiSettings | void>) => {
    try {
      const next = await fn()
      if (next) setAi(next)
    } catch (e) {
      toast.error(ipcError(e))
    }
  }
  return (
    <div className="flex flex-col gap-4 rounded-md border border-line p-4">
      <p className="text-xs text-ink-3">
        Study Lab runs its own copy of Claude Code in the background with your Claude Pro or Max account. Coach runs count against your plan's usage limit, with nothing billed per token. The
        sign-in stays inside Study Lab's Claude Code; the app never reads it.
      </p>
      <Step n={1} done={installed} title={`Claude Code ${c.version}`}>
        {installed && <p className="text-xs text-ink-3">Installed and verified: the pinned release, signed by Anthropic.</p>}
        {c.binary === "unsupported" && <p className="text-xs text-bad">There is no Claude Code build for this computer.</p>}
        {c.binary === "installing" && (
          <div className="flex items-center gap-3">
            <Progress value={(c.progress ?? 0) * 100} className="flex-1" />
            <span className="font-mono text-xs tabular text-ink-3">{Math.round((c.progress ?? 0) * 100)}%</span>
          </div>
        )}
        {(c.binary === "missing" || c.binary === "changed" || c.binary === "failed") && (
          <>
            {c.binary === "changed" && <p className="text-xs text-warn">The installed copy had been changed, so it was deleted. Install it again.</p>}
            {c.binary === "failed" && c.error && <p className="text-xs text-bad">{c.error}</p>}
            <Button size="sm" className="w-fit" onClick={() => void call(() => api().claudeInstall())}>
              <Download /> Install Claude Code (about 300 MB)
            </Button>
          </>
        )}
      </Step>
      <Step n={2} done={c.account.loggedIn} title="Your Claude account">
        {!installed ? (
          <p className="text-xs text-ink-3">After the install.</p>
        ) : c.account.loggedIn ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <span>
              Signed in{c.account.email ? ` as ${c.account.email}` : ""}
              {c.account.plan ? ` · ${c.account.plan} plan` : ""}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void call(() => api().claudeLogout())}>
              <LogOut /> Sign out
            </Button>
          </div>
        ) : c.login ? (
          <ClaudeLogin url={c.login.url} />
        ) : (
          <>
            {c.error && <p className="text-xs text-bad">{c.error}</p>}
            <Button size="sm" className="w-fit" onClick={() => void call(() => api().claudeLogin())}>
              <KeyRound /> Sign in with Claude
            </Button>
          </>
        )}
      </Step>
      <div className="space-y-1.5">
        <Label>Model</Label>
        <Select value={c.model} onValueChange={async (claudeModel) => setAi(await api().updateAiSettings({ claudeModel }))}>
          <SelectTrigger className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-ink-3">{CLAUDE_MODELS.find((m) => m.id === c.model)?.hint}</p>
      </div>
    </div>
  )
}

/** Claude Code opens the sign-in page itself; the button reopens it, and a code the page shows is pasted here. */
function ClaudeLogin({ url }: { url: string | null }) {
  const [code, setCode] = useState("")
  async function send(e: React.FormEvent) {
    e.preventDefault()
    try {
      await api().claudeLoginCode(code)
      setCode("")
    } catch (err) {
      toast.error(ipcError(err))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {url ? (
          <Button size="sm" variant="outline" onClick={() => void api().claudeLoginOpen()}>
            <ExternalLink /> Open the sign-in page
          </Button>
        ) : (
          <span className="flex items-center gap-2 text-xs text-ink-3">
            <Loader2 className="size-3.5 animate-spin" /> Starting the sign-in…
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void api().claudeLoginCancel()}>
          <X /> Cancel
        </Button>
      </div>
      <form onSubmit={send} className="space-y-1.5">
        <Label htmlFor="claude-code" className="text-xs text-ink-3">
          Sign in on the page in your browser. If it shows a code, paste it here
        </Label>
        <div className="flex gap-2">
          <Input id="claude-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" className="font-mono" placeholder="Paste the code" />
          <Button type="submit" disabled={!code.trim()}>
            Send
          </Button>
        </div>
      </form>
    </div>
  )
}

export function OpenRouterSetup({ ai, setAi }: { ai: AiSettings; setAi: Setter }) {
  const [key, setKey] = useState("")
  async function saveKey() {
    const next = await api().setAiKey(key.trim() || null)
    setAi(next)
    setKey("")
    toast.success(next.hasKey ? "Key saved, encrypted with your system keychain." : "Key removed.")
  }
  return (
    <div className="flex flex-col gap-4 rounded-md border border-line p-4">
      <p className="text-xs text-ink-3">
        Any model on{" "}
        <button type="button" className="underline underline-offset-2" onClick={() => void api().openExternal("https://openrouter.ai/keys")}>
          openrouter.ai
        </button>
        , paid per token. Your key stays on this computer, encrypted with the system keychain.
      </p>
      <ConnectButton onConnected={setAi} connected={ai.hasKey} />
      <div className="space-y-1.5">
        <Label htmlFor="or-key">{ai.hasKey ? "API key" : "Or paste an API key"}</Label>
        <div className="flex gap-2">
          <Input id="or-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ai.hasKey ? `Saved: ${ai.keyHint}` : "sk-or-v1-…"} autoComplete="off" className="font-mono" />
          <Button onClick={saveKey} disabled={!key.trim()}>
            Save
          </Button>
        </div>
        {ai.hasKey && (
          <Button variant="ghost" size="sm" className="w-fit" onClick={async () => setAi(await api().setAiKey(null))}>
            Remove key
          </Button>
        )}
      </div>
      <ModelPicker value={ai.model} onChange={async (model) => setAi(await api().updateAiSettings({ model }))} />
    </div>
  )
}

export function LanguagePicker({ ai, setAi }: { ai: AiSettings; setAi: Setter }) {
  return (
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
      <p className="text-xs text-ink-3">The coach talks to you in this language. New study material follows the language of each lab's content.</p>
    </div>
  )
}

export function TestButton({ disabled }: { disabled?: boolean }) {
  const [testing, setTesting] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || testing}
      onClick={async () => {
        setTesting(true)
        const r = await api().testAi()
        setTesting(false)
        if (r.ok) toast.success(r.message)
        else toast.error(r.message)
      }}
    >
      {testing ? <Loader2 className="animate-spin" /> : <Check />} Test connection
    </Button>
  )
}

/** Embeddings for the knowledge graph: the local model by default, OpenRouter's endpoint with a key. */
function EmbeddingsCard({ ai, setAi }: { ai: AiSettings; setAi: Setter }) {
  const m = ai.embeddings.local
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-4" /> Embeddings
        </CardTitle>
        <CardDescription>
          How the knowledge-base builder measures similarity between concepts, lectures, questions and cards. The local model runs on this computer, works offline and costs nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToggleGroup type="single" variant="outline" value={ai.embeddings.source} onValueChange={async (v) => v && setAi(await api().updateAiSettings({ embeddings: v as EmbeddingSource }))} className="w-full">
          <ToggleGroupItem value="local" className="flex-1">
            Local model
          </ToggleGroupItem>
          <ToggleGroupItem value="openrouter" className="flex-1">
            OpenRouter
          </ToggleGroupItem>
        </ToggleGroup>
        {ai.embeddings.source === "local" ? (
          <div className="flex flex-col gap-2 rounded-md border border-line p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm">
                {m.name} <span className="text-xs text-ink-3">· multilingual · {mb(m.size)}</span>
              </span>
              <span className={cn("text-xs", m.state === "ready" ? "text-good" : m.state === "failed" ? "text-bad" : "text-ink-3")}>
                {m.state === "ready" ? "● ready" : m.state === "downloading" ? "downloading" : m.state === "failed" ? "failed" : "not downloaded"}
              </span>
            </div>
            {m.state === "downloading" && (
              <div className="flex items-center gap-3">
                <Progress value={(m.progress ?? 0) * 100} className="flex-1" />
                <span className="font-mono text-xs tabular text-ink-3">{Math.round((m.progress ?? 0) * 100)}%</span>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => void api().localModelCancel()} aria-label="Cancel">
                  <X className="size-4" />
                </Button>
              </div>
            )}
            {m.error && m.state === "failed" && <p className="text-xs text-bad">{m.error}</p>}
            {(m.state === "missing" || m.state === "failed") && (
              <>
                <p className="text-xs text-ink-3">Downloaded once from Hugging Face and checked against a pinned hash. The builder also downloads it the first time it needs it.</p>
                <Button size="sm" variant="outline" className="w-fit" onClick={async () => setAi(await api().localModelDownload())}>
                  <Download /> Download now
                </Button>
              </>
            )}
            {m.state === "ready" && (
              <Button size="sm" variant="ghost" className="w-fit" onClick={async () => setAi(await api().localModelRemove())}>
                Remove the model
              </Button>
            )}
            {m.gpus.length > 0 && <DevicePicker m={m} setAi={setAi} />}
            {m.speed && (
              <p className="font-mono text-xs tabular text-ink-3">
                Last build: {m.speed.perSecond} texts/s on the {m.speed.device.toUpperCase()}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-ink-3">{ai.hasKey ? "baai/bge-m3 through your OpenRouter key, billed per token." : "Needs an OpenRouter key; without one the builder falls back to lexical similarity."}</p>
        )}
      </CardContent>
    </Card>
  )
}

/** CPU or a GPU through DirectML; a GPU that fails leaves the model on the CPU and says why. */
function DevicePicker({ m, setAi }: { m: LocalModelStatus; setAi: Setter }) {
  const set = async (patch: { device?: EmbeddingDevice; gpu?: number }) => setAi(await api().updateAiSettings({ embeddingDevice: patch }))
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center gap-3">
        <Label className="flex-1">Run on</Label>
        <ToggleGroup type="single" variant="outline" size="sm" value={m.device} onValueChange={(v) => v && void set({ device: v as EmbeddingDevice })}>
          <ToggleGroupItem value="cpu">CPU</ToggleGroupItem>
          <ToggleGroupItem value="gpu">GPU</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {m.device === "gpu" && (
        <>
          {m.gpus.length > 1 && (
            <Select value={String(m.gpu)} onValueChange={(v) => void set({ gpu: Number(v) })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a GPU" />
              </SelectTrigger>
              <SelectContent>
                {m.gpus.map((g, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {g.name}
                    {g.highPerformance && <span className="text-xs text-ink-3">· high performance</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-ink-3">Through DirectML. A dedicated graphics card is usually several times faster than the CPU; an integrated one can be slower.</p>
          {m.gpuError && (
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-xs text-bad">The GPU could not run the model, so it runs on the CPU: {m.gpuError}</p>
              <Button size="sm" variant="outline" onClick={() => void set({ device: "gpu", gpu: m.gpu })}>
                <RefreshCw /> Try again
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** OAuth PKCE sign-in: the browser asks for consent and the key comes back to the app. */
export function ConnectButton({ onConnected, connected }: { onConnected: (a: AiSettings) => void; connected?: boolean }) {
  const [waiting, setWaiting] = useState(false)
  async function go() {
    setWaiting(true)
    try {
      const a = await api().connectOpenRouter()
      onConnected(a)
      toast.success("Connected to OpenRouter")
    } catch (e) {
      toast.error(ipcError(e))
    } finally {
      setWaiting(false)
    }
  }
  if (waiting)
    return (
      <div className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5 text-sm">
        <Loader2 className="size-4 animate-spin" />
        <span className="flex-1">Finish signing in to OpenRouter in your browser…</span>
        <Button size="sm" variant="ghost" onClick={() => void api().cancelConnect()}>
          Cancel
        </Button>
      </div>
    )
  return (
    <Button variant={connected ? "outline" : "default"} onClick={() => void go()} className="w-fit">
      <KeyRound /> {connected ? "Reconnect with OpenRouter" : "Connect with OpenRouter"}
    </Button>
  )
}

export function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [compatibleOnly, setCompatibleOnly] = useState(true)

  const load = (force = false) => {
    setErr(null)
    api()
      .listModels(force)
      .then(setModels)
      .catch((e: Error) => setErr(e.message))
  }
  useEffect(() => load(), [])

  const current = models?.find((m) => m.id === value)
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (models ?? [])
      .filter((m) => (!compatibleOnly || m.fit !== "unsupported") && (!needle || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)))
      .sort((a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit] || a.id.localeCompare(b.id))
      .slice(0, 150)
  }, [models, q, compatibleOnly])

  return (
    <div className="space-y-1.5">
      <Label>Model</Label>
      <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{value}</p>
          <p className="text-xs text-ink-3">
            {current
              ? `${Math.round(current.context / 1000)}k context · ${price(current.inPrice)} in / ${price(current.outPrice)} out per 1M tokens`
              : models
                ? "Not in the OpenRouter catalogue right now."
                : err ?? "Loading the catalogue…"}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {value !== DEFAULT_MODEL && (
            <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_MODEL)}>
              Default
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Change"}
          </Button>
        </div>
      </div>
      {current && current.fit !== "ready" && (
        <p className={cn("text-xs", current.fit === "unsupported" ? "text-bad" : "text-warn")}>
          {current.fit === "unsupported" ? "The coach cannot run on this model: " : "Works, with limits: "}
          {current.notes.join("; ")}.
        </p>
      )}
      {open && (
        <div className="rounded-md border border-line">
          <div className="flex items-center gap-2 border-b border-line p-2">
            <Search className="size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 400+ models: claude, gpt, gemini, deepseek…" className="h-8 border-0 shadow-none focus-visible:ring-0" autoFocus />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3" title="Hide models the agent harness cannot use (no tool calling)">
              <Switch checked={compatibleOnly} onCheckedChange={setCompatibleOnly} /> compatible
            </label>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => load(true)} aria-label="Refresh">
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {shown.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                  className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2", m.id === value && "bg-surface-2")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{m.id}</span>
                    <span className="block truncate text-xs text-ink-3">{m.name}</span>
                  </span>
                  <FitBadge fit={m.fit} notes={m.notes} />
                  <span className="shrink-0 font-mono text-[0.7rem] text-ink-3 tabular">
                    {Math.round(m.context / 1000)}k · {price(m.inPrice)}/{price(m.outPrice)}
                  </span>
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-4 text-sm text-ink-3">{err ?? "No model matches."}</li>}
          </ul>
          {q.includes("/") && !shown.some((m) => m.id === q.trim()) && (
            <div className="border-t border-line p-2">
              <Button size="sm" variant="ghost" onClick={() => onChange(q.trim())}>
                Use “{q.trim()}” anyway
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const FIT_RANK = { ready: 0, limited: 1, unsupported: 2 } as const

export function FitBadge({ fit, notes }: { fit: ModelInfo["fit"]; notes: string[] }) {
  const label = fit === "ready" ? "ready" : fit === "limited" ? "limited" : "no tools"
  return (
    <span
      title={notes.join("; ") || "Tool calling, forced tool choice, JSON mode and a wide context"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium",
        fit === "ready" ? "bg-good-bg text-good" : fit === "limited" ? "bg-warn-bg text-warn" : "bg-bad-bg text-bad",
      )}
    >
      <Wrench className="size-3" /> {label}
    </span>
  )
}

function McpCard({ ai, onChange }: { ai: AiSettings; onChange: (a: AiSettings) => void }) {
  const [port, setPort] = useState(String(ai.mcp.port))
  useEffect(() => setPort(String(ai.mcp.port)), [ai.mcp.port])
  const base = `http://127.0.0.1:${ai.mcp.port}/mcp/`
  const url = LAB ? `${base}${LAB.id}` : `${base}<labId>`
  const claudeCmd = `claude mcp add --transport http study-lab-${LAB ? LAB.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) : "lab"} ${url} --header "Authorization: Bearer ${ai.mcp.token}"`
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast.success("Copied"))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" /> MCP server
        </CardTitle>
        <CardDescription>
          Lets other AI tools (Claude Desktop, Claude Code, Cursor…) use the same coach tools on a lab: read your analytics, write cards and questions, save plans. It listens only on this
          computer and needs the token. Every change shows up in Coach → Activity and can be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Switch id="mcp-on" checked={ai.mcp.enabled} onCheckedChange={async (enabled) => onChange(await api().updateAiSettings({ mcp: { enabled } }))} />
          <Label htmlFor="mcp-on">Run the local MCP server</Label>
          <span className={cn("ml-auto text-xs", ai.mcp.running ? "text-good" : "text-ink-3")}>{ai.mcp.running ? "● running" : ai.mcp.enabled ? "stopped" : "off"}</span>
        </div>
        {ai.mcp.error && <p className="text-xs text-bad">{ai.mcp.error}</p>}
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-port">Port</Label>
            <Input id="mcp-port" value={port} onChange={(e) => setPort(e.target.value)} className="w-28 font-mono" inputMode="numeric" />
          </div>
          <Button variant="outline" size="sm" disabled={Number(port) === ai.mcp.port} onClick={async () => onChange(await api().updateAiSettings({ mcp: { port: Number(port) } }))}>
            Apply
          </Button>
          <Button variant="ghost" size="sm" onClick={async () => onChange(await api().updateAiSettings({ mcp: { rotateToken: true } }))}>
            New token
          </Button>
        </div>
        <div className="space-y-1.5">
          <Label>{LAB ? `Endpoint for “${LAB.name}”` : "Endpoint (one per lab)"}</Label>
          <CopyLine text={url} onCopy={copy} />
          <Label className="pt-2">Bearer token</Label>
          <CopyLine text={ai.mcp.token} onCopy={copy} secret />
          {LAB && (
            <>
              <Label className="pt-2">Add to Claude Code</Label>
              <CopyLine text={claudeCmd} onCopy={copy} secret />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function CopyLine({ text, onCopy, secret }: { text: string; onCopy: (t: string) => void; secret?: boolean }) {
  const [show, setShow] = useState(!secret)
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" onClick={() => setShow(true)}>
        {show ? text : "•".repeat(Math.min(32, text.length))}
      </code>
      <Button variant="ghost" size="icon" className="size-7" onClick={() => onCopy(text)} aria-label="Copy">
        <Copy className="size-3.5" />
      </Button>
    </div>
  )
}
