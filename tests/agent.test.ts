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

function job(): JobHandle {
  return { id: "j", signal: new AbortController().signal, step: () => undefined, addUsage: () => undefined }
}

before(async () => {
  openDb(join(dir, "agent.db"))
  saveKey("sk-or-test")
  labId = repo.createLab({ name: "Cloud", preset: "certification" }).id
  await importUdemy(labId, [join(fixtures, "sample-simulados.md"), join(fixtures, "sample-transcricoes.md")])
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return new Response(JSON.stringify({ data: [{ id: DEFAULT_MODEL, name: "DeepSeek", context_length: 1e6, pricing: { prompt: "0.00000015", completion: "0.0000006" }, supported_parameters: ["tools", "response_format"] }] }))
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    const next = script.shift()
    if (!next) throw new Error("The script ran out of replies")
    let n = 0
    const message = {
      content: next.content ?? null,
      tool_calls: next.tool_calls?.map((t) => ({ id: `call_${requests.length}_${n++}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })),
    }
    return new Response(JSON.stringify({ model: body.model, choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 } }))
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
})

describe("knowledge base builder", () => {
  it("outlines topics, writes notes and cards, and tags questions", async () => {
    const qs = repo.readContent(labId).questions
    script = [
      {
        content: JSON.stringify({
          domains: [
            { n: 1, name: "Storage", short: "Storage", w: 60 },
            { n: 2, name: "Security", short: "Security", w: 40 },
          ],
          topics: [
            { id: "object-storage", title: "Object storage", domain: 1, covers: "Buckets", lectures: [3] },
            { id: "encryption", title: "Encryption", domain: 2, covers: "At rest", lectures: [4, 999] },
          ],
        }),
      },
      { content: '```json\n{"summary":["S"],"keyPoints":["Objects live in buckets"],"examTips":[],"pitfalls":[],"mnemonics":[],"confusable":["encryption"],"cards":[{"front":"Bucket?","back":"Container","kind":"concept"}]}\n```' },
      { content: JSON.stringify({ summary: ["E"], keyPoints: ["At rest protects disks"], examTips: [], pitfalls: [], mnemonics: [], confusable: [], cards: [{ front: "At rest?", back: "Disks", kind: "fact" }] }) },
      { content: JSON.stringify({ assignments: [{ qid: qs[0].id, topics: ["object-storage"] }, { qid: qs[1].id, topics: ["encryption", "bogus"] }, { qid: qs[2].id, topics: ["encryption"] }] }) },
    ]
    await runBuildKb(labId, job(), { cardsPerTopic: 3 })
    const c = repo.readContent(labId)
    assert.equal(c.kb.topics.length, 2)
    assert.deepEqual(repo.getConfig(labId).domains.map((d) => d.name), ["Storage", "Security"])
    assert.deepEqual(c.kb.topics.find((t) => t.id === "encryption")!.lectures, [4])
    assert.equal(c.kb.cards.length, 2)
    assert.deepEqual(c.kb.tags[qs[1].id], ["encryption"])
    assert.equal(c.questions.find((q) => q.id === qs[2].id)!.d, 2)
    assert.equal(requests.length, 4)
    assert.ok(requests[0].response_format, "outline asks for structured output")
    assert.match(repo.listChanges(labId)[0].summary, /Built the knowledge base/)
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
      { tool_calls: [{ name: "set_focus", args: { topics: ["object-storage"] } }] },
      {
        tool_calls: [
          {
            name: "save_study_plan",
            args: { title: "Fix storage", goal: "Stop the repeated miss", rationale: "From the report", days: [{ focus: "Storage", tasks: [{ type: "practice", title: "Drill", topics: ["object-storage"], minutes: 20 }] }] },
          },
        ],
      },
      { content: "Plan saved: one day." },
    ]
    await runPlan(labId, job(), { days: 1, minutesPerDay: 30 })
    assert.equal(repo.activePlan(labId)!.title, "Fix storage")
    assert.deepEqual(repo.getConfig(labId).focus, ["object-storage"])
    assert.match(requests[0].messages[1].content!, /Latest analysis/)
  })

  it("chats, keeps tool history valid across turns, and reports tool errors to the model", async () => {
    const thread = repo.createThread(labId, "Help").id
    script = [{ tool_calls: [{ name: "create_flashcards", args: { topic_id: "nope", cards: [] } }] }, { tool_calls: [{ name: "create_flashcards", args: { topic_id: "encryption", cards: [{ front: "KMS?", back: "Keys" }] } }] }, { content: "Added one card." }]
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
    saveKey("sk-or-test")
  })
})
