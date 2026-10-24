import { useEffect, useMemo, useState } from "react"
import { Check, Copy, KeyRound, Loader2, RefreshCw, Search, Server, Wrench } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DEFAULT_MODEL, LANGUAGES } from "@shared/defaults"
import { api } from "@/lib/lab"
import { LAB } from "@/lib/data"
import type { AiSettings, ModelInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const price = (usdPerM: number) => (usdPerM === 0 ? "free" : usdPerM < 0.1 ? `$${usdPerM.toFixed(3)}` : `$${usdPerM.toFixed(2)}`)

export function useAiSettings() {
  const [ai, setAi] = useState<AiSettings | null>(null)
  useEffect(() => {
    void api().aiSettings().then(setAi)
  }, [])
  return [ai, setAi] as const
}

export function AiSettingsPanel({ compact }: { compact?: boolean }) {
  const [ai, setAi] = useAiSettings()
  const [key, setKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [usage, setUsage] = useState<{ today: number; month: number; total: number; calls: number } | null>(null)

  useEffect(() => {
    void api().usage().then(setUsage)
  }, [ai?.model])

  if (!ai) return <Loader2 className="size-4 animate-spin text-ink-3" />

  async function saveKey() {
    const next = await api().setAiKey(key.trim() || null)
    setAi(next)
    setKey("")
    toast.success(next.hasKey ? "Key saved, encrypted with your system keychain." : "Key removed.")
  }

  async function test() {
    setTesting(true)
    const r = await api().testAi()
    setTesting(false)
    if (r.ok) toast.success(r.message)
    else toast.error(r.message)
  }

  return (
    <div className={cn("grid gap-6", !compact && "lg:grid-cols-2")}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> OpenRouter
          </CardTitle>
          <CardDescription>
            The coach runs on any model available on{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void api().openExternal("https://openrouter.ai/keys")}>
              openrouter.ai
            </button>
            . Your key stays on this computer, encrypted with the system keychain.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="or-key">API key</Label>
            <div className="flex gap-2">
              <Input
                id="or-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={ai.hasKey ? `Saved: ${ai.keyHint}` : "sk-or-v1-…"}
                autoComplete="off"
                className="font-mono"
              />
              <Button onClick={saveKey} disabled={!key.trim()}>
                Save
              </Button>
            </div>
            {ai.hasKey && (
              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={test} disabled={testing}>
                  {testing ? <Loader2 className="animate-spin" /> : <Check />} Test connection
                </Button>
                <Button variant="ghost" size="sm" onClick={async () => setAi(await api().setAiKey(null))}>
                  Remove key
                </Button>
              </div>
            )}
          </div>
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
            <p className="text-xs text-ink-3">The coach talks to you in this language. New study material follows the language of each lab's content.</p>
          </div>
          {usage && (
            <p className="font-mono text-xs text-ink-3 tabular">
              Spent: ${usage.today.toFixed(3)} today · ${usage.month.toFixed(2)} this month · ${usage.total.toFixed(2)} total · {usage.calls} calls
            </p>
          )}
        </CardContent>
      </Card>
      <McpCard ai={ai} onChange={setAi} />
    </div>
  )
}

function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [toolsOnly, setToolsOnly] = useState(true)

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
      .filter((m) => (!toolsOnly || m.tools) && (!needle || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)))
      .slice(0, 120)
  }, [models, q, toolsOnly])

  return (
    <div className="space-y-1.5">
      <Label>Model</Label>
      <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{value}</p>
          <p className="text-xs text-ink-3">
            {current
              ? `${Math.round(current.context / 1000)}k context · ${price(current.inPrice)} in / ${price(current.outPrice)} out per 1M tokens${current.tools ? "" : " · no tool use"}`
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
      {current && !current.tools && <p className="text-xs text-bad">This model cannot call tools, so the coach cannot read your data or change the lab. Pick one marked with a wrench.</p>}
      {open && (
        <div className="rounded-md border border-line">
          <div className="flex items-center gap-2 border-b border-line p-2">
            <Search className="size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 400+ models: claude, gpt, gemini, deepseek…" className="h-8 border-0 shadow-none focus-visible:ring-0" autoFocus />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
              <Switch checked={toolsOnly} onCheckedChange={setToolsOnly} /> tools
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
                  {m.tools && <Wrench className="size-3.5 shrink-0 text-ink-3" aria-label="tool use" />}
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
