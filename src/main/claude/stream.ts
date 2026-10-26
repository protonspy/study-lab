/*
  Claude Code's `stream-json` output, read line by line into what the coach shows: each tool call
  with its arguments, its outcome when the result comes back, and the final answer with its usage.
  Tool names go back to the harness's: `mcp__studylab__get_overview` is `get_overview`, a tool of
  an external connection `mcp__notes__search` is `notes_search`, and the Agent tool is `task`.
*/

export const LAB_SERVER = "studylab"

// The text comes from course material and external servers: no control characters.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

export function clean(v: unknown): string {
  return String(v ?? "").replace(CONTROL, "")
}

export function harnessName(name: string): string {
  if (name === "Agent" || name === "Task") return "task"
  const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name)
  if (!m) return name
  return m[1] === LAB_SERVER ? m[2] : `${m[1]}_${m[2]}`
}

export interface StreamCall {
  id: string
  name: string
  args: string
  /** set when the call ran inside a sub-agent */
  parent?: string
}

export interface StreamResult {
  id: string
  ok: boolean
  text: string
}

export interface StreamUsage {
  tokensIn: number
  tokensOut: number
  model: string
}

export interface StreamEnd {
  text: string
  error: boolean
  session: string | null
  structured?: unknown
  usage: StreamUsage
  /** what Claude Code gave as the error subtype or API status, when it failed */
  reason?: string
}

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function blocks(e: Record<string, unknown>): Block[] {
  const m = isObj(e.message) ? e.message : {}
  return Array.isArray(m.content) ? (m.content as Block[]) : []
}

export class StreamReader {
  session: string | null = null
  end: StreamEnd | null = null
  /** the tools and agents Claude Code announced at start */
  tools: string[] = []
  model = ""
  private lastText = ""

  /** One line of output: the calls it starts and the results it brings. */
  line(raw: string): { calls: StreamCall[]; results: StreamResult[] } {
    const none = { calls: [], results: [] }
    let e: unknown
    try {
      e = JSON.parse(raw)
    } catch {
      return none
    }
    if (!isObj(e)) return none
    if (typeof e.session_id === "string") this.session = e.session_id
    if (e.type === "system" && e.subtype === "init") {
      this.tools = Array.isArray(e.tools) ? e.tools.map(clean) : []
      if (typeof e.model === "string") this.model = e.model
      return none
    }
    if (e.type === "assistant") return { calls: this.assistant(e), results: [] }
    if (e.type === "user") return { calls: [], results: this.results(e) }
    if (e.type === "result") this.finish(e)
    return none
  }

  private assistant(e: Record<string, unknown>): StreamCall[] {
    const out: StreamCall[] = []
    const parent = typeof e.parent_tool_use_id === "string" && e.parent_tool_use_id ? e.parent_tool_use_id : undefined
    for (const b of blocks(e)) {
      if (b.type === "text" && b.text?.trim() && !parent) this.lastText = clean(b.text)
      if (b.type !== "tool_use") continue
      const name = harnessName(clean(b.name))
      let args: Record<string, unknown> = b.input ?? {}
      if (name === "task") args = { subagent_type: clean(args.subagent_type || "general-purpose"), description: clean(args.description ?? args.prompt) }
      out.push({ id: clean(b.id), name, args: JSON.stringify(args).slice(0, 2000), parent })
    }
    return out
  }

  private results(e: Record<string, unknown>): StreamResult[] {
    const out: StreamResult[] = []
    for (const b of blocks(e)) {
      if (b.type !== "tool_result") continue
      const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? (b.content as Block[]) : []
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => clean(p.text))
        .join("\n")
      out.push({ id: clean(b.tool_use_id), ok: b.is_error !== true, text })
    }
    return out
  }

  private finish(e: Record<string, unknown>) {
    const u = isObj(e.usage) ? e.usage : {}
    const n = (v: unknown) => (typeof v === "number" ? v : 0)
    const models = isObj(e.modelUsage) ? Object.keys(e.modelUsage) : []
    const error = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success")
    this.end = {
      text: clean(e.result ?? this.lastText).trim(),
      error,
      session: this.session,
      structured: e.structured_output,
      usage: {
        tokensIn: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
        tokensOut: n(u.output_tokens),
        model: this.model || models[0] || "claude",
      },
      reason: error ? clean(e.api_error_status ?? e.subtype ?? "") || undefined : undefined,
    }
  }
}
