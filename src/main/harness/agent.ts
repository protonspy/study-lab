import { CompositeBackend, createDeepAgent, FilesystemBackend, StateBackend, type SubAgent } from "deepagents"
import { tool, type StructuredTool } from "@langchain/core/tools"
import { AIMessage, type BaseMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type StoredMessage } from "@langchain/core/messages"
import type { ChatToolCall } from "@shared/types"
import { emit, type JobHandle } from "../jobs"
import { currentModel, friendlyAiError, listModels } from "../openrouter"
import { runTool, TOOLS, type Tool, type ToolContext, type Touched } from "../tools"
import { listConnections, loadConnectionTools } from "./connections"
import { makeModel } from "./model"
import { builtinSkillsDir, userSkillsDir } from "./skills"

/*
  The coach's harness: a DeepAgents agent (planning, a scratch filesystem, sub-agents, skills
  loaded on demand) wired to the lab's own tools, to the learner's external MCP servers, and to
  OpenRouter. Every lab tool still goes through the journaled registry, so all writes are undoable.
*/

const STEP_LABEL: Record<string, string> = {
  get_overview: "Reading your analytics",
  list_topics: "Reviewing topics",
  get_topic_report: "Studying a topic",
  get_graph: "Reading the knowledge graph",
  list_mistakes: "Looking at your mistakes",
  get_question: "Reading a question",
  search_content: "Searching the course",
  read_lecture: "Reading a lecture",
  list_items: "Checking items",
  get_plan: "Checking the plan",
  compute_plan: "Computing the schedule",
  get_lab: "Reading the lab setup",
  create_flashcards: "Writing flashcards",
  create_questions: "Writing questions",
  write_study_guide: "Writing a study guide",
  save_study_plan: "Saving the plan",
  save_insight_report: "Saving the report",
  set_focus: "Pinning focus topics",
  create_collection: "Building a practice set",
  upsert_topic: "Organising topics",
  tag_questions: "Tagging questions",
  set_item_status: "Managing material",
  remember: "Saving a note",
  read_file: "Reading a skill",
  task: "Delegating to a sub-agent",
  write_todos: "Planning the work",
}

export function stepLabel(name: string, servers: string[] = []) {
  const server = servers.find((s) => name.startsWith(`${s}_`))
  return STEP_LABEL[name] ?? (server ? `Using ${server}` : name.replace(/_/g, " "))
}

function toLangChain(ctx: ToolContext, tools: Tool[]): StructuredTool[] {
  return tools.map((t) =>
    tool(
      async (args: Record<string, unknown>) => {
        const out = runTool(ctx, t.name, args ?? {}, t)
        let text = JSON.stringify(out.result)
        if (text.length > 24_000) text = `${text.slice(0, 24_000)}… (truncated)`
        return out.ok ? text : `ERROR: ${text}`
      },
      { name: t.name, description: t.description, schema: t.schema as Record<string, unknown> },
    ) as unknown as StructuredTool,
  )
}

export async function ensureHarnessModel() {
  const model = currentModel()
  const m = await listModels()
    .then((l) => l.find((x) => x.id === model))
    .catch(() => undefined)
  if (m?.fit === "unsupported") throw new Error(`${model} cannot run the coach: ${m.notes.join("; ")}. Pick a compatible model in Settings → AI coach.`)
}

export interface RunOptions {
  labId: string
  task: string
  job: JobHandle
  system: string
  /** prior conversation, then the new request */
  messages: BaseMessage[]
  /** registry tools to expose (default: all) */
  tools?: Tool[]
  /** job-specific tools, e.g. the report saver */
  extraTools?: Tool[]
  /** external MCP servers (default: on) */
  connections?: boolean
  /** analyst and author sub-agents (default: on) */
  subagents?: boolean
  maxSteps?: number
  onToolCall?: (calls: ChatToolCall[]) => void
}

export interface RunResult {
  text: string
  /** the messages this run added (for chat history) */
  added: BaseMessage[]
  calls: ChatToolCall[]
}

export async function runLabAgent(o: RunOptions): Promise<RunResult> {
  await ensureHarnessModel()
  const touched = new Set<Touched>()
  const ctx: ToolContext = { labId: o.labId, actor: currentModel(), notify: (w) => w.forEach((x) => touched.add(x)) }
  const flush = () => {
    if (!touched.size) return
    emit({ type: "lab-changed", labId: o.labId, what: [...touched] as ("content" | "config" | "plans" | "insights" | "state")[] })
    touched.clear()
  }
  const registry = o.tools ?? TOOLS
  const own = toLangChain(ctx, [...registry, ...(o.extraTools ?? [])])
  const external = o.connections === false ? { tools: [], close: async () => undefined, errors: [] } : await loadConnectionTools(o.labId)
  const servers = listConnections().map((c) => c.name)
  const model = makeModel({ task: o.task, labId: o.labId, sink: { add: (u, m) => o.job.addUsage(u, m) } })

  const read = toLangChain(
    ctx,
    TOOLS.filter((t) => !t.write),
  )
  const authoring = toLangChain(
    ctx,
    TOOLS.filter((t) => ["search_content", "read_lecture", "get_topic_report", "list_mistakes", "list_items", "create_flashcards", "create_questions", "write_study_guide"].includes(t.name)),
  )
  const subagents: SubAgent[] =
    o.subagents === false
      ? []
      : [
          {
            name: "learning-analyst",
            description: "Reads the learner's analytics and mistakes and returns a short, evidence-backed diagnosis (patterns, numbers, question ids). Read-only.",
            systemPrompt: `${o.system}\n\nYou are the learning analyst. Investigate with the read-only tools, then reply with a compact diagnosis: each finding with its evidence. Do not change anything.`,
            tools: read,
          },
          {
            name: "content-author",
            description: "Writes grounded study material for given topics: study guides, flashcards and exam-style questions, following the writing skills.",
            systemPrompt: `${o.system}\n\nYou are the content author. Read the relevant skill files first, ground everything in the course material, then create the material and report what you created.`,
            tools: authoring,
          },
        ]

  const agent = createDeepAgent({
    model,
    tools: [...own, ...external.tools],
    systemPrompt: o.system,
    subagents,
    backend: new CompositeBackend(new StateBackend(), {
      "/skills/builtin/": new FilesystemBackend({ rootDir: builtinSkillsDir(), virtualMode: true }),
      "/skills/user/": new FilesystemBackend({ rootDir: userSkillsDir(), virtualMode: true }),
    }),
    skills: ["/skills/builtin/", "/skills/user/"],
    permissions: [{ operations: ["write"], paths: ["/skills/**"], mode: "deny" }],
  })

  const calls: ChatToolCall[] = []
  const byRun = new Map<string, ChatToolCall>()
  const callbacks = [
    {
      handleToolStart(_tool: unknown, input: string, runId: string, _parent?: string, _tags?: string[], _meta?: unknown, runName?: string) {
        const name = runName ?? "tool"
        const c: ChatToolCall = { name, args: String(input ?? "").slice(0, 2000) }
        byRun.set(runId, c)
        calls.push(c)
        o.job.step(`${stepLabel(name, servers)}…`, Math.min(0.95, calls.length / (o.maxSteps ?? 20)))
        o.onToolCall?.([...calls])
      },
      handleToolEnd(output: unknown, runId: string) {
        const c = byRun.get(runId)
        if (!c) return
        const text = typeof output === "string" ? output : String((output as { content?: unknown })?.content ?? "")
        c.ok = !text.startsWith("ERROR:")
        c.summary = summarize(text)
        flush()
        o.onToolCall?.([...calls])
      },
      handleToolError(err: unknown, runId: string) {
        const c = byRun.get(runId)
        if (!c) return
        c.ok = false
        c.summary = String((err as Error)?.message ?? err).slice(0, 200)
        o.onToolCall?.([...calls])
      },
    },
  ]

  try {
    const before = o.messages.length
    let res: { messages: BaseMessage[] }
    try {
      res = (await agent.invoke({ messages: o.messages }, { recursionLimit: (o.maxSteps ?? 20) * 3, signal: o.job.signal, callbacks })) as { messages: BaseMessage[] }
    } catch (e) {
      throw friendlyAiError(e)
    }
    const added = res.messages.slice(before)
    const last = [...added].reverse().find((m) => AIMessage.isInstance(m) && !(m as AIMessage).tool_calls?.length)
    if (external.errors.length) calls.push({ name: "mcp-connections", args: "", ok: false, summary: external.errors.join("; ").slice(0, 300) })
    return { text: last ? messageText(last) : "", added, calls }
  } finally {
    flush()
    await external.close().catch(() => undefined)
  }
}

export function messageText(m: BaseMessage): string {
  const c = m.content
  if (typeof c === "string") return c
  return (c as { type?: string; text?: string }[])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
}

function summarize(text: string): string {
  if (text.startsWith("ERROR:")) return text.slice(6, 206).trim()
  try {
    const r = JSON.parse(text) as Record<string, unknown> | unknown[]
    if (Array.isArray(r)) return `${r.length} rows`
    if (typeof r.created === "number") return `created ${r.created}`
    if (typeof r.updated === "number") return `updated ${r.updated}`
    if (typeof r.tagged === "number") return `tagged ${r.tagged}`
  } catch {
    /* not JSON */
  }
  return ""
}

/* ---------- chat history in the database ---------- */

export function toStored(messages: BaseMessage[]): StoredMessage[] {
  return mapChatMessagesToStoredMessages(messages)
}

export function fromStored(raw: unknown[]): BaseMessage[] {
  const stored = raw.filter((m): m is StoredMessage => !!m && typeof m === "object" && "type" in m && "data" in m)
  return mapStoredMessagesToChatMessages(stored)
}
