import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeDb, openDb } from "../src/main/db"
import * as repo from "../src/main/repo"
import { importUdemy } from "../src/main/importers"
import { saveKey } from "../src/main/openrouter"
import { runAnalyze, runChat, runPlan } from "../src/main/agent"
import { runBuildKb } from "../src/main/buildkb"
import type { JobHandle } from "../src/main/jobs"
import { DEFAULT_MODEL } from "../src/shared/defaults"

/*
  The coach against a scripted OpenRouter: each test queues the model's replies (tool calls or
  JSON) and checks what the app did with them and what it sent back.
*/

const fixtures = join(import.meta.dirname, "fixtures")
const dir = mkdtempSync(join(tmpdir(), "study-lab-agent-"))
let labId = ""

type Reply = { content?: string | null; tool_calls?: { name: string; args: unknown }[] }
let script: Reply[] = []
let requests: { messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[]; response_format?: unknown }[] = []
const realFetch = globalThis.fetch
let scripted: typeof fetch = realFetch

function job(): JobHandle {
  return { id: "j", signal: new AbortController().signal, step: () => undefined, addUsage: () => undefined }
}

before(async () => {
  process.env.STUDY_LAB_USER_SKILLS = join(dir, "skills")
  openDb(join(dir, "agent.db"))
  await saveKey("sk-or-test")
  labId = repo.createLab({ name: "Cloud", preset: "certification" }).id
  await importUdemy(labId, [join(fixtures, "sample-simulados.md"), join(fixtures, "sample-transcricoes.md")])
  globalThis.fetch = scripted = (async (url: string, init?: RequestInit) => {
    // No embedding model in tests: the builder falls back to local lexical vectors.
    if (String(url).endsWith("/embeddings")) return new Response("{}", { status: 404 })
    if (String(url).endsWith("/models"))
      return new Response(JSON.stringify({ data: [{ id: DEFAULT_MODEL, name: "DeepSeek", context_length: 1e6, pricing: { prompt: "0.00000015", completion: "0.0000006" }, supported_parameters: ["tools", "response_format"] }] }))
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    const next = script.shift()
    if (!next) throw new Error("The script ran out of replies")
    let n = 0
    const message = {
      role: "assistant",
      content: next.content ?? null,
      tool_calls: next.tool_calls?.map((t) => ({ id: `call_${requests.length}_${n++}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })),
    }
    return new Response(JSON.stringify({ id: `gen-${requests.length}`, model: body.model, choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 } }))
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  script = []
  requests = []
  globalThis.fetch = scripted
})

describe("knowledge base builder", () => {
  it("builds a concept graph: chunks, concepts, topics, Q-matrix with distractors, grounded notes", async () => {
    const qs = repo.readContent(labId).questions
    const card = (front: string, chunk: string) => ({ front, back: "b", kind: "concept", chunk })
    const notes = { summary: ["S"], keyPoints: ["K"], examTips: [], pitfalls: [], mnemonics: [], cards: [card("Bucket?", "3:0"), card("At rest?", "4:0")] }
    script = [
      {
        content: JSON.stringify({
          concepts: [
            { name: "Object storage", definition: "Files kept as objects in buckets, durable and shared.", kind: "concept", chunks: ["3:0"], relies_on: [] },
            { name: "Encryption at rest", definition: "Protects data on disks and snapshots if media is stolen.", kind: "concept", chunks: ["4:0", "9:9"], relies_on: [] },
            { name: "Course welcome", definition: "Intro.", kind: "fact", chunks: ["1:0"] },
          ],
        }),
      },
      {
        content: JSON.stringify({
          domains: [
            { n: 1, name: "Storage", short: "Storage", w: 60 },
            { n: 2, name: "Security", short: "Security", w: 40 },
          ],
          topics: [
            { id: "storage", title: "Storage", domain: 1, covers: "Buckets" },
            { id: "security", title: "Security", domain: 2, covers: "Encryption" },
          ],
          assign: [
            { kc: "kc-object-storage", topic: "storage" },
            { kc: "kc-encryption-at-rest", topic: "security" },
          ],
        }),
      },
      {
        content: JSON.stringify({
          items: [
            { qid: qs[0].id, primary: "kc-object-storage", distractors: { "0": "kc-encryption-at-rest" }, confidence: 0.9 },
            { qid: qs[1].id, primary: "kc-encryption-at-rest", confidence: 0.6 },
            { qid: qs[2].id, primary: "kc-encryption-at-rest", distractors: { "1": "kc-object-storage", "0": "kc-object-storage" }, confidence: 0.9 },
          ],
        }),
      },
      { content: JSON.stringify(notes) },
      { content: JSON.stringify(notes) },
    ]
    await runBuildKb(labId, job(), { cardsPerTopic: 3, keep: false })
    const c = repo.readContent(labId)
    const g = c.graph
    assert.equal(g.topicLevel, false)
    assert.ok(g.kcs.some((k) => k.id === "kc-object-storage" && k.topic === "storage" && k.evidence.includes("3:0")))
    assert.deepEqual(g.kcs.find((k) => k.id === "kc-encryption-at-rest")!.evidence, ["4:0"], "unknown chunk ids are dropped")
    assert.deepEqual(repo.getConfig(labId).domains.map((d) => d.name), ["Storage", "Security"])
    // Q-matrix and distractors; the correct option is never tagged as a distractor.
    assert.equal(g.itemKc[qs[0].id][0].kc, "kc-object-storage")
    assert.deepEqual(g.optionKc[qs[2].id], { 1: "kc-object-storage" })
    const conf = g.edges.find((e) => e.type === "confusable")!
    assert.equal(conf.method, "distractor")
    assert.equal(conf.weight, 2)
    // Topic tags and domains follow the concepts, so older views keep working.
    assert.deepEqual(c.kb.tags[qs[2].id], ["security"])
    assert.equal(c.questions.find((q) => q.id === qs[2].id)!.d, 2)
    // Grounding: each topic keeps only the card citing its own chunk.
    assert.deepEqual(c.kb.cards.map((x) => [x.t, x.f]).sort(), [["security", "At rest?"], ["storage", "Bucket?"]])
    assert.match(repo.listChanges(labId)[0].summary, /knowledge graph/)
    assert.equal(requests.length, 5)
  })

  it("breaks prerequisite cycles at their weakest edge", async () => {
    const { breakCycles } = await import("../src/main/buildkb")
    const e = (src: string, dst: string, weight: number) => ({ src, dst, type: "prerequisite" as const, weight, method: "t", evidence: "", status: "accepted" as const })
    const out = breakCycles([e("a", "b", 0.9), e("b", "c", 0.8), e("c", "a", 0.6), e("a", "c", 0.7)])
    assert.deepEqual(out.map((x) => `${x.src}${x.dst}`).sort(), ["ab", "ac", "bc"])
  })
})

describe("coach jobs", () => {
  before(() => {
    const qs = repo.readContent(labId).questions
    const now = Date.now()
    repo.addEvents(
      labId,
      [0, 1, 2].map((i) => ({ at: now - (3 - i) * 1000, kind: "q" as const, item: qs[0].id, mode: "practice", correct: 0 as const, grade: 1, conf: 2 as const, picks: [0], ms: 15000 })),
    )
  })

  it("analyses with tools and saves an insight report", async () => {
    script = [
      { tool_calls: [{ name: "get_overview", args: {} }] },
      { tool_calls: [{ name: "list_mistakes", args: { limit: 5 } }] },
      {
        tool_calls: [
          {
            name: "save_insight_report",
            args: {
              headline: "You keep picking local disk for shared storage",
              summary: "Three misses with the same option.",
              insights: [{ title: "Repeated pick", detail: "Same wrong option 3×", severity: "high", kind: "repeat", topics: ["object-storage"], evidence: ["3 misses"] }],
              misconceptions: [{ topic: "object-storage", belief: "Local disks are shared", correction: "Object storage is shared" }],
              next: ["Drill object storage"],
            },
          },
        ],
      },
      { content: "Saved." },
    ]
    await runAnalyze(labId, job())
    const r = repo.listInsights(labId)[0]
    assert.equal(r.headline, "You keep picking local disk for shared storage")
    assert.equal(r.insights[0].severity, "high")
    // The model saw real data from its tools.
    const toolMsgs = requests[2].messages.filter((m) => m.role === "tool")
    assert.equal(toolMsgs.length, 2)
    assert.match(toolMsgs[0].content!, /"attempts":3/)
    assert.match(toolMsgs[1].content!, /"timesWrong"/)
    assert.ok(requests[0].tools!.some((t) => t.function.name === "save_insight_report"))
    assert.ok(!requests[0].tools!.some((t) => t.function.name === "create_flashcards"), "analysis is read-only")
  })

  it("plans: pins focus topics and saves a day-by-day plan", async () => {
    script = [
      { tool_calls: [{ name: "set_focus", args: { topics: ["storage"] } }] },
      {
        tool_calls: [
          {
            name: "save_study_plan",
            args: { title: "Fix storage", goal: "Stop the repeated miss", rationale: "From the report", days: [{ focus: "Storage", tasks: [{ type: "practice", title: "Drill", topics: ["storage"], minutes: 20 }] }] },
          },
        ],
      },
      { content: "Plan saved: one day." },
    ]
    await runPlan(labId, job(), { days: 1, minutesPerDay: 30 })
    assert.equal(repo.activePlan(labId)!.title, "Fix storage")
    assert.deepEqual(repo.getConfig(labId).focus, ["storage"])
    assert.match(requests[0].messages[1].content!, /Latest analysis/)
  })

  it("chats, keeps tool history valid across turns, and reports tool errors to the model", async () => {
    const thread = repo.createThread(labId, "Help").id
    script = [{ tool_calls: [{ name: "create_flashcards", args: { topic_id: "nope", cards: [] } }] }, { tool_calls: [{ name: "create_flashcards", args: { topic_id: "security", cards: [{ front: "KMS?", back: "Keys" }] } }] }, { content: "Added one card." }]
    await runChat(labId, thread, "Add a card about keys", job())
    const msgs = repo.listMessages(thread)
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"])
    assert.equal(msgs[1].content, "Added one card.")
    assert.deepEqual(msgs[1].tools!.map((t) => t.ok), [false, true])
    assert.match(requests[1].messages.at(-1)!.content!, /Valid topic ids/)

    script = [{ content: "You asked about keys." }]
    await runChat(labId, thread, "What did I ask?", job())
    const sent = requests.at(-1)!.messages
    const roles = sent.map((m) => m.role)
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"])
    const calls = sent.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls as { id: string }[]).map((c) => c.id)
    assert.deepEqual(sent.filter((m) => m.role === "tool").map((m) => m.tool_call_id), calls)
  })

  it("fails clearly without a key", async () => {
    saveKey(null)
    await assert.rejects(runAnalyze(labId, job()), /OpenRouter API key/)
    await saveKey("sk-or-test")
  })
})

describe("harness: skills and external MCP connections", () => {
  it("lists built-in skills, lets you add your own, and shows them to the model", async () => {
    const { listSkills, saveSkill, deleteSkill } = await import("../src/main/harness/skills")
    const names = listSkills().map((s) => s.name)
    for (const n of ["learning-diagnosis", "study-planning", "question-writing"]) assert.ok(names.includes(n), n)
    const mine = saveSkill({ name: "Exam Day Tips", description: "Use the night before the exam.", body: "# Tips\nSleep." })
    assert.equal(mine.name, "exam-day-tips")
    assert.ok(listSkills().some((s) => s.name === "exam-day-tips" && !s.builtin))
    const thread = repo.createThread(labId, "skills").id
    script = [{ content: "ok" }]
    await runChat(labId, thread, "hi", job())
    const system = JSON.stringify(requests[0].messages[0].content)
    assert.match(system, /learning-diagnosis/)
    assert.match(system, /exam-day-tips/)
    deleteSkill("exam-day-tips")
    assert.ok(!listSkills().some((s) => s.name === "exam-day-tips"))
  })

  it("connects to an external MCP server and exposes its tools with a prefix", async () => {
    const { setSetting } = await import("../src/main/db")
    const { applyMcp, stopMcp, mcpConfig } = await import("../src/main/mcp")
    const { saveConnection, loadConnectionTools, testConnection } = await import("../src/main/harness/connections")
    // Our own MCP server stands in for an external one.
    setSetting("mcp", { enabled: true, port: 19765 + Math.floor(Math.random() * 500), token: "tok" })
    globalThis.fetch = realFetch
    await applyMcp()
    const c = saveConnection({ name: "Other Lab", transport: "http", url: `http://127.0.0.1:${mcpConfig().port}/mcp/${labId}`, headers: { Authorization: "Bearer tok" }, enabled: true, labs: "all" })
    assert.equal(c.name, "other-lab")
    const t = await testConnection(c.id)
    assert.ok(t.ok, t.error)
    const loaded = await loadConnectionTools(labId)
    assert.ok(loaded.tools.some((x) => x.name === "other-lab_get_overview"), loaded.tools.map((x) => x.name).join(","))
    await loaded.close()
    await stopMcp()
  })
})
