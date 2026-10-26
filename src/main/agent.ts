import { dayKey, daysUntil } from "@shared/analytics"
import type { GenerateOptions, PlanOptions } from "@shared/api"
import type { ChatToolCall, InsightItem, InsightReport, Misconception } from "@shared/types"
import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { getSetting } from "./db"
import { fromStored, runLabAgent, toStored } from "./harness/agent"
import { emit, type JobHandle } from "./jobs"
import { activeModel } from "./llm"
import * as repo from "./repo"
import { TOOLS, type Tool } from "./tools"

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
- Skills: before a task, read the matching skill file (learning-diagnosis, study-planning, flashcard-writing, question-writing, study-guide, knowledge-mapping, content-curation, or the learner's own skills) and follow it.
- Delegate focused work to sub-agents when it helps: learning-analyst for diagnosis, content-author for writing material.
- Tools whose names start with a connection name and an underscore come from the learner's external MCP connections; use them when they are relevant.
- Be concise and concrete. Prefer short sections and bullet points.`
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
  const res = await runLabAgent({
    labId,
    job,
    task: "analyze",
    tools: READ,
    extraTools: [reportTool(labId, (r) => (saved = r))],
    connections: false,
    system: systemPrompt(labId),
    messages: [
      new HumanMessage(
        `Analyse how I am learning in this lab, following the learning-diagnosis skill. Start with get_overview, read my weakest concepts and actual wrong answers, then call save_insight_report once with specific, evidence-backed insights and next actions. Write the report in ${language()}.`,
      ),
    ],
  })
  if (!saved) {
    // Some models answer in prose instead of calling the tool; keep that answer as a report.
    repo.saveInsight(labId, { id: repo.newId("ins_"), at: Date.now(), model: activeModel(), headline: "Analysis", summary: res.text, strengths: [], insights: [], misconceptions: [], next: [] })
    emit({ type: "lab-changed", labId, what: ["insights"] })
  }
}

export async function runPlan(labId: string, job: JobHandle, o: PlanOptions) {
  const days = Math.max(1, Math.min(30, o.days ?? 7))
  const minutes = o.minutesPerDay ?? repo.readMeta(labId).settings.minutesPerDay
  await runLabAgent({
    labId,
    job,
    task: "plan",
    maxSteps: 16,
    tools: [...READ, ...pick("save_study_plan", "create_collection", "set_focus", "update_study_settings", "remember")],
    system: systemPrompt(labId),
    messages: [
      new HumanMessage(`Build my study plan for the next ${days} days, about ${minutes} minutes a day, following the study-planning skill.
${latestInsightText(labId)}${o.instructions ? `
Also: ${o.instructions}` : ""}
Write titles, focus lines and reasons in ${language()}. Finish with a short summary of the plan and why.`),
    ],
  })
}

export async function runGenerate(labId: string, job: JobHandle, o: GenerateOptions) {
  const cards = Math.max(0, Math.min(30, o.cards ?? 8))
  const questions = Math.max(0, Math.min(15, o.questions ?? 4))
  const topics = o.topics?.length ? `these topics: ${o.topics.join(", ")}` : "the 2–3 topics where I need it most (use the analytics; prefer weak topics with misconceptions or repeated errors)"
  await runLabAgent({
    labId,
    job,
    task: "generate",
    maxSteps: 30,
    tools: [...READ, ...pick("create_flashcards", "create_questions", "write_study_guide", "upsert_topic", "set_item_status")],
    system: systemPrompt(labId),
    messages: [
      new HumanMessage(`Create new study material for ${topics}.
${latestInsightText(labId)}

For each topic, read get_topic_report and list_mistakes, ground yourself in search_content / read_lecture, then
${[
        o.guide !== false && "- write a study guide (study-guide skill) that fixes my specific misconceptions;",
        cards && `- about ${cards} flashcards (flashcard-writing skill) aimed at what I get wrong;`,
        questions && `- about ${questions} exam-style questions (question-writing skill) with distractors from my actual wrong picks;`,
        "- if two topics are easy to confuse, record it with upsert_topic (confusable).",
        o.instructions && `Also: ${o.instructions}`,
      ]
        .filter(Boolean)
        .join("\n")}
Finish with a short list of what you created.`),
    ],
  })
}

/* ---------- chat ---------- */

export async function runChat(labId: string, threadId: string, text: string, job: JobHandle) {
  const at = Date.now()
  const user = new HumanMessage(text)
  const history = trimHistory(fromStored(repo.rawMessages(threadId)))
  // A Claude Code session resumes only when it holds every message so far (no turn ran elsewhere since).
  const session = repo.threadSession(threadId)
  const resume = session && session.upto === repo.lastMessageId(threadId) ? session.id : undefined
  const userMsg = repo.addMessage(threadId, { role: "user", content: text, at }, toStored([user]))
  emit({ type: "chat", labId, threadId, message: userMsg })
  let calls: ChatToolCall[] = []
  try {
    const res = await runLabAgent({
      labId,
      job,
      task: "chat",
      maxSteps: 20,
      system: systemPrompt(labId),
      messages: [...history, user],
      resume,
      persist: true,
      onToolCall: (c) => {
        calls = c
        emit({ type: "chat", labId, threadId, message: { id: -1, role: "assistant", content: "", tools: c, at: Date.now() } })
      },
    })
    const msg = repo.addMessage(threadId, { role: "assistant", content: res.text || "(no answer)", tools: res.calls, at: Date.now() }, toStored(res.added))
    repo.setThreadSession(threadId, res.session ? { id: res.session, upto: msg.id } : null)
    emit({ type: "chat", labId, threadId, message: msg })
  } catch (e) {
    const msg = repo.addMessage(threadId, { role: "assistant", content: `⚠️ ${(e as Error).message}`, tools: calls, at: Date.now() })
    emit({ type: "chat", labId, threadId, message: msg })
    throw e
  }
}

/** Keep the conversation affordable: the last ~40 messages, starting on a user turn, old tool results shortened. */
function trimHistory(msgs: BaseMessage[]): BaseMessage[] {
  let out = msgs.slice(-40)
  while (out.length && !HumanMessage.isInstance(out[0])) out = out.slice(1)
  return out.map((m, i) => {
    if (!ToolMessage.isInstance(m) || i >= out.length - 12 || typeof m.content !== "string" || m.content.length <= 1500) return m
    return new ToolMessage({ content: `${m.content.slice(0, 1500)}… (truncated)`, tool_call_id: m.tool_call_id, name: m.name })
  })
}

export function chatTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60)
}
