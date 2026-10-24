import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeDb, openDb, setSetting } from "../src/main/db"
import * as repo from "../src/main/repo"
import { importUdemy } from "../src/main/importers"
import { undo } from "../src/main/journal"
import { runTool, type ToolContext } from "../src/main/tools"
import { applyMcp, stopMcp } from "../src/main/mcp"
import { detectUdemyFile, parseLecturesMd, parseQuestionsMd } from "../src/shared/udemy"
import type { StudyEvent } from "../src/shared/types"

const fixtures = join(import.meta.dirname, "fixtures")
const dir = mkdtempSync(join(tmpdir(), "study-lab-test-"))

before(() => {
  openDb(join(dir, "test.db"))
})

after(async () => {
  await stopMcp()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe("Udemy Markdown parser", () => {
  it("reads quizzes, practice tests, multi-answer keys and rationales", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(join(fixtures, "sample-simulados.md"), "utf8")
    assert.equal(detectUdemyFile(text), "questions")
    const { course, questions, warnings } = parseQuestionsMd(text)
    assert.equal(course, "Sample Cloud Course")
    assert.equal(questions.length, 3)
    assert.deepEqual(warnings, [])
    const [q1, q2, q3] = questions
    assert.deepEqual(q1.ans, [1])
    assert.equal(q1.why[1], "Object storage is durable and shared by many readers.")
    assert.equal(q2.multi, true)
    assert.deepEqual(q2.ans, [0, 2])
    assert.equal(q2.explanation, "Combine least privilege with temporary credentials.")
    assert.equal(q3.kind, "exam")
    assert.equal(q3.set, "Final Practice Exam")
    assert.notEqual(q1.id, q3.id)
  })

  it("reads lectures and drops missing transcripts", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(join(fixtures, "sample-transcricoes.md"), "utf8")
    assert.equal(detectUdemyFile(text), "lectures")
    const { lectures } = parseLecturesMd(text)
    assert.equal(lectures.length, 4)
    assert.equal(lectures[1].p.length, 0)
    assert.equal(lectures[2].sec, "2. Storage")
    assert.equal(lectures[2].p.length, 2)
  })
})

describe("labs, analytics and coach tools", () => {
  let labId = ""
  const ctx = (): ToolContext => ({ labId, actor: "test-model", notify: () => undefined })

  it("creates a lab and imports a Udemy export", async () => {
    labId = repo.createLab({ name: "Cloud", preset: "certification" }).id
    const r = await importUdemy(labId, [join(fixtures, "sample-simulados.md"), join(fixtures, "sample-transcricoes.md")])
    assert.equal(r.questions, 3)
    assert.equal(r.lectures, 4)
    const lab = repo.getLab(labId)
    assert.equal(lab.counts.questions, 3)
    assert.equal(lab.config.sources.course, "Sample Cloud Course")
    // Re-import updates in place.
    await importUdemy(labId, [join(fixtures, "sample-simulados.md")])
    assert.equal(repo.getLab(labId).counts.questions, 3)
    assert.equal(repo.searchLectures(labId, "durable buckets")[0]?.n, 3)
  })

  it("organises topics, tags questions and writes material through tools", () => {
    const t = runTool(ctx(), "upsert_topic", { title: "Object storage", domain: 1, covers: "Buckets and objects", confusable: ["encryption"] })
    assert.ok(t.ok, JSON.stringify(t.result))
    const t2 = runTool(ctx(), "upsert_topic", { id: "encryption", title: "Encryption", domain: 1 })
    assert.ok(t2.ok)
    const qs = repo.readContent(labId).questions
    const tag = runTool(ctx(), "tag_questions", { assignments: qs.map((q, i) => ({ qid: q.id, topics: i === 2 ? ["encryption"] : ["object-storage", "encryption"] })) })
    assert.equal((tag.result as { tagged: number }).tagged, 3)

    const cards = runTool(ctx(), "create_flashcards", { topic_id: "object-storage", cards: [{ front: "What is a bucket?", back: "A container for objects.", kind: "concept" }, { front: "", back: "skipped" }] })
    assert.equal((cards.result as { created: number }).created, 1)

    const bad = runTool(ctx(), "create_flashcards", { topic_id: "nope", cards: [] })
    assert.equal(bad.ok, false)
    assert.match(JSON.stringify(bad.result), /Valid topic ids/)

    const q = runTool(ctx(), "create_questions", {
      topic_id: "encryption",
      questions: [
        { stem: "What protects stolen snapshots?", options: ["A) Encryption at rest", "B) Bigger disks", "C) A CDN"], answer: [0], rationales: ["A: Right.", "Wrong.", "Wrong."] },
        { stem: "Broken", options: ["only one"], answer: [0], rationales: [] },
      ],
    })
    const qr = q.result as { created: number; skipped: string[]; ids: string[] }
    assert.equal(qr.created, 1)
    assert.equal(qr.skipped.length, 1)
    const made = repo.getQuestion(labId, qr.ids[0])!
    assert.deepEqual(made.opts, ["Encryption at rest", "Bigger disks", "A CDN"])
    assert.equal(made.why[0], "Right.")
    assert.equal(made.src, "agent")

    const g = runTool(ctx(), "write_study_guide", { topic_id: "encryption", title: "At rest vs in transit", markdown: "# Guide\n\n| a | b |\n|---|---|\n| x | y |" })
    assert.ok(g.ok)
    assert.equal(repo.getTopic(labId, "encryption")!.guides!.length, 1)
  })

  it("computes analytics from the event log", () => {
    const qs = repo.readContent(labId).questions
    const [q1, q2] = qs
    const now = Date.now()
    const ev = (over: Partial<StudyEvent>): StudyEvent => ({ at: now, kind: "q", item: q1.id, mode: "practice", correct: 0, grade: 1, conf: 2, picks: [0], ms: 20000, ...over })
    repo.addEvents(labId, [
      ev({ at: now - 9 * 86400000, item: q2.id, correct: 1, grade: 3, picks: [0, 2] }),
      ev({ at: now - 2 * 86400000, item: q2.id, correct: 0, picks: [1, 2] }),
      ev({ at: now - 3000, picks: [0] }),
      ev({ at: now - 2000, picks: [0], ms: 900 }),
      ev({ at: now - 1000, picks: [2], changes: 1, first: [1], correct: 0 }),
    ])
    repo.saveState(labId, "srsq", { set: { [q1.id]: { d: 0, i: 0, e: 250, r: 0, l: 0, s: 3, t: 0, c: 0, w: 3, f: 0, h: 3, la: 0, cf: 2 } } })
    const s = repo.snapshot(labId)
    assert.equal(s.overview.attempts, 5)
    const rep = s.repeated.find((r) => r.qid === q1.id)!
    assert.equal(rep.wrong, 3)
    assert.equal(rep.samePick, true)
    assert.equal(s.forgotten[0]?.qid, q2.id)
    assert.equal(s.time.rapid, 1)
    assert.equal(s.changes.changed, 1)
    assert.equal(s.calibration[2].n, 5)
    const os = s.topics.find((t) => t.id === "object-storage")!
    assert.equal(os.attempts, 5)
    assert.ok(os.mastery < 0.5)
    assert.ok(s.confusions.some((c) => c.a === "encryption" && c.b === "object-storage"))
    const overview = runTool(ctx(), "get_overview", {})
    assert.ok(overview.ok)
    const mistakes = runTool(ctx(), "list_mistakes", { limit: 5 }).result as { picked: string[]; timesWrong: number }[]
    assert.equal(mistakes[0].timesWrong, 3)
  })

  it("journals every write and undoes it", () => {
    const before = repo.readContent(labId).kb.cards.length
    const r = runTool(ctx(), "create_flashcards", { topic_id: "encryption", cards: [{ front: "F1", back: "B1" }, { front: "F2", back: "B2" }] })
    const change = (r.result as { change: number }).change
    assert.equal(repo.readContent(labId).kb.cards.length, before + 2)
    assert.ok(undo(labId, change).ok)
    assert.equal(repo.readContent(labId).kb.cards.length, before)
    assert.equal(undo(labId, change).ok, false)

    const q = repo.readContent(labId).questions[0]
    const st = runTool(ctx(), "set_item_status", { kind: "q", ids: [q.id], status: "archived", reason: "learned" })
    assert.equal(repo.getQuestion(labId, q.id)!.status, "archived")
    undo(labId, (st.result as { change: number }).change)
    assert.equal(repo.getQuestion(labId, q.id)!.status, "active")

    const merge = runTool(ctx(), "merge_topics", { from: "encryption", into: "object-storage" })
    assert.ok(merge.ok, JSON.stringify(merge.result))
    assert.equal(repo.getTopic(labId, "encryption"), null)
    undo(labId, (merge.result as { change: number }).change)
    assert.ok(repo.getTopic(labId, "encryption"))
    assert.ok((repo.getTags(labId)[q.id] ?? []).includes("encryption"))
  })

  it("saves a plan, focus topics, collections and settings", () => {
    const qs = repo.readContent(labId).questions
    const plan = runTool(ctx(), "save_study_plan", {
      title: "Week 1",
      goal: "Fix storage",
      rationale: "Repeated errors in object storage",
      days: [{ focus: "Storage", tasks: [{ type: "practice", title: "Drill", topics: ["object-storage", "ghost"], minutes: 20, count: 10 }] }, { focus: "Rest", tasks: [] }],
    })
    assert.ok(plan.ok, JSON.stringify(plan.result))
    const p = repo.activePlan(labId)!
    assert.equal(p.days.length, 2)
    assert.deepEqual(p.days[0].tasks[0].topics, ["object-storage"])
    runTool(ctx(), "save_study_plan", { title: "Week 2", goal: "g", rationale: "r", days: [{ focus: "x", tasks: [] }] })
    assert.equal(repo.activePlan(labId)!.title, "Week 2")
    assert.equal(repo.listPlans(labId).filter((x) => x.status === "active").length, 1)

    assert.ok(runTool(ctx(), "set_focus", { topics: ["object-storage", "nope"] }).ok)
    assert.deepEqual(repo.getConfig(labId).focus, ["object-storage"])
    const col = runTool(ctx(), "create_collection", { name: "Misses", question_ids: [qs[0].id, "missing"] })
    assert.equal((col.result as { items: number }).items, 1)
    const set = runTool(ctx(), "update_study_settings", { exam_date: "2026-12-01", new_questions_per_day: 25, reason: "exam booked" })
    assert.ok(set.ok)
    assert.equal(repo.readMeta(labId).settings.examDate, "2026-12-01")
    undo(labId, (set.result as { change: number }).change)
    assert.equal(repo.readMeta(labId).settings.examDate, null)
    assert.ok(runTool(ctx(), "remember", { note: "Studies at night" }).ok)
    assert.match(repo.getConfig(labId).memory, /Studies at night/)
  })

  it("serves the same tools over MCP with a bearer token", async () => {
    setSetting("mcp", { enabled: true, port: 18765 + Math.floor(Math.random() * 1000), token: "test-token" })
    await applyMcp()
    const { mcpConfig, mcpStatus } = await import("../src/main/mcp")
    assert.ok(mcpStatus().running, mcpStatus().error)
    const url = `http://127.0.0.1:${mcpConfig().port}/mcp/${labId}`
    const call = async (body: unknown, token = "test-token") => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      const data = text.split("\n").find((l) => l.startsWith("data: "))
      return { status: res.status, json: JSON.parse(data ? data.slice(6) : text) }
    }
    assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status, 401)
    const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    assert.equal(init.json.result.serverInfo.name, "study-lab")
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = list.json.result.tools.map((t: { name: string }) => t.name)
    assert.ok(names.includes("get_overview") && names.includes("create_questions"))
    const res = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_topics", arguments: {} } })
    const topics = JSON.parse(res.json.result.content[0].text)
    assert.ok(topics.some((t: { id: string }) => t.id === "object-storage"))
    const w = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_flashcards", arguments: { topic_id: "object-storage", cards: [{ front: "via mcp", back: "ok" }] } } })
    assert.equal(w.json.result.isError, false)
    assert.ok(repo.listChanges(labId)[0].actor.startsWith("mcp:"))
  })
})
