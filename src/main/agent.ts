import { dayKey, daysUntil } from "@shared/analytics"
import type { GenerateOptions, PlanOptions } from "@shared/api"
import type { ChatMessage, ChatToolCall, InsightItem, InsightReport, Misconception } from "@shared/types"
import { getSetting } from "./db"
import { emit, type JobHandle } from "./jobs"
import { chat, currentModel, listModels, type Msg, type ToolDef } from "./openrouter"
import * as repo from "./repo"
import { runTool, TOOLS, type Tool, type ToolContext, type Touched } from "./tools"

/* ---------- prompt ---------- */

export function language(): string {
  return getSetting("ai.language", "Português (Brasil)")
}

function contentLanguageHint(labId: string): string {
  const sample = repo.readContent(labId).questions.slice(0, 5).map((q) => q.stem).join(" ")
  if (!sample) return "the language the learner uses"
  const pt = (sample.match(/\b(que|não|uma|para|com|é|qual|empresa)\b/gi) ?? []).length
  const es = (sample.match(/\b(qué|una|para|con|es|cuál|empresa|los)\b/gi) ?? []).length
  const en = (sample.match(/\b(the|which|what|company|a|is|to|of)\b/gi) ?? []).length
  return en >= pt && en >= es ? "English" : pt >= es ? "Portuguese" : "Spanish"
}

export function systemPrompt(labId: string): string {
  const lab = repo.getLab(labId)
  const meta = repo.readMeta(labId)
  const cfg = lab.config
  const left = daysUntil(meta.settings.examDate)
  const exam = cfg.exam
    ? `${cfg.exam.code}: ${cfg.exam.questions} questions in ${cfg.exam.minutes} minutes (${Math.round((cfg.exam.minutes * 60) / cfg.exam.questions)} s per question), pass mark ${cfg.exam.pass} on a ${cfg.exam.min}–${cfg.exam.max} scale.`
    : "No timed exam is configured for this lab."
  const plan = repo.activePlan(labId)
  return `You are the study coach inside Study Lab, a desktop app for learning with spaced repetition, retrieval practice and analytics. You work on one lab.

# The lab
Name: ${lab.name} (${lab.kind})${lab.description ? `\nDescription: ${lab.description}` : ""}
Exam: ${exam}
Domains: ${cfg.domains.map((d) => `D${d.n} ${d.name} (${d.w}%)`).join("; ")}
Content: ${lab.counts.questions} questions, ${lab.counts.cards} flashcards, ${lab.counts.topics} topics, ${lab.counts.lectures} lecture transcripts.
Today: ${dayKey()}. Exam date: ${meta.settings.examDate ? `${meta.settings.examDate} (${left} days left)` : "not set"}.
Daily limits: ${meta.settings.newCards} new cards, ${meta.settings.newQs} new questions, sessions up to ${meta.settings.sessionMax} items.
Active plan: ${plan ? `"${plan.title}" started ${plan.start}` : "none"}.
Focus topics pinned on Today: ${cfg.focus.join(", ") || "none"}.

# Lab memory (notes you or the learner saved earlier)
${cfg.memory || "(empty — use the remember tool to keep durable facts about the learner)"}

# Language
Talk to the learner in ${language()}. Write study material (flashcards, questions, guides, topic notes) in ${contentLanguageHint(labId)}, the language of the lab's content, unless the learner asks otherwise.

# How you work
- Ground every claim in tool data. Cite numbers and question ids. Never guess the learner's performance.
- Diagnose before prescribing. Start broad (get_overview), then drill into topics and actual mistakes.
- Tell apart: knowledge gaps (low accuracy everywhere in a topic), misconceptions (the same wrong option picked again, confident errors), forgetting (right, then wrong after days), rushing (answers much faster than reading time), and confusion between look-alike topics.
- Use learning science: spaced retrieval, interleaving, elaboration, worked contrasts for look-alikes, and fixing confident errors first. Keep the daily load realistic.
- You can change the lab with write tools: create flashcards, questions and study guides; organise topics; archive learned material; pin focus topics; save study plans and practice sets; adjust study settings. Every change is logged and the learner can undo it, so act when it clearly helps, and say what you changed.
- When creating content, search the lecture transcripts first and stay faithful to them. Do not invent product facts; if the course material does not cover something, say so.
- Be concise and concrete. Prefer short sections and bullet points.`
}

/* ---------- agent loop ---------- */

function toolDefs(tools: Tool[]): ToolDef[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }))
}

const STEP_LABEL: Record<string, string> = {
  get_overview: "Reading your analytics",
  list_topics: "Reviewing topics",
  get_topic_report: "Studying a topic",
  list_mistakes: "Looking at your mistakes",
  get_question: "Reading a question",
  search_content: "Searching the course",
  read_lecture: "Reading a lecture",
  list_items: "Checking items",
  get_plan: "Checking the plan",
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
}

export interface LoopResult {
  text: string
  raw: Msg[]
  calls: ChatToolCall[]
}

async function ensureToolModel() {
  const model = currentModel()
  try {
    const m = (await listModels()).find((x) => x.id === model)
    if (m && !m.tools) throw new Error(`${model} cannot call tools. Pick a model with tool support in Settings → AI coach.`)
  } catch (e) {
    if ((e as Error).message.includes("cannot call tools")) throw e
  }
}

export async function agentLoop(opts: {
  labId: string
  messages: Msg[]
  tools: Tool[]
  job: JobHandle
  task: string
  extraTools?: Tool[]
  maxSteps?: number
  onCall?: (c: ChatToolCall) => void
}): Promise<LoopResult> {
  await ensureToolModel()
  const tools = [...opts.tools, ...(opts.extraTools ?? [])]
  const byName = new Map(tools.map((t) => [t.name, t]))
  const defs = toolDefs(tools)
  const raw: Msg[] = []
  const calls: ChatToolCall[] = []
  const touched = new Set<Touched>()
  const ctx: ToolContext = { labId: opts.labId, actor: currentModel(), notify: (w) => w.forEach((x) => touched.add(x)) }
  const flush = () => {
    if (touched.size) emit({ type: "lab-changed", labId: opts.labId, what: [...touched] as ("content" | "config" | "plans" | "insights" | "state")[] })
    touched.clear()
  }
  const max = opts.maxSteps ?? 14
  try {
    for (let step = 0; step < max; step++) {
      const res = await chat({ messages: [...opts.messages, ...raw], tools: defs, task: opts.task, labId: opts.labId, signal: opts.job.signal, maxTokens: 8000 })
      opts.job.addUsage(res.usage, res.model)
      const msg = res.message
      const toolCalls = msg.tool_calls ?? []
      raw.push({ role: "assistant", content: msg.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      if (!toolCalls.length) return { text: msg.content ?? "", raw, calls }
      for (const tc of toolCalls) {
        opts.job.step(`${STEP_LABEL[tc.function.name] ?? tc.function.name}…`, Math.min(0.95, (step + 1) / max))
        let args: Record<string, unknown> = {}
        try {
          args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
        } catch {
          raw.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "Arguments were not valid JSON. Try again." }) })
          continue
        }
        const tool = byName.get(tc.function.name)
        const out = tool ? runTool(ctx, tc.function.name, args, tool) : { ok: false, result: { error: `Unknown tool ${tc.function.name}` } }
        const call: ChatToolCall = { name: tc.function.name, args: tc.function.arguments.slice(0, 2000), ok: out.ok, summary: summarize(out.result) }
        calls.push(call)
        opts.onCall?.(call)
        let text = JSON.stringify(out.result)
        if (text.length > 24000) text = `${text.slice(0, 24000)}… (truncated)`
        raw.push({ role: "tool", tool_call_id: tc.id, content: text })
      }
      flush()
    }
    // Out of steps: ask for a wrap-up without tools.
    const res = await chat({
      messages: [...opts.messages, ...raw, { role: "user", content: "Stop calling tools now and give your final answer based on what you have." }],
      task: opts.task,
      labId: opts.labId,
      signal: opts.job.signal,
    })
    opts.job.addUsage(res.usage, res.model)
    raw.push({ role: "assistant", content: res.message.content ?? "" })
    return { text: res.message.content ?? "", raw, calls }
  } finally {
    flush()
  }
}

function summarize(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const r = result as Record<string, unknown>
  if (r.error) return String(r.error).slice(0, 200)
  if (typeof r.created === "number") return `created ${r.created}`
  if (typeof r.updated === "number") return `updated ${r.updated}`
  if (typeof r.tagged === "number") return `tagged ${r.tagged}`
  if (Array.isArray(result)) return `${result.length} rows`
  return ""
}

/* ---------- jobs ---------- */

const READ = TOOLS.filter((t) => !t.write)
const pick = (...names: string[]) => TOOLS.filter((t) => names.includes(t.name))

function reportTool(labId: string, onSaved: (r: InsightReport) => void): Tool {
  return {
    name: "save_insight_report",
    description: "Save your analysis as a report the learner can read. Call it exactly once, at the end.",
    write: false,
    schema: {
      type: "object",
      properties: {
        headline: { type: "string", description: "One sentence: the most important thing right now" },
        summary: { type: "string", description: "3–5 sentences" },
        strengths: { type: "array", items: { type: "string" } },
        insights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              detail: { type: "string", description: "What the data shows and what to do about it" },
              severity: { type: "string", enum: ["high", "medium", "low", "positive"] },
              kind: { type: "string", enum: ["time", "repeat", "confusion", "calibration", "forgetting", "coverage", "habit", "other"] },
              topics: { type: "array", items: { type: "string" } },
              evidence: { type: "array", items: { type: "string" }, description: "Numbers and question ids" },
            },
            required: ["title", "detail", "severity", "kind"],
          },
        },
        misconceptions: {
          type: "array",
          items: {
            type: "object",
            properties: { topic: { type: "string" }, belief: { type: "string" }, correction: { type: "string" }, questions: { type: "array", items: { type: "string" } } },
            required: ["topic", "belief", "correction"],
          },
        },
        next: { type: "array", items: { type: "string" }, description: "3–5 concrete next actions" },
      },
      required: ["headline", "summary", "insights", "next"],
    },
    run(ctx, a) {
      const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : [])
      const report: InsightReport = {
        id: repo.newId("ins_"),
        at: Date.now(),
        model: ctx.actor,
        headline: String(a.headline ?? ""),
        summary: String(a.summary ?? ""),
        strengths: arr<string>(a.strengths).map(String),
        insights: arr<InsightItem>(a.insights).map((i) => ({
          title: String(i.title ?? ""),
          detail: String(i.detail ?? ""),
          severity: (["high", "medium", "low", "positive"].includes(i.severity) ? i.severity : "medium") as InsightItem["severity"],
          kind: i.kind ?? "other",
          topics: arr<string>(i.topics),
          evidence: arr<string>(i.evidence).map(String),
        })),
        misconceptions: arr<Misconception>(a.misconceptions).map((m) => ({ topic: String(m.topic ?? ""), belief: String(m.belief ?? ""), correction: String(m.correction ?? ""), questions: arr<string>(m.questions) })),
        next: arr<string>(a.next).map(String),
      }
      repo.saveInsight(labId, report)
      onSaved(report)
      ctx.notify(["insights"])
      return { saved: report.id }
    },
  }
}

function latestInsightText(labId: string): string {
  const r = repo.listInsights(labId)[0]
  if (!r) return "No analysis report yet."
  return `Latest analysis (${new Date(r.at).toISOString().slice(0, 10)}): ${r.headline}\n${r.summary}\n${r.insights.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}`).join("\n")}\nMisconceptions: ${r.misconceptions.map((m) => `${m.topic}: ${m.belief} → ${m.correction}`).join("; ") || "none"}`
}

export async function runAnalyze(labId: string, job: JobHandle) {
  let saved: InsightReport | null = null
  const res = await agentLoop({
    labId,
    job,
    task: "analyze",
    tools: READ,
    extraTools: [reportTool(labId, (r) => (saved = r))],
    messages: [
      { role: "system", content: systemPrompt(labId) },
      {
        role: "user",
        content: `Analyse how I am learning in this lab. Start with get_overview, then look at my weakest topics and my actual wrong answers (list_mistakes) to find patterns: knowledge gaps, misconceptions, forgetting, rushing, confidence calibration and confusable topics. Then call save_insight_report once with specific, evidence-backed insights and next actions. Write the report in ${language()}.`,
      },
    ],
  })
  if (!saved) {
    // Some models answer in prose instead of calling the tool; keep that answer as a report.
    const report: InsightReport = {
      id: repo.newId("ins_"),
      at: Date.now(),
      model: currentModel(),
      headline: "Analysis",
      summary: res.text,
      strengths: [],
      insights: [],
      misconceptions: [],
      next: [],
    }
    repo.saveInsight(labId, report)
    emit({ type: "lab-changed", labId, what: ["insights"] })
  }
}

export async function runPlan(labId: string, job: JobHandle, o: PlanOptions) {
  const days = Math.max(1, Math.min(30, o.days ?? 7))
  const minutes = Math.max(10, Math.min(480, o.minutesPerDay ?? 60))
  await agentLoop({
    labId,
    job,
    task: "plan",
    maxSteps: 16,
    tools: [...READ, ...pick("save_study_plan", "create_collection", "set_focus", "update_study_settings", "remember")],
    messages: [
      { role: "system", content: systemPrompt(labId) },
      {
        role: "user",
        content: `Build my study plan for the next ${days} days, about ${minutes} minutes a day.
${latestInsightText(labId)}

Steps: check get_overview and get_plan; look at the weakest and not-yet-started topics weighted by exam weight; then
1. pin 2–5 focus topics with set_focus;
2. if useful, create one or two practice sets with create_collection (e.g. my repeated errors, or confusable topics side by side);
3. save the plan with save_study_plan: every day starts with a "review" task, then targeted work; spread topics (interleave), revisit weak topics after 1–3 days, schedule a mock exam when it makes sense, keep each day close to ${minutes} minutes.
Write titles, focus lines and reasons in ${language()}.${o.instructions ? `\nAlso: ${o.instructions}` : ""}
Finish with a short summary of the plan and why.`,
      },
    ],
  })
}

export async function runGenerate(labId: string, job: JobHandle, o: GenerateOptions) {
  const cards = Math.max(0, Math.min(30, o.cards ?? 8))
  const questions = Math.max(0, Math.min(15, o.questions ?? 4))
  const topics = o.topics?.length ? `these topics: ${o.topics.join(", ")}` : "the 2–3 topics where I need it most (use the analytics; prefer weak topics with misconceptions or repeated errors)"
  await agentLoop({
    labId,
    job,
    task: "generate",
    maxSteps: 24,
    tools: [...READ, ...pick("create_flashcards", "create_questions", "write_study_guide", "upsert_topic", "set_item_status")],
    messages: [
      { role: "system", content: systemPrompt(labId) },
      {
        role: "user",
        content: `Create new study material for ${topics}.
${latestInsightText(labId)}

For each topic: read get_topic_report and list_mistakes for it, search_content / read_lecture for the course material, then
${o.guide !== false ? "- write_study_guide: a focused guide that fixes my specific misconceptions, contrasts look-alikes in a table and ends with 3 self-check questions;\n" : ""}${cards ? `- create_flashcards: about ${cards} cards (mix concept, compare and trigger cards) aimed at what I get wrong;\n` : ""}${questions ? `- create_questions: about ${questions} new exam-style questions with plausible distractors built from my actual wrong picks, and a rationale for every option;\n` : ""}- if two topics are easy to confuse, record it with upsert_topic (confusable).
Do not duplicate cards or questions that already exist.${o.instructions ? `\nAlso: ${o.instructions}` : ""}
Finish with a short list of what you created.`,
      },
    ],
  })
}

/* ---------- chat ---------- */

export async function runChat(labId: string, threadId: string, text: string, job: JobHandle) {
  const at = Date.now()
  const userRaw: Msg = { role: "user", content: text }
  const history = trimHistory(repo.rawMessages(threadId) as Msg[])
  const userMsg = repo.addMessage(threadId, { role: "user", content: text, at }, [userRaw])
  emit({ type: "chat", labId, threadId, message: userMsg })
  const calls: ChatToolCall[] = []
  try {
    const res = await agentLoop({
      labId,
      job,
      task: "chat",
      maxSteps: 16,
      tools: TOOLS,
      messages: [{ role: "system", content: systemPrompt(labId) }, ...history, userRaw],
      onCall: (c) => {
        calls.push(c)
        emit({ type: "chat", labId, threadId, message: { id: -1, role: "assistant", content: "", tools: [...calls], at: Date.now() } })
      },
    })
    const msg = repo.addMessage(threadId, { role: "assistant", content: res.text || "(no answer)", tools: res.calls, at: Date.now() }, res.raw)
    emit({ type: "chat", labId, threadId, message: msg })
  } catch (e) {
    const msg = repo.addMessage(threadId, { role: "assistant", content: `⚠️ ${(e as Error).message}`, tools: calls, at: Date.now() })
    emit({ type: "chat", labId, threadId, message: msg })
    throw e
  }
}

/** Keep the conversation affordable: last ~40 provider messages, old tool results shortened. */
function trimHistory(msgs: Msg[]): Msg[] {
  let out = msgs.slice(-40)
  // Never start on a tool result or an assistant tool call whose results were cut off.
  while (out.length && out[0].role !== "user") out = out.slice(1)
  return out.map((m, i) => (m.role === "tool" && i < out.length - 12 && m.content.length > 1500 ? { ...m, content: `${m.content.slice(0, 1500)}… (truncated)` } : m))
}

export function chatTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60)
}

export type { ChatMessage }
