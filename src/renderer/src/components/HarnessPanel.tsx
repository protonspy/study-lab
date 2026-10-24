import { useEffect, useState } from "react"
import { BookMarked, Check, Loader2, Pencil, Plug, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Markdown } from "@/components/Markdown"
import { LAB } from "@/lib/data"
import { api } from "@/lib/lab"
import type { McpConnection, SkillInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'api': (Error: )?/, "")

/* ---------- skills ---------- */

export function SkillsCard() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [editing, setEditing] = useState<{ name: string; description: string; body: string; isNew: boolean } | null>(null)
  const load = () => void api().skills().then(setSkills)
  useEffect(load, [])

  async function save() {
    if (!editing) return
    try {
      await api().saveSkill(editing)
      setEditing(null)
      load()
      toast.success("Skill saved")
    } catch (e) {
      toast.error(clean(e))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookMarked className="size-4" /> Skills
        </CardTitle>
        <CardDescription>
          Playbooks the coach reads when a task calls for one. It sees only their names and descriptions until it needs the full text. Add your own to teach it how you like to study; a skill
          with a built-in's name replaces it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {skills.map((s) => (
          <Collapsible key={s.name}>
            <div className="rounded-md border border-line">
              <div className="flex items-start gap-2 px-3 py-2">
                <CollapsibleTrigger className="min-w-0 flex-1 text-left">
                  <p className="font-mono text-sm">
                    {s.name} {s.builtin && <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-0.5 font-sans text-[0.65rem] text-ink-3">built-in</span>}
                  </p>
                  <p className="line-clamp-2 text-xs text-ink-3">{s.description}</p>
                </CollapsibleTrigger>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={s.builtin ? "Customise" : "Edit"}
                  onClick={() => setEditing({ name: s.name, description: s.description, body: s.body, isNew: false })}
                >
                  <Pencil className="size-3.5" />
                </Button>
                {!s.builtin && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Delete"
                    onClick={async () => {
                      await api().deleteSkill(s.name)
                      load()
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
              <CollapsibleContent>
                <Markdown text={s.body} className="border-t border-line px-3 py-2 text-xs" />
              </CollapsibleContent>
            </div>
          </Collapsible>
        ))}
        {editing ? (
          <div className="flex flex-col gap-2 rounded-md border border-ink p-3">
            <Label htmlFor="sk-name">Name</Label>
            <Input id="sk-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="font-mono" placeholder="exam-day-routine" />
            <Label htmlFor="sk-desc">When should the coach use it?</Label>
            <Textarea id="sk-desc" rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            <Label htmlFor="sk-body">Instructions (Markdown)</Label>
            <Textarea id="sk-body" rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} className="font-mono text-xs" />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void save()}>
                <Check /> Save skill
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <X /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setEditing({ name: "", description: "", body: "", isNew: true })}>
            <Plus /> New skill
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/* ---------- external MCP connections ---------- */

type Draft = Omit<McpConnection, "id"> & { id?: string; headerText: string; argText: string }

const emptyDraft = (): Draft => ({ name: "", transport: "http", url: "", headers: {}, command: "", args: [], enabled: true, labs: "all", headerText: "", argText: "" })

function toDraft(c: McpConnection): Draft {
  return {
    ...c,
    headerText: Object.entries(c.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
    argText: (c.args ?? []).join(" "),
  }
}

export function ConnectionsCard() {
  const [list, setList] = useState<McpConnection[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; tools: string[]; error?: string }>>({})
  const load = () => void api().mcpConnections().then(setList)
  useEffect(load, [])

  async function save() {
    if (!draft) return
    const headers = Object.fromEntries(
      draft.headerText
        .split("\n")
        .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
        .filter(([k, v]) => k && v),
    )
    const args = draft.argText.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? []
    const { headerText: _h, argText: _a, ...rest } = draft
    try {
      await api().saveMcpConnection({ ...rest, headers, args })
      setDraft(null)
      load()
    } catch (e) {
      toast.error(clean(e))
    }
  }

  async function test(id: string) {
    setTesting(id)
    const r = await api().testMcpConnection(id)
    setResults((x) => ({ ...x, [id]: r }))
    setTesting(null)
  }

  const labScoped = (c: McpConnection) => (c.labs === "all" ? "all labs" : LAB && c.labs.includes(LAB.id) ? "this lab" : `${c.labs.length} labs`)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4" /> MCP connections
        </CardTitle>
        <CardDescription>
          Give the coach other tools: documentation, your notes app, a calendar, another service. It can use any MCP server, either a local command or an HTTP endpoint. Its tools appear to
          the coach prefixed with the connection's name.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {list.map((c) => (
          <div key={c.id} className="rounded-md border border-line px-3 py-2">
            <div className="flex items-center gap-2">
              <Switch
                checked={c.enabled}
                onCheckedChange={async (enabled) => {
                  await api().saveMcpConnection({ ...c, enabled })
                  load()
                }}
                aria-label="Enabled"
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm">{c.name}</p>
                <p className="truncate text-xs text-ink-3">
                  {c.transport === "http" ? c.url : `${c.command} ${(c.args ?? []).join(" ")}`} · {labScoped(c)}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void test(c.id)} disabled={testing === c.id}>
                {testing === c.id ? <Loader2 className="animate-spin" /> : "Test"}
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => setDraft(toDraft(c))} aria-label="Edit">
                <Pencil className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Delete"
                onClick={async () => {
                  await api().deleteMcpConnection(c.id)
                  load()
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {results[c.id] && (
              <p className={cn("mt-1 text-xs", results[c.id].ok ? "text-good" : "text-bad")}>
                {results[c.id].ok ? `${results[c.id].tools.length} tools: ${results[c.id].tools.slice(0, 8).join(", ")}${results[c.id].tools.length > 8 ? "…" : ""}` : results[c.id].error}
              </p>
            )}
          </div>
        ))}
        {!list.length && !draft && <p className="text-sm text-ink-3">No connections yet.</p>}
        {draft ? (
          <div className="flex flex-col gap-2 rounded-md border border-ink p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="mc-name">Name</Label>
                <Input id="mc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-44 font-mono" placeholder="notes" />
              </div>
              <ToggleGroup type="single" variant="outline" value={draft.transport} onValueChange={(v) => v && setDraft({ ...draft, transport: v as Draft["transport"] })}>
                <ToggleGroupItem value="http">HTTP</ToggleGroupItem>
                <ToggleGroupItem value="stdio">Local command</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {draft.transport === "http" ? (
              <>
                <Label htmlFor="mc-url">URL</Label>
                <Input id="mc-url" value={draft.url ?? ""} onChange={(e) => setDraft({ ...draft, url: e.target.value })} className="font-mono" placeholder="https://example.com/mcp" />
                <Label htmlFor="mc-headers">Headers (one per line, e.g. Authorization: Bearer …)</Label>
                <Textarea id="mc-headers" rows={2} value={draft.headerText} onChange={(e) => setDraft({ ...draft, headerText: e.target.value })} className="font-mono text-xs" />
              </>
            ) : (
              <>
                <Label htmlFor="mc-cmd">Command</Label>
                <Input id="mc-cmd" value={draft.command ?? ""} onChange={(e) => setDraft({ ...draft, command: e.target.value })} className="font-mono" placeholder="npx" />
                <Label htmlFor="mc-args">Arguments</Label>
                <Input id="mc-args" value={draft.argText} onChange={(e) => setDraft({ ...draft, argText: e.target.value })} className="font-mono" placeholder="-y @modelcontextprotocol/server-filesystem C:/notes" />
              </>
            )}
            {LAB && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.labs !== "all"} onCheckedChange={(only) => setDraft({ ...draft, labs: only ? [LAB!.id] : "all" })} />
                Only for “{LAB.name}”
              </label>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void save()}>
                <Check /> Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                <X /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setDraft(emptyDraft())}>
            <Plus /> Add connection
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
