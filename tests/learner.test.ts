import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { retrievability, scheduleFsrs } from "../src/shared/fsrs"
import { bktUpdate, learnerModel } from "../src/shared/learner"
import { computePlan } from "../src/shared/planner"
import type { KnowledgeGraph, QRec, Question, StudyEvent, Topic } from "../src/shared/types"

const DAY = 86_400_000
const NOW = new Date(2026, 9, 24, 12).getTime()

describe("FSRS item memory", () => {
  it("never repeats a question the same day and grows the interval on success", () => {
    const again = scheduleFsrs(undefined, 1, "q", null, false, NOW)
    assert.ok(again.d * 60_000 - NOW >= 0.9 * DAY, "a missed question comes back tomorrow at the earliest")
    const good1 = scheduleFsrs(undefined, 3, "q", null, false, NOW)
    const good2 = scheduleFsrs(good1, 3, "q", null, false, good1.d * 60_000)
    assert.ok(good2.i > good1.i)
    assert.ok(good2.fs && good2.fs.s > good1.fs!.s)
  })

  it("lets flashcards relearn within minutes", () => {
    const again = scheduleFsrs(undefined, 1, "c", null, false, NOW)
    assert.ok(again.d * 60_000 - NOW < 60 * 60_000)
  })

  it("caps intervals at the exam date and converts SM-2 records", () => {
    const legacy = { d: Math.floor(NOW / 60_000), i: 20, e: 250, r: 4, l: 0, s: 4, t: Math.floor((NOW - 20 * DAY) / 60_000) }
    const next = scheduleFsrs(legacy, 4, "q", 10, false, NOW)
    assert.ok(next.i <= 10.01)
    assert.ok(next.fs)
  })

  it("forgets along the curve: recall is 90% after one stability period", () => {
    const rec = scheduleFsrs(undefined, 3, "q", null, false, NOW)
    const s = rec.fs!.s
    const r = retrievability(rec, NOW + s * DAY)!
    assert.ok(Math.abs(r - 0.9) < 0.02, String(r))
    assert.ok(retrievability(rec, NOW + 3 * s * DAY)! < r)
  })
})

/* ---------- a small synthetic lab: A is a prerequisite of B; B and C get confused ---------- */

const topics: Topic[] = ["t1", "t2"].map((id, i) => ({
  id,
  d: i + 1,
  title: id,
  covers: "",
  summary: [],
  lec: { keyPoints: [], examTips: [], pitfalls: [] },
  exam: { keyPoints: [], examTips: [], pitfalls: [] },
  mnemonics: [],
  tables: [],
  lectures: [],
}))

const q = (id: string, nOpts = 4): Question => ({
  id,
  src: "s",
  src_name: "S",
  set: "set",
  kind: "quiz",
  n: 1,
  d: 1,
  stem: "word ".repeat(40),
  opts: Array.from({ length: nOpts }, (_, i) => `option ${i}`),
  ans: [0],
  why: [],
  explanation: "",
  multi: false,
})

const questions = ["qa1", "qa2", "qa3", "qb1", "qb2", "qb3", "qc1", "qc2", "qc3"].map((id) => q(id))
const graph: KnowledgeGraph = {
  kcs: [
    { id: "A", topic: "t1", name: "A", definition: "", kind: "concept", status: "active", evidence: [] },
    { id: "B", topic: "t2", name: "B", definition: "", kind: "concept", status: "active", evidence: [] },
    { id: "C", topic: "t2", name: "C", definition: "", kind: "concept", status: "active", evidence: [] },
  ],
  edges: [
    { src: "A", dst: "B", type: "prerequisite", weight: 1, method: "test", evidence: "", status: "accepted" },
    { src: "B", dst: "C", type: "confusable", weight: 1, method: "test", evidence: "", status: "accepted" },
  ],
  itemKc: Object.fromEntries(questions.map((x) => [x.id, [{ kc: x.id[1].toUpperCase(), role: "primary" as const }]])),
  optionKc: { qb1: { 1: "C" }, qb2: { 2: "C" } },
  topicLevel: false,
}

const ev = (item: string, at: number, correct: 0 | 1, picks: number[], extra: Partial<StudyEvent> = {}): StudyEvent => ({ at, kind: "q", item, mode: "practice", correct, grade: correct ? 3 : 1, conf: 2, picks, ms: 30_000, ...extra })

const events: StudyEvent[] = [
  // A: solid
  ev("qa1", NOW - 6 * DAY, 1, [0]),
  ev("qa2", NOW - 5 * DAY, 1, [0]),
  ev("qa3", NOW - 4 * DAY, 1, [0]),
  // B: confused with C (the wrong options describe C), then the same wrong option again on qb3
  ev("qb1", NOW - 3 * DAY, 0, [1]),
  ev("qb3", NOW - 3 * DAY + 1000, 0, [3]),
  ev("qb3", NOW - 2 * DAY, 0, [3]),
  ev("qb2", NOW - 1 * DAY, 0, [2]),
  // C: one rapid guess (no evidence) and one right answer
  ev("qc1", NOW - 1 * DAY, 1, [0], { ms: 900 }),
  ev("qc2", NOW - 1 * DAY + 5000, 1, [0], { conf: 1 }),
]

const srsq: Record<string, QRec> = {}
for (const e of events) srsq[e.item] = { ...scheduleFsrs(srsq[e.item], e.correct ? 3 : 1, "q", null, false, e.at), c: 0, w: 0, f: e.correct, h: 0, la: e.correct, cf: 2 }

const domains = [
  { n: 1, name: "One", short: "One", w: 50 },
  { n: 2, name: "Two", short: "Two", w: 50 },
]
const exam = { code: "X", questions: 20, scored: 20, minutes: 30, pass: 700, min: 100, max: 1000 }
const examDate = new Date(NOW + 20 * DAY).toISOString().slice(0, 10)

describe("learner model", () => {
  it("treats a right answer as weaker evidence when guessing is easier", () => {
    assert.ok(bktUpdate(0.3, true, 1 / 6) > bktUpdate(0.3, true, 1 / 3))
    assert.ok(bktUpdate(0.3, false, 0.25) < 0.3 + 0.12)
  })

  const m = learnerModel({ questions, topics, domains, exam, graph, srsq, events, examDate, now: NOW })

  it("ranks mastery, keeps uncertainty, and ignores rapid guesses", () => {
    const [A, B, C] = ["A", "B", "C"].map((k) => m.byId.get(k)!)
    assert.ok(A.mastery > 0.7, `A ${A.mastery}`)
    assert.ok(B.mastery < 0.3, `B ${B.mastery}`)
    assert.equal(C.attempts, 2)
    assert.ok(C.n <= 1, "the rapid guess carried no evidence")
    assert.ok(B.sd > 0 && B.sd < 0.3)
  })

  it("types errors: confusion via distractor concepts, misconception on a repeated wrong option", () => {
    const B = m.byId.get("B")!
    assert.equal(B.errors.confusion, 2)
    assert.equal(B.errors.misconception, 1)
    assert.deepEqual(
      B.misconceptions.map((x) => [x.qid, x.option, x.count]),
      [["qb3", 3, 2]],
    )
    assert.equal(B.pendingRetest, true)
  })

  it("derives readiness from prerequisites and predicts an exam score with an interval", () => {
    assert.equal(m.byId.get("B")!.readiness, m.byId.get("A")!.mastery)
    assert.ok(m.predicted)
    assert.ok(m.predicted!.low <= m.predicted!.score && m.predicted!.score <= m.predicted!.high)
    assert.ok(m.calibration.brier! > 0 && m.calibration.bias! > 0, "confident and often wrong = overconfident")
  })
})

describe("deterministic planner", () => {
  const model = learnerModel({ questions, topics, domains, exam, graph, srsq, events, examDate, now: NOW })
  const plan = computePlan({
    model,
    graph,
    questions,
    cards: [],
    domains,
    exam,
    examDate,
    minutesPerDay: 40,
    srsq,
    srsc: {},
    exams: [],
    secPerQuestion: 60,
    secPerCard: 15,
    days: 7,
    now: NOW,
  })

  it("puts the misconception concept first and practises it with its confusable partner", () => {
    assert.equal(plan.priorities[0].kc, "B")
    assert.equal(plan.priorities[0].reason, "misconception")
    // Day 1 is the baseline mock; the first remediation of B comes after it, with C alongside.
    const first = plan.days.flatMap((d) => d.tasks).find((t) => t.type === "practice" && !["retest", "interleaved"].includes(t.reason ?? "") && t.kcs?.includes("B"))
    assert.ok(first, JSON.stringify(plan.days.map((d) => d.tasks)))
    assert.deepEqual(first!.kcs, ["B", "C"])
  })

  it("starts with a baseline mock, schedules retests 1–3 days later and respects spacing", () => {
    assert.ok(plan.days[0].tasks.some((t) => t.reason === "mock"))
    assert.ok(plan.days.slice(1, 4).some((d) => d.tasks.some((t) => t.reason === "retest")))
    const dates = plan.days.filter((d) => d.tasks.some((t) => !["retest", "interleaved"].includes(t.reason ?? "") && t.kcs?.includes("B"))).map((d) => new Date(d.date).getTime())
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i] - dates[i - 1] >= 2 * DAY, `B practised on ${dates.map((x) => new Date(x).toISOString().slice(0, 10))}`)
    // No idle day: when spacing blocks every concept, mixed practice fills the slot.
    for (const d of plan.days.slice(1)) assert.ok(d.tasks.length > 0)
    assert.equal(plan.days.length, 7)
  })

  it("keeps non-mock days within the time budget", () => {
    for (const d of plan.days) {
      if (d.tasks.some((t) => t.type === "exam")) continue
      const total = d.tasks.reduce((a, t) => a + t.minutes, 0)
      assert.ok(total <= 40 + 5, `${d.date}: ${total} min`)
    }
  })
})
