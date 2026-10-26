import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatToolCall, McpConnection } from "@shared/types"
import { claudeModel, ensureClaudeReady, runClaude } from "../claude/service"
import { LAB_SERVER } from "../claude/stream"
import { startRunServer } from "../mcp"
import { logAiCall } from "../repo"
import { TOOLS, type Tool } from "../tools"
import type { RunOptions, RunResult } from "./agent"
import { listConnections } from "./connections"
import { listSkills } from "./skills"
import { stepLabel, summarize } from "./steps"

/*
  The coach on the learner's Claude plan: the same job as the DeepAgents harness, run by the app's
  Claude Code. The lab's tools reach it through a private MCP endpoint for this run only (so every
  write is still journaled and undoable), the learner's external connections go in the run's MCP
  config, skills are read through a tool, and the two sub-agents are Claude Code agents.
*/

const AUTHORING = ["search_content", "read_lecture", "get_topic_report", "list_mistakes", "list_items", "create_flashcards", "create_questions", "write_study_guide"]

function skillTool(): Tool {
  return {
    name: "read_skill",
    description: "Read the full instructions of a skill by name. Read the matching skill before a task and follow it.",
    write: false,
    schema: { type: "object", properties: { name: { type: "string", description: "Skill name, e.g. learning-diagnosis" } }, required: ["name"] },
    run(_ctx, a) {
      const s = listSkills().find((x) => x.name === String(a.name ?? "").trim())
      if (!s) throw new Error(`Unknown skill. Skills: ${listSkills().map((x) => x.name).join(", ")}`)
      return { name: s.name, instructions: s.body }
    },
  }
}

function connectionConfig(c: McpConnection): Record<string, unknown> {
  return c.transport === "http" ? { type: "http", url: c.url, headers: c.headers ?? {} } : { type: "stdio", command: c.command, args: c.args ?? [], env: c.env ?? {} }
}

function text(m: BaseMessage): string {
  const c = m.content
  if (typeof c === "string") return c
  return (c as { type?: string; text?: string }[]).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("")
}

/** The new request, with the earlier turns written out when there is no session to resume. */
export function promptFrom(messages: BaseMessage[], resumed: boolean): string {
  const last = messages.at(-1)
  const request = last ? text(last) : ""
  if (resumed) return request
  const earlier = messages
    .slice(0, -1)
    .filter((m) => HumanMessage.isInstance(m) || (AIMessage.isInstance(m) && !(m as AIMessage).tool_calls?.length))
    .map((m) => `${HumanMessage.isInstance(m) ? "Learner" : "Coach"}: ${text(m).trim()}`)
    .filter((l) => !/^\w+: (⚠️.*)?$/s.test(l))
  return earlier.length ? `Earlier in this conversation:\n\n${earlier.join("\n\n")}\n\n---\n\n${request}` : request
}

export async function runClaudeAgent(o: RunOptions): Promise<RunResult> {
  await ensureClaudeReady()
  const model = claudeModel()
  const registry = [...(o.tools ?? TOOLS), ...(o.extraTools ?? [])]
  const names = new Set(registry.map((t) => t.name))
  const authoring = names.has("create_flashcards") || names.has("create_questions")
  const read = TOOLS.filter((t) => !t.write)
  const served = new Map<string, Tool>()
  for (const t of [...registry, skillTool(), ...(o.subagents === false ? [] : read), ...(o.subagents !== false && authoring ? TOOLS.filter((t) => AUTHORING.includes(t.name)) : [])]) if (!served.has(t.name)) served.set(t.name, t)
  const full = (n: string) => `mcp__${LAB_SERVER}__${n}`

  const external = o.connections === false ? [] : listConnections().filter((c) => c.enabled && (c.labs === "all" || c.labs.includes(o.labId)) && c.name !== LAB_SERVER)
  const skills = listSkills()
  const system = `${o.system}

# Tools in this session
The lab's tools are the ${LAB_SERVER} MCP tools: get_overview is mcp__${LAB_SERVER}__get_overview, and so on.${external.length ? ` Tools named mcp__<connection>__… come from the learner's external connections (${external.map((c) => c.name).join(", ")}).` : ""}
Skills (read one with read_skill before the matching task): ${skills.map((s) => `${s.name}: ${s.description}`).join("; ") || "none"}.`

  const agents: Record<string, { description: string; prompt: string; tools: string[] }> = {}
  if (o.subagents !== false) {
    agents["learning-analyst"] = {
      description: "Reads the learner's analytics and mistakes and returns a short, evidence-backed diagnosis (patterns, numbers, question ids). Read-only.",
      prompt: `${system}\n\nYou are the learning analyst. Investigate with the read-only tools, then reply with a compact diagnosis: each finding with its evidence. Do not change anything.`,
      tools: [...read.map((t) => full(t.name)), full("read_skill")],
    }
    if (authoring)
      agents["content-author"] = {
        description: "Writes grounded study material for given topics: study guides, flashcards and exam-style questions, following the writing skills.",
        prompt: `${system}\n\nYou are the content author. Read the relevant skills first (read_skill), ground everything in the course material, then create the material and report what you created.`,
        tools: [...AUTHORING.map(full), full("read_skill")],
      }
  }

  const server = await startRunServer(o.labId, [...served.values()], `claude-code:${model}`)
  const calls: ChatToolCall[] = []
  const byId = new Map<string, ChatToolCall>()
  const servers = external.map((c) => c.name)
  try {
    const end = await runClaude({
      prompt: promptFrom(o.messages, !!o.resume),
      system,
      model,
      resume: o.resume,
      persist: o.persist,
      signal: o.job.signal,
      mcpServers: {
        [LAB_SERVER]: { type: "http", url: server.url, headers: { Authorization: "Bearer ${STUDYLAB_RUN_TOKEN}" } },
        ...Object.fromEntries(external.map((c) => [c.name, connectionConfig(c)])),
      },
      env: { STUDYLAB_RUN_TOKEN: server.token },
      agents,
      onCall(c) {
        const call: ChatToolCall = { name: c.name, args: c.args }
        byId.set(c.id, call)
        calls.push(call)
        o.job.step(`${stepLabel(c.name, servers)}…`, Math.min(0.95, calls.length / (o.maxSteps ?? 20)))
        o.onToolCall?.([...calls])
      },
      onResult(r) {
        const call = byId.get(r.id)
        if (!call) return
        call.ok = r.ok
        call.summary = r.ok ? summarize(r.text) : r.text.replace(/^\{\s*"error":\s*"?|"?\s*\}$/g, "").slice(0, 200)
        o.onToolCall?.([...calls])
      },
    })
    const label = `claude-code/${model}`
    logAiCall(o.labId, o.task, label, end.usage.tokensIn, end.usage.tokensOut, 0)
    o.job.addUsage({ tokensIn: end.usage.tokensIn, tokensOut: end.usage.tokensOut, cost: 0 }, label)
    return { text: end.text, added: [new AIMessage(end.text)], calls, session: end.session ?? undefined }
  } finally {
    await server.close()
  }
}
