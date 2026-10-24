import { dayKey } from "@shared/analytics"
import type { Card, CardKind, Collection, EdgeType, ItemStatus, PlanDay, PlanTask, PlanTaskType, Question, StudyPlan, Topic } from "@shared/types"
import * as graph from "./graph"
import { labLearner, labPlan } from "./learner"
import { all, tx } from "./db"
import { Change } from "./journal"
import * as repo from "./repo"

/*
  The coach's hands. One registry serves the in-app agent (OpenRouter function calling) and the
  local MCP server, so any MCP client sees exactly the same abilities. Read tools are free; write
  tools go through a journaled Change so each one can be undone from the Coach → Activity tab.
*/

export type Touched = "content" | "config" | "plans" | "insights" | "state"

export interface ToolContext {
  labId: string
  actor: string
  notify(what: Touched[]): void
}

export interface Tool {
  name: string
  description: string
  schema: Record<string, unknown>
  write: boolean
  run(ctx: ToolContext, args: Record<string, unknown>): unknown
}

/* ---------- helpers ---------- */

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "")
const strs = (v: unknown, max = 50) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : [])
const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const shortId = () => Math.random().toString(36).slice(2, 8)
const LETTERS = "ABCDEFGH"

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || `topic-${shortId()}`
  )
}

function requireTopic(labId: string, id: unknown): Topic {
  const t = repo.getTopic(labId, str(id, 80))
  if (!t) {
    const ids = all<{ id: string }>("SELECT id FROM topics WHERE lab_id = ? ORDER BY ord", labId).map((r) => r.id)
    throw new Error(`Unknown topic "${String(id)}". Valid topic ids: ${ids.join(", ") || "(none yet — create one with upsert_topic)"}`)
  }
  return t
}

function questionView(q: Question, withWhy = true) {
  return {
    id: q.id,
    set: q.set,
    domain: q.d,
    status: q.status ?? "active",
    stem: q.stem,
    options: q.opts.map((o, i) => `${LETTERS[i]}) ${o}`),
    answer: q.ans.map((i) => LETTERS[i]).join(", "),
    ...(withWhy ? { rationales: q.why.map((w, i) => (w ? `${LETTERS[i]}: ${w}` : "")).filter(Boolean), explanation: q.explanation || undefined } : {}),
  }
}

const letters = (picks: number[] | undefined) => (picks ?? []).map((i) => LETTERS[i] ?? "?").join(", ") || "(blank)"

function content(labId: string) {
  return repo.readContent(labId)
}

function changed(ctx: ToolContext, ch: Change, summary: string) {
  const id = ch.commit(summary)
  ctx.notify([...ch.touched])
  return id
}

/* ---------- read tools ---------- */

const readTools: Tool[] = [
  {
    name: "get_lab",
    description: "The lab's setup: name, kind, exam format, domains and weights, study settings, memory notes, pinned focus topics and custom collections.",
    schema: { type: "object", properties: {} },
    write: false,
    run(ctx) {
      const lab = repo.getLab(ctx.labId)
      const meta = repo.readMeta(ctx.labId)
      return {
        name: lab.name,
        kind: lab.kind,
        description: lab.description,
        exam: lab.config.exam,
        domains: lab.config.domains,
        counts: lab.counts,
        settings: meta.settings,
        memory: lab.config.memory,
        focus: lab.config.focus,
        collections: lab.config.collections.map((c) => ({ id: c.id, name: c.name, why: c.why, items: c.items.length })),
        today: dayKey(),
      }
    },
  },
  {
    name: "get_overview",
    description:
      "Learner analytics for the whole lab: totals, first-try and recent accuracy, time per answer vs exam pace, rapid guesses, calibration by confidence, answer changes, domain accuracy, topics needing work, repeated errors, confusable topic pairs, forgotten items and mistake reasons.",
    schema: { type: "object", properties: {} },
    write: false,
    run(ctx) {
      const s = repo.snapshot(ctx.labId)
      const weak = [...s.topics]
        .filter((t) => t.state !== "new")
        .sort((a, b) => a.mastery - b.mastery)
        .slice(0, 8)
        .map((t) => ({ id: t.id, title: t.title, state: t.state, mastery: t.mastery, attempts: t.attempts, accuracy: t.accuracy, trend: t.trend }))
      const untouched = s.topics.filter((t) => t.state === "new").map((t) => t.id)
      return {
        overview: s.overview,
        time: s.time,
        calibration: s.calibration,
        answerChanges: s.changes,
        domains: s.domains,
        weakestTopics: weak,
        notStartedTopics: untouched,
        topicStates: countStates(s.topics.map((t) => t.state)),
        repeatedErrors: s.repeated.slice(0, 10),
        confusions: s.confusions.slice(0, 8),
        forgotten: s.forgotten.slice(0, 10),
        mistakeReasons: s.reasons,
        accuracyByHour: s.byHour,
        learnerModel: modelSummary(ctx.labId),
      }
    },
  },
  {
    name: "get_graph",
    description:
      "The knowledge graph: knowledge components (concepts) with topic, mastery +- uncertainty, readiness, items and error types, plus prerequisite / confusable / related edges. Filter by topic to keep it small.",
    schema: { type: "object", properties: { topic_id: { type: "string" }, edge_types: { type: "array", items: { type: "string", enum: ["prerequisite", "confusable", "related", "example_of"] } } } },
    write: false,
    run(ctx, a) {
      const g = graph.readGraph(ctx.labId)
      const m = labLearner(ctx.labId)
      const topic = str(a.topic_id, 80)
      const kcs = g.kcs.filter((k) => !topic || k.topic === topic)
      const ids = new Set(kcs.map((k) => k.id))
      const types = strs(a.edge_types, 4)
      return {
        topicLevel: g.topicLevel,
        concepts: kcs.slice(0, 250).map((k) => {
          const st = m.byId.get(k.id)
          return {
            id: k.id,
            name: k.name,
            topic: k.topic,
            definition: clip(k.definition, 160),
            mastery: st ? Math.round(st.mastery * 100) / 100 : null,
            sd: st ? Math.round(st.sd * 100) / 100 : null,
            readiness: st ? Math.round(st.readiness * 100) / 100 : null,
            items: st?.items ?? 0,
            errors: st?.errors,
          }
        }),
        edges: g.edges.filter((e) => (ids.has(e.src) || ids.has(e.dst)) && (!types.length || types.includes(e.type))).slice(0, 400),
      }
    },
  },
  {
    name: "compute_plan",
    description:
      "Run the deterministic planner: per day, FSRS reviews, exam-day protection, retests of confident errors, mock exams and remediation of the highest-priority concepts within the daily minutes. Returns days of tasks with reason codes and the concept priorities. Use it before save_study_plan.",
    schema: { type: "object", properties: { days: { type: "number" }, minutes_per_day: { type: "number" } } },
    write: false,
    run(ctx, a) {
      const p = labPlan(ctx.labId, { days: num(a.days, 7, 1, 30), minutesPerDay: a.minutes_per_day != null ? num(a.minutes_per_day, 45, 10, 480) : undefined })
      return { start: p.start, days: p.days, priorities: p.priorities.slice(0, 15), notes: p.notes }
    },
  },
  {
    name: "list_topics",
    description: "Every topic with its domain, learning state (new/weak/learning/solid/mastered), mastery 0–1, attempts, accuracy and how many items it has.",
    schema: { type: "object", properties: {} },
    write: false,
    run(ctx) {
      return repo.snapshot(ctx.labId).topics.map((t) => ({
        id: t.id,
        title: t.title,
        domain: t.d,
        state: t.state,
        mastery: t.mastery,
        attempts: t.attempts,
        accuracy: t.accuracy,
        questions: t.questions,
        cards: t.cards,
        learned: t.learned,
      }))
    },
  },
  {
    name: "get_topic_report",
    description: "Deep dive on one topic: stats, learning curve, its notes (key points, exam tips, pitfalls), coach guides, related topics and the learner's recent wrong answers in it.",
    schema: { type: "object", properties: { topic_id: { type: "string" } }, required: ["topic_id"] },
    write: false,
    run(ctx, a) {
      const t = requireTopic(ctx.labId, a.topic_id)
      const s = repo.snapshot(ctx.labId)
      const stats = s.topics.find((x) => x.id === t.id)
      return {
        topic: { id: t.id, title: t.title, domain: t.d, covers: t.covers, summary: t.summary, prereq: t.prereq, confusable: t.confusable },
        stats,
        notes: { keyPoints: [...t.lec.keyPoints, ...t.exam.keyPoints].slice(0, 25), examTips: [...t.lec.examTips, ...t.exam.examTips].slice(0, 15), pitfalls: [...t.lec.pitfalls, ...t.exam.pitfalls].slice(0, 15) },
        guides: (t.guides ?? []).map((g) => ({ id: g.id, title: g.title, at: new Date(g.at).toISOString() })),
        lectures: t.lectures,
        recentMistakes: mistakes(ctx.labId, t.id, 8),
      }
    },
  },
  {
    name: "list_mistakes",
    description: "The learner's recent wrong answers with the question, what they picked, the right answer, their confidence, time taken and how often they missed it. Filter by topic.",
    schema: { type: "object", properties: { topic_id: { type: "string" }, limit: { type: "number", description: "default 12, max 40" } } },
    write: false,
    run(ctx, a) {
      return mistakes(ctx.labId, a.topic_id ? requireTopic(ctx.labId, a.topic_id).id : undefined, num(a.limit, 12, 1, 40))
    },
  },
  {
    name: "get_question",
    description: "One question in full, with rationales for every option and the learner's attempt history.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    write: false,
    run(ctx, a) {
      const q = repo.getQuestion(ctx.labId, str(a.id, 120))
      if (!q) throw new Error(`No question with id ${String(a.id)}`)
      const history = repo
        .readEvents(ctx.labId)
        .filter((e) => e.item === q.id)
        .map((e) => ({ at: new Date(e.at).toISOString(), correct: !!e.correct, picked: letters(e.picks), sec: Math.round(e.ms / 1000), conf: e.conf, mode: e.mode }))
      return { ...questionView(q), topics: repo.getTags(ctx.labId)[q.id] ?? [], history }
    },
  },
  {
    name: "search_content",
    description: "Search the lab's lecture transcripts (full text), questions and flashcards. Use it to ground new study material in the course content.",
    schema: {
      type: "object",
      properties: { query: { type: "string" }, kind: { type: "string", enum: ["lectures", "questions", "cards", "all"] }, limit: { type: "number" } },
      required: ["query"],
    },
    write: false,
    run(ctx, a) {
      const query = str(a.query, 300)
      const kind = str(a.kind) || "all"
      const limit = num(a.limit, 6, 1, 20)
      const out: Record<string, unknown> = {}
      if (kind === "all" || kind === "lectures") out.lectures = repo.searchLectures(ctx.labId, query, limit)
      const like = `%${query.toLowerCase().slice(0, 80)}%`
      if (kind === "all" || kind === "questions")
        out.questions = all<{ id: string; stem: string }>("SELECT id, stem FROM questions WHERE lab_id = ? AND lower(stem) LIKE ? LIMIT ?", ctx.labId, like, limit).map((r) => ({
          id: r.id,
          stem: clip(r.stem, 220),
        }))
      if (kind === "all" || kind === "cards")
        out.cards = all<{ id: string; topic_id: string; front: string; back: string }>(
          "SELECT id, topic_id, front, back FROM cards WHERE lab_id = ? AND (lower(front) LIKE ? OR lower(back) LIKE ?) LIMIT ?",
          ctx.labId,
          like,
          like,
          limit,
        ).map((r) => ({ id: r.id, topic: r.topic_id, front: r.front, back: clip(r.back, 200) }))
      return out
    },
  },
  {
    name: "read_lecture",
    description: "Read a lecture transcript by number (from search_content or a topic's lectures list).",
    schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    write: false,
    run(ctx, a) {
      const l = repo.getLecture(ctx.labId, num(a.n, 0))
      if (!l) throw new Error(`No lecture ${String(a.n)}`)
      return { n: l.n, title: l.title, section: l.sec, text: clip(l.p.join("\n\n"), 14000) }
    },
  },
  {
    name: "list_items",
    description: "List questions or flashcards of a topic with their status (active/suspended/archived) and SRS strength. Use before archiving learned material or fixing content.",
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["q", "c"] }, topic_id: { type: "string" }, status: { type: "string", enum: ["active", "suspended", "archived", "any"] }, limit: { type: "number" } },
      required: ["kind", "topic_id"],
    },
    write: false,
    run(ctx, a) {
      const t = requireTopic(ctx.labId, a.topic_id)
      const st = repo.readState(ctx.labId)
      const want = str(a.status) || "any"
      const limit = num(a.limit, 40, 1, 120)
      const c = content(ctx.labId)
      const ok = (s: ItemStatus | undefined) => want === "any" || (s ?? "active") === want
      if (a.kind === "q") {
        return c.questions
          .filter((q) => (c.kb.tags[q.id] ?? []).includes(t.id) && ok(q.status))
          .slice(0, limit)
          .map((q) => {
            const r = st.srsq[q.id]
            return { id: q.id, status: q.status ?? "active", src: q.src, stem: clip(q.stem, 160), seen: r?.s ?? 0, right: r?.c ?? 0, wrong: r?.w ?? 0, intervalDays: r?.i ?? 0 }
          })
      }
      return c.kb.cards
        .filter((x) => x.t === t.id && ok(x.status))
        .slice(0, limit)
        .map((x) => {
          const r = st.srsc[x.id]
          return { id: x.id, status: x.status ?? "active", kind: x.k, src: x.s, front: clip(x.f, 160), seen: r?.s ?? 0, lapses: r?.l ?? 0, intervalDays: r?.i ?? 0 }
        })
    },
  },
  {
    name: "get_plan",
    description: "The active study plan with each task's completion, plus how much the learner actually studied on each plan day.",
    schema: { type: "object", properties: {} },
    write: false,
    run(ctx) {
      const p = repo.activePlan(ctx.labId)
      if (!p) return { plan: null }
      const log = repo.readMeta(ctx.labId).log
      return {
        plan: { id: p.id, title: p.title, goal: p.goal, start: p.start, days: p.days.map((d) => ({ ...d, studied: log[d.date] ?? null })) },
      }
    },
  },
  {
    name: "list_changes",
    description: "The coach's recent changes to this lab (newest first), including ones the learner undid.",
    schema: { type: "object", properties: {} },
    write: false,
    run(ctx) {
      return repo.listChanges(ctx.labId).slice(0, 30)
    },
  },
]

function countStates(xs: string[]) {
  const out: Record<string, number> = {}
  for (const x of xs) out[x] = (out[x] ?? 0) + 1
  return out
}

function modelSummary(labId: string) {
  const m = labLearner(labId)
  const weak = [...m.kcs].filter((k) => k.items > 0).sort((a, b) => a.mastery - b.mastery).slice(0, 8)
  return {
    level: m.topicLevel ? "topics (no concept graph yet)" : "knowledge components",
    predictedExam: m.predicted,
    calibration: m.calibration,
    errorTypes: m.errors,
    rapidGuessRate: m.rapidRate,
    weakestConcepts: weak.map((k) => ({ id: k.id, name: k.name, mastery: Math.round(k.mastery * 100) / 100, sd: Math.round(k.sd * 100) / 100, attempts: k.attempts, readiness: Math.round(k.readiness * 100) / 100 })),
    activeMisconceptions: m.kcs.flatMap((k) => k.misconceptions.map((x) => ({ concept: k.name, ...x }))).slice(0, 10),
    pendingRetests: m.kcs.filter((k) => k.pendingRetest).map((k) => k.name).slice(0, 10),
  }
}

function mistakes(labId: string, topic: string | undefined, limit: number) {
  const c = content(labId)
  const qById = new Map(c.questions.map((q) => [q.id, q]))
  const st = repo.readState(labId)
  const out: unknown[] = []
  const seen = new Set<string>()
  const evs = repo.readEvents(labId).filter((e) => e.kind === "q" && !e.correct)
  for (let i = evs.length - 1; i >= 0 && out.length < limit; i--) {
    const e = evs[i]
    if (seen.has(e.item)) continue
    const q = qById.get(e.item)
    if (!q) continue
    if (topic && !(c.kb.tags[q.id] ?? []).includes(topic)) continue
    seen.add(e.item)
    const picked = e.picks ?? []
    out.push({
      id: q.id,
      at: new Date(e.at).toISOString(),
      topics: c.kb.tags[q.id] ?? [],
      stem: clip(q.stem, 600),
      picked: picked.map((p) => `${LETTERS[p]}) ${q.opts[p] ?? "?"}`),
      whyPickedIsWrong: picked.map((p) => q.why[p]).filter(Boolean),
      correct: q.ans.map((p) => `${LETTERS[p]}) ${q.opts[p]}`),
      confidence: ["guess", "unsure", "sure"][e.conf ?? 2],
      sec: Math.round(e.ms / 1000),
      timesWrong: st.srsq[q.id]?.w ?? 1,
      reason: st.meta.mistakes[q.id]?.cat,
      learnerNote: st.notes[`q:${q.id}`]?.t,
    })
  }
  return out
}

/* ---------- write tools ---------- */

const CARD_KINDS: CardKind[] = ["fact", "concept", "compare", "scenario", "list", "trigger"]
const TASK_TYPES: PlanTaskType[] = ["review", "practice", "cards", "cues", "notes", "guide", "exam", "collection", "mistakes", "custom"]

const writeTools: Tool[] = [
  {
    name: "create_flashcards",
    description:
      "Add flashcards to a topic. Kinds: fact, concept, compare (X vs Y), scenario, list, trigger (exam cue → answer; put the reason in 'why'). Keep fronts precise and backs under 40 words.",
    schema: {
      type: "object",
      properties: {
        topic_id: { type: "string" },
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: { front: { type: "string" }, back: { type: "string" }, kind: { type: "string", enum: CARD_KINDS }, why: { type: "string" } },
            required: ["front", "back"],
          },
        },
      },
      required: ["topic_id", "cards"],
    },
    write: true,
    run(ctx, a) {
      const t = requireTopic(ctx.labId, a.topic_id)
      const cards = (Array.isArray(a.cards) ? a.cards : []).slice(0, 40) as Record<string, unknown>[]
      const ch = new Change(ctx.labId, ctx.actor, "create_flashcards")
      const ids: string[] = []
      for (const raw of cards) {
        const f = str(raw.front, 600)
        const b = str(raw.back, 1200)
        if (!f || !b) continue
        const k = (CARD_KINDS.includes(raw.kind as CardKind) ? raw.kind : "fact") as CardKind
        const card: Card = { id: `ai-c-${shortId()}${shortId()}`, t: t.id, f, b, k, s: "A", status: "active", created: Date.now() }
        const why = str(raw.why, 600)
        if (why) card.x = why
        ch.card(card.id)
        repo.upsertCard(ctx.labId, card)
        ids.push(card.id)
      }
      const change = changed(ctx, ch, `Added ${ids.length} flashcards to ${t.title}`)
      return { created: ids.length, ids, change }
    },
  },
  {
    name: "create_questions",
    description:
      "Add practice questions to a topic. Each needs a scenario stem, 3–6 options, the 0-based index(es) of the right option(s), and a rationale for EVERY option saying why it is right or wrong. Make distractors plausible and target the learner's misconceptions.",
    schema: {
      type: "object",
      properties: {
        topic_id: { type: "string" },
        also_topics: { type: "array", items: { type: "string" } },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              stem: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              answer: { type: "array", items: { type: "number" } },
              rationales: { type: "array", items: { type: "string" } },
              explanation: { type: "string" },
            },
            required: ["stem", "options", "answer", "rationales"],
          },
        },
      },
      required: ["topic_id", "questions"],
    },
    write: true,
    run(ctx, a) {
      const t = requireTopic(ctx.labId, a.topic_id)
      const extra = strs(a.also_topics, 3).filter((x) => x !== t.id && repo.getTopic(ctx.labId, x))
      const qs = (Array.isArray(a.questions) ? a.questions : []).slice(0, 25) as Record<string, unknown>[]
      const ch = new Change(ctx.labId, ctx.actor, "create_questions")
      const ids: string[] = []
      const skipped: string[] = []
      const setName = `Coach · ${t.title}`
      const n0 = all<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE lab_id = ? AND set_name = ?", ctx.labId, setName)[0]?.n ?? 0
      for (const raw of qs) {
        const stem = str(raw.stem, 3000)
        const opts = strs(raw.options, 6).map((o) => o.replace(/^[A-H][).:]\s+/, ""))
        const ans = [...new Set((Array.isArray(raw.answer) ? raw.answer : []).map((x) => num(x, -1)).filter((x) => x >= 0 && x < opts.length))]
        if (!stem || opts.length < 2 || !ans.length || ans.length >= opts.length) {
          skipped.push(clip(stem || "(empty stem)", 60))
          continue
        }
        const why = strs(raw.rationales, 6).map((w) => w.replace(/^[A-H]:\s*/, ""))
        const q: Question = {
          id: `ai-q-${shortId()}${shortId()}`,
          src: "agent",
          src_name: "AI coach",
          set: setName,
          kind: "quiz",
          n: n0 + ids.length + 1,
          d: t.d || 1,
          stem,
          opts,
          ans,
          why: opts.map((_, i) => why[i] ?? ""),
          explanation: str(raw.explanation, 3000),
          multi: ans.length > 1,
          status: "active",
          created: Date.now(),
        }
        ch.question(q.id)
        repo.upsertQuestion(ctx.labId, q)
        repo.setTags(ctx.labId, q.id, [t.id, ...extra])
        ids.push(q.id)
      }
      const change = changed(ctx, ch, `Added ${ids.length} questions to ${t.title}`)
      return { created: ids.length, ids, skipped, change }
    },
  },
  {
    name: "write_study_guide",
    description:
      "Save a study guide for a topic in Markdown (it appears in the topic's Notes page). Good guides explain the idea plainly, contrast look-alikes in a table, correct the learner's specific misconceptions and end with a self-check.",
    schema: {
      type: "object",
      properties: { topic_id: { type: "string" }, title: { type: "string" }, markdown: { type: "string" } },
      required: ["topic_id", "title", "markdown"],
    },
    write: true,
    run(ctx, a) {
      const t = requireTopic(ctx.labId, a.topic_id)
      const md = str(a.markdown, 40000)
      if (!md) throw new Error("The guide is empty.")
      const ch = new Change(ctx.labId, ctx.actor, "write_study_guide")
      ch.topic(t.id)
      const g = { id: `g-${shortId()}`, title: str(a.title, 160) || t.title, md, at: Date.now(), model: ctx.actor }
      repo.upsertTopic(ctx.labId, { ...t, guides: [...(t.guides ?? []), g] })
      const change = changed(ctx, ch, `Wrote the guide “${g.title}”`)
      return { guide: g.id, change }
    },
  },
  {
    name: "update_item",
    description: "Fix or improve an existing question or flashcard (typo, wrong answer key, unclear wording, better rationale). Only send the fields to change.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["q", "c"] },
        id: { type: "string" },
        stem: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        answer: { type: "array", items: { type: "number" } },
        rationales: { type: "array", items: { type: "string" } },
        explanation: { type: "string" },
        front: { type: "string" },
        back: { type: "string" },
        topic_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["kind", "id", "reason"],
    },
    write: true,
    run(ctx, a) {
      const ch = new Change(ctx.labId, ctx.actor, "update_item")
      const id = str(a.id, 120)
      if (a.kind === "q") {
        const q = repo.getQuestion(ctx.labId, id)
        if (!q) throw new Error(`No question ${id}`)
        ch.question(id)
        const next = { ...q }
        if (a.stem) next.stem = str(a.stem, 3000)
        if (Array.isArray(a.options)) next.opts = strs(a.options, 6)
        if (Array.isArray(a.answer)) next.ans = a.answer.map((x) => num(x, -1)).filter((x) => x >= 0 && x < next.opts.length)
        if (Array.isArray(a.rationales)) next.why = next.opts.map((_, i) => strs(a.rationales, 6)[i] ?? "")
        if (typeof a.explanation === "string") next.explanation = str(a.explanation, 3000)
        if (!next.ans.length) throw new Error("The answer key would be empty.")
        next.multi = next.ans.length > 1
        repo.upsertQuestion(ctx.labId, next)
        if (a.topic_id) repo.setTags(ctx.labId, id, [requireTopic(ctx.labId, a.topic_id).id])
      } else {
        const c = repo.getCard(ctx.labId, id)
        if (!c) throw new Error(`No card ${id}`)
        ch.card(id)
        repo.upsertCard(ctx.labId, {
          ...c,
          f: a.front ? str(a.front, 600) : c.f,
          b: a.back ? str(a.back, 1200) : c.b,
          t: a.topic_id ? requireTopic(ctx.labId, a.topic_id).id : c.t,
        })
      }
      return { change: changed(ctx, ch, `Edited ${id}: ${str(a.reason, 200)}`) }
    },
  },
  {
    name: "set_item_status",
    description:
      "Manage material: 'archived' retires items the learner has clearly learned (long intervals, no recent misses) so daily load drops; 'suspended' pauses items that are broken or off-scope; 'active' brings them back.",
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["q", "c"] }, ids: { type: "array", items: { type: "string" } }, status: { type: "string", enum: ["active", "suspended", "archived"] }, reason: { type: "string" } },
      required: ["kind", "ids", "status", "reason"],
    },
    write: true,
    run(ctx, a) {
      const status = a.status as ItemStatus
      if (!["active", "suspended", "archived"].includes(status)) throw new Error("status must be active, suspended or archived")
      const ids = strs(a.ids, 300)
      const ch = new Change(ctx.labId, ctx.actor, "set_item_status")
      let n = 0
      for (const id of ids) {
        if (a.kind === "q") {
          const q = repo.getQuestion(ctx.labId, id)
          if (!q) continue
          ch.question(id)
          repo.upsertQuestion(ctx.labId, { ...q, status })
        } else {
          const c = repo.getCard(ctx.labId, id)
          if (!c) continue
          ch.card(id)
          repo.upsertCard(ctx.labId, { ...c, status })
        }
        n++
      }
      return { updated: n, change: changed(ctx, ch, `Set ${n} ${a.kind === "q" ? "questions" : "cards"} to ${status}: ${str(a.reason, 200)}`) }
    },
  },
  {
    name: "upsert_topic",
    description:
      "Create a topic or update one (omit id to create). Topics organise the lab: give each a domain number, a one-line 'covers', and optionally summary, key points, exam tips, pitfalls, mnemonics, prerequisite topic ids and confusable topic ids.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        domain: { type: "number" },
        covers: { type: "string" },
        summary: { type: "array", items: { type: "string" } },
        key_points: { type: "array", items: { type: "string" } },
        exam_tips: { type: "array", items: { type: "string" } },
        pitfalls: { type: "array", items: { type: "string" } },
        mnemonics: { type: "array", items: { type: "string" } },
        prereq: { type: "array", items: { type: "string" } },
        confusable: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
    write: true,
    run(ctx, a) {
      const cfg = repo.getConfig(ctx.labId)
      const existing = a.id ? repo.getTopic(ctx.labId, str(a.id, 80)) : null
      const id = existing?.id ?? (str(a.id, 80) ? slug(str(a.id, 80)) : slug(str(a.title, 80)))
      if (!existing && repo.getTopic(ctx.labId, id)) throw new Error(`Topic id ${id} already exists; pass id to update it.`)
      const d = num(a.domain, existing?.d ?? 1, 0, 50)
      if (d > 0 && !cfg.domains.some((x) => x.n === d)) throw new Error(`Domain ${d} does not exist. Domains: ${cfg.domains.map((x) => `${x.n} ${x.name}`).join("; ")}`)
      const ch = new Change(ctx.labId, ctx.actor, "upsert_topic")
      ch.topic(id)
      const base: Topic = existing ?? {
        id,
        d,
        title: "",
        covers: "",
        summary: [],
        lec: { keyPoints: [], examTips: [], pitfalls: [] },
        exam: { keyPoints: [], examTips: [], pitfalls: [] },
        mnemonics: [],
        tables: [],
        lectures: [],
      }
      const next: Topic = {
        ...base,
        d,
        title: str(a.title, 120) || base.title,
        covers: typeof a.covers === "string" ? str(a.covers, 600) : base.covers,
        summary: Array.isArray(a.summary) ? strs(a.summary, 6) : base.summary,
        lec: {
          keyPoints: Array.isArray(a.key_points) ? strs(a.key_points, 40) : base.lec.keyPoints,
          examTips: Array.isArray(a.exam_tips) ? strs(a.exam_tips, 30) : base.lec.examTips,
          pitfalls: Array.isArray(a.pitfalls) ? strs(a.pitfalls, 30) : base.lec.pitfalls,
        },
        mnemonics: Array.isArray(a.mnemonics) ? strs(a.mnemonics, 10) : base.mnemonics,
        prereq: Array.isArray(a.prereq) ? strs(a.prereq, 10) : base.prereq,
        confusable: Array.isArray(a.confusable) ? strs(a.confusable, 10) : base.confusable,
      }
      repo.upsertTopic(ctx.labId, next)
      return { id, change: changed(ctx, ch, `${existing ? "Updated" : "Created"} topic ${next.title}`) }
    },
  },
  {
    name: "tag_questions",
    description: "Assign questions to topics (first topic is the primary one and sets the question's domain). Replaces each question's current topics.",
    schema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          items: { type: "object", properties: { qid: { type: "string" }, topics: { type: "array", items: { type: "string" } } }, required: ["qid", "topics"] },
        },
      },
      required: ["assignments"],
    },
    write: true,
    run(ctx, a) {
      const valid = new Set(all<{ id: string; d: number }>("SELECT id, d FROM topics WHERE lab_id = ?", ctx.labId).map((r) => r.id))
      const ch = new Change(ctx.labId, ctx.actor, "tag_questions")
      let n = 0
      for (const raw of (Array.isArray(a.assignments) ? a.assignments : []).slice(0, 300) as Record<string, unknown>[]) {
        const qid = str(raw.qid, 120)
        const topics = strs(raw.topics, 4).filter((t) => valid.has(t))
        const q = repo.getQuestion(ctx.labId, qid)
        if (!q || !topics.length) continue
        ch.question(qid)
        repo.setTags(ctx.labId, qid, topics)
        const primary = repo.getTopic(ctx.labId, topics[0])
        if (primary && primary.d > 0 && primary.d !== q.d) repo.upsertQuestion(ctx.labId, { ...q, d: primary.d })
        n++
      }
      return { tagged: n, change: changed(ctx, ch, `Re-tagged ${n} questions`) }
    },
  },
  {
    name: "merge_topics",
    description: "Merge one topic into another: moves its questions, cards, notes, guides and lectures, then removes it.",
    schema: { type: "object", properties: { from: { type: "string" }, into: { type: "string" } }, required: ["from", "into"] },
    write: true,
    run(ctx, a) {
      const from = requireTopic(ctx.labId, a.from)
      const into = requireTopic(ctx.labId, a.into)
      if (from.id === into.id) throw new Error("Pick two different topics.")
      const ch = new Change(ctx.labId, ctx.actor, "merge_topics")
      ch.topic(from.id)
      ch.topic(into.id)
      const c = content(ctx.labId)
      for (const card of c.kb.cards.filter((x) => x.t === from.id)) {
        ch.card(card.id)
        repo.upsertCard(ctx.labId, { ...card, t: into.id })
      }
      for (const [qid, ts] of Object.entries(c.kb.tags)) {
        if (!ts.includes(from.id)) continue
        ch.question(qid)
        repo.setTags(ctx.labId, qid, [...new Set(ts.map((t) => (t === from.id ? into.id : t)))])
      }
      const merge = (x: string[], y: string[]) => [...new Set([...x, ...y])]
      repo.upsertTopic(ctx.labId, {
        ...into,
        summary: merge(into.summary, from.summary),
        lec: { keyPoints: merge(into.lec.keyPoints, from.lec.keyPoints), examTips: merge(into.lec.examTips, from.lec.examTips), pitfalls: merge(into.lec.pitfalls, from.lec.pitfalls) },
        exam: { keyPoints: merge(into.exam.keyPoints, from.exam.keyPoints), examTips: merge(into.exam.examTips, from.exam.examTips), pitfalls: merge(into.exam.pitfalls, from.exam.pitfalls) },
        mnemonics: merge(into.mnemonics, from.mnemonics),
        tables: [...into.tables, ...from.tables],
        lectures: [...new Set([...into.lectures, ...from.lectures])].sort((x, y) => x - y),
        guides: [...(into.guides ?? []), ...(from.guides ?? [])],
      })
      repo.deleteTopic(ctx.labId, from.id)
      return { change: changed(ctx, ch, `Merged ${from.title} into ${into.title}`) }
    },
  },
  {
    name: "set_domains",
    description: "Replace the lab's domains (number, name, short label, weight %). Weights should sum to 100. Topics keep their domain numbers, so keep numbering stable.",
    schema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "object", properties: { n: { type: "number" }, name: { type: "string" }, short: { type: "string" }, w: { type: "number" } }, required: ["n", "name", "w"] },
        },
      },
      required: ["domains"],
    },
    write: true,
    run(ctx, a) {
      const domains = ((Array.isArray(a.domains) ? a.domains : []) as Record<string, unknown>[])
        .slice(0, 8)
        .map((d, i) => ({ n: num(d.n, i + 1, 1, 8), name: str(d.name, 120), short: str(d.short, 40) || str(d.name, 40), w: num(d.w, 0, 0, 100) }))
        .filter((d) => d.name)
      if (!domains.length) throw new Error("Send at least one domain.")
      const ch = new Change(ctx.labId, ctx.actor, "set_domains")
      ch.config()
      repo.updateLab(ctx.labId, { config: { domains } })
      return { change: changed(ctx, ch, `Set ${domains.length} domains`) }
    },
  },
  {
    name: "upsert_concept",
    description: "Create or update a knowledge component (concept) under a topic: one fact, concept or procedure that can be tested on its own. Omit id to create.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        definition: { type: "string" },
        topic_id: { type: "string" },
        kind: { type: "string", enum: ["fact", "concept", "procedure", "comparison"] },
      },
      required: ["name"],
    },
    write: true,
    run(ctx, a) {
      if (!graph.hasKcs(ctx.labId) && !a.id) throw new Error("This lab has no concept graph yet. Build the knowledge base first (Content > Build with the coach); until then topics act as concepts.")
      const existing = a.id ? graph.getKc(ctx.labId, str(a.id, 80)) : null
      const topic = a.topic_id ? requireTopic(ctx.labId, a.topic_id).id : (existing?.topic ?? null)
      const id = existing?.id ?? `kc-${slug(str(a.name, 60))}`
      if (!existing && graph.getKc(ctx.labId, id)) throw new Error(`Concept ${id} already exists; pass its id to update it.`)
      const ch = new Change(ctx.labId, ctx.actor, "upsert_concept")
      ch.kc(id)
      graph.upsertKc(ctx.labId, {
        id,
        topic,
        name: str(a.name, 120) || existing?.name || id,
        definition: typeof a.definition === "string" ? str(a.definition, 600) : (existing?.definition ?? ""),
        kind: (["fact", "concept", "procedure", "comparison"].includes(String(a.kind)) ? a.kind : (existing?.kind ?? "concept")) as "concept",
        status: "active",
        firstLecture: existing?.firstLecture,
        evidence: existing?.evidence ?? [],
      })
      return { id, change: changed(ctx, ch, `${existing ? "Updated" : "Created"} concept ${str(a.name, 80)}`) }
    },
  },
  {
    name: "set_relation",
    description:
      "Add or remove an edge between two concepts: prerequisite (src must be understood before dst), confusable (learners mix them up), related, example_of. The prerequisite graph must stay acyclic.",
    schema: {
      type: "object",
      properties: {
        src: { type: "string" },
        dst: { type: "string" },
        type: { type: "string", enum: ["prerequisite", "confusable", "related", "example_of"] },
        action: { type: "string", enum: ["add", "remove"] },
        reason: { type: "string" },
      },
      required: ["src", "dst", "type", "action", "reason"],
    },
    write: true,
    run(ctx, a) {
      const g = graph.readGraph(ctx.labId)
      const ids = new Set(g.kcs.map((k) => k.id))
      const src = str(a.src, 80)
      const dst = str(a.dst, 80)
      const type = a.type as EdgeType
      if (g.topicLevel) throw new Error("Relations need the concept graph. Build the knowledge base first.")
      if (!ids.has(src) || !ids.has(dst) || src === dst) throw new Error("Both ends must be existing, different concepts (see get_graph).")
      if (a.action === "add" && type === "prerequisite" && reaches(g.edges, dst, src)) throw new Error(`That would create a cycle: ${dst} already leads to ${src}.`)
      const ch = new Change(ctx.labId, ctx.actor, "set_relation")
      ch.edge(src, dst, type)
      if (a.action === "remove") graph.deleteEdge(ctx.labId, src, dst, type)
      else graph.setEdge(ctx.labId, { src, dst, type, weight: 1, method: "manual", evidence: str(a.reason, 400), status: "accepted" })
      return { change: changed(ctx, ch, `${a.action === "remove" ? "Removed" : "Added"} ${type}: ${src} -> ${dst} (${str(a.reason, 120)})`) }
    },
  },
  {
    name: "tag_concepts",
    description:
      "Set which concepts a question tests (primary first) and, optionally, which concept each wrong option describes (distractor -> concept). Distractor tags let the app tell a misconception from a slip.",
    schema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              qid: { type: "string" },
              primary: { type: "string" },
              secondary: { type: "array", items: { type: "string" } },
              distractors: { type: "object", additionalProperties: { type: "string" }, description: "option index (0-based) -> concept id" },
            },
            required: ["qid", "primary"],
          },
        },
      },
      required: ["assignments"],
    },
    write: true,
    run(ctx, a) {
      if (!graph.hasKcs(ctx.labId)) throw new Error("This lab has no concept graph yet; use tag_questions for topics.")
      const ids = new Set(graph.readGraph(ctx.labId).kcs.map((k) => k.id))
      const ch = new Change(ctx.labId, ctx.actor, "tag_concepts")
      let n = 0
      for (const raw of (Array.isArray(a.assignments) ? a.assignments : []).slice(0, 300) as Record<string, unknown>[]) {
        const qid = str(raw.qid, 120)
        const q = repo.getQuestion(ctx.labId, qid)
        const primary = str(raw.primary, 80)
        if (!q || !ids.has(primary)) continue
        ch.itemKc(qid)
        const secondary = strs(raw.secondary, 3).filter((x) => ids.has(x) && x !== primary)
        graph.setItemKcs(ctx.labId, qid, [
          { kc: primary, role: "primary", conf: 1, method: ctx.actor.startsWith("mcp:") ? "mcp" : "llm" },
          ...secondary.map((kc) => ({ kc, role: "secondary" as const, conf: 0.8, method: "llm" })),
        ])
        const d = (raw.distractors && typeof raw.distractors === "object" ? raw.distractors : {}) as Record<string, unknown>
        const opts: Record<number, string> = {}
        for (const [k, v] of Object.entries(d)) {
          const i = Number(k)
          if (Number.isInteger(i) && i >= 0 && i < q.opts.length && !q.ans.includes(i) && ids.has(String(v))) opts[i] = String(v)
        }
        graph.setOptionKcs(ctx.labId, qid, opts)
        n++
      }
      return { tagged: n, change: changed(ctx, ch, `Tagged ${n} questions with concepts`) }
    },
  },
  {
    name: "save_study_plan",
    description:
      "Save a day-by-day study plan; it replaces the active plan and shows on the Today page. Task types: review (daily SRS mix), practice (questions on topics), cards, cues (exam-cue drill), notes (read topic notes), guide (read a coach guide, ref = guide id), exam (mock exam, count = questions), collection (ref = collection id), mistakes (redo wrong answers), custom.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        goal: { type: "string" },
        rationale: { type: "string", description: "Why this plan, citing the analytics" },
        start: { type: "string", description: "YYYY-MM-DD, default today" },
        computed: { type: "boolean", description: "true when the days come from compute_plan; the app then checks your edits stay within the allowed limits" },
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              focus: { type: "string" },
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: TASK_TYPES },
                    title: { type: "string" },
                    topics: { type: "array", items: { type: "string" } },
                    count: { type: "number" },
                    minutes: { type: "number" },
                    why: { type: "string" },
                    ref: { type: "string" },
                    kcs: { type: "array", items: { type: "string" } },
                    reason: { type: "string" },
                  },
                  required: ["type", "title", "minutes"],
                },
              },
            },
            required: ["focus", "tasks"],
          },
        },
      },
      required: ["title", "goal", "rationale", "days"],
    },
    write: true,
    run(ctx, a) {
      const valid = new Set(all<{ id: string }>("SELECT id FROM topics WHERE lab_id = ?", ctx.labId).map((r) => r.id))
      const kcIds = new Set(graph.readGraph(ctx.labId).kcs.map((k) => k.id))
      const startStr = /^\d{4}-\d{2}-\d{2}$/.test(str(a.start)) ? str(a.start) : dayKey()
      const [y, m, d0] = startStr.split("-").map(Number)
      const days: PlanDay[] = ((Array.isArray(a.days) ? a.days : []) as Record<string, unknown>[]).slice(0, 60).map((d, i) => ({
        day: i + 1,
        date: dayKey(new Date(y, m - 1, d0 + i)),
        focus: str(d.focus, 200),
        tasks: ((Array.isArray(d.tasks) ? d.tasks : []) as Record<string, unknown>[]).slice(0, 12).map((t, j) => {
          const task: PlanTask = {
            id: `d${i + 1}t${j + 1}`,
            type: (TASK_TYPES.includes(t.type as PlanTaskType) ? t.type : "custom") as PlanTaskType,
            title: str(t.title, 200),
            topics: strs(t.topics, 6).filter((x) => valid.has(x)),
            minutes: num(t.minutes, 15, 1, 240),
            why: str(t.why, 400),
          }
          const kcs = strs(t.kcs, 6).filter((x) => kcIds.has(x))
          if (kcs.length) task.kcs = kcs
          if (t.reason) task.reason = str(t.reason, 40)
          if (t.count != null) task.count = num(t.count, 10, 1, 200)
          if (t.ref) task.ref = str(t.ref, 80)
          return task
        }),
      }))
      if (!days.length) throw new Error("The plan has no days.")
      if (a.computed) enforceComputed(ctx.labId, days)
      const ch = new Change(ctx.labId, ctx.actor, "save_study_plan")
      const prev = repo.activePlan(ctx.labId)
      if (prev) {
        ch.plan(prev.id)
        repo.savePlan(ctx.labId, { ...prev, status: "archived" })
      }
      const plan: StudyPlan = {
        id: `plan-${shortId()}`,
        at: Date.now(),
        model: ctx.actor,
        title: str(a.title, 200),
        goal: str(a.goal, 600),
        rationale: str(a.rationale, 3000),
        start: startStr,
        days,
        status: "active",
      }
      ch.plan(plan.id)
      repo.savePlan(ctx.labId, plan)
      return { plan: plan.id, days: days.length, change: changed(ctx, ch, `Saved the plan “${plan.title}” (${days.length} days)`) }
    },
  },
  {
    name: "update_plan_task",
    description: "Mark a task of the active plan done or not done.",
    schema: { type: "object", properties: { task_id: { type: "string" }, done: { type: "boolean" } }, required: ["task_id", "done"] },
    write: true,
    run(ctx, a) {
      const p = repo.activePlan(ctx.labId)
      if (!p) throw new Error("There is no active plan.")
      const ch = new Change(ctx.labId, ctx.actor, "update_plan_task")
      ch.plan(p.id)
      for (const d of p.days) for (const t of d.tasks) if (t.id === a.task_id) t.done = a.done ? Date.now() : undefined
      repo.savePlan(ctx.labId, p)
      return { change: changed(ctx, ch, `${a.done ? "Ticked" : "Unticked"} ${String(a.task_id)}`) }
    },
  },
  {
    name: "set_focus",
    description: "Pin up to 6 topics to the top of the Today page (what the learner should focus on now). Send an empty list to clear.",
    schema: { type: "object", properties: { topics: { type: "array", items: { type: "string" } } }, required: ["topics"] },
    write: true,
    run(ctx, a) {
      const valid = new Set(all<{ id: string }>("SELECT id FROM topics WHERE lab_id = ?", ctx.labId).map((r) => r.id))
      const focus = strs(a.topics, 6).filter((t) => valid.has(t))
      const ch = new Change(ctx.labId, ctx.actor, "set_focus")
      ch.config()
      repo.updateLab(ctx.labId, { config: { focus } })
      return { focus, change: changed(ctx, ch, focus.length ? `Pinned ${focus.length} focus topics` : "Cleared focus topics") }
    },
  },
  {
    name: "create_collection",
    description: "Create a named practice set from specific questions and cards (e.g. 'Confusable services', 'Last week's misses'). It appears under Practice.",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, why: { type: "string" }, question_ids: { type: "array", items: { type: "string" } }, card_ids: { type: "array", items: { type: "string" } } },
      required: ["name"],
    },
    write: true,
    run(ctx, a) {
      const c = content(ctx.labId)
      const qIds = new Set(c.questions.map((q) => q.id))
      const cIds = new Set(c.kb.cards.map((x) => x.id))
      const items = [
        ...strs(a.question_ids, 200).filter((id) => qIds.has(id)).map((id) => ({ kind: "q" as const, id })),
        ...strs(a.card_ids, 200).filter((id) => cIds.has(id)).map((id) => ({ kind: "c" as const, id })),
      ]
      if (!items.length) throw new Error("None of those ids exist.")
      const col: Collection = { id: `col-${shortId()}`, name: str(a.name, 120), why: str(a.why, 400), items, at: Date.now() }
      const ch = new Change(ctx.labId, ctx.actor, "create_collection")
      ch.config()
      repo.updateLab(ctx.labId, { config: { collections: [...repo.getConfig(ctx.labId).collections, col].slice(-30) } })
      return { collection: col.id, items: items.length, change: changed(ctx, ch, `Created the set “${col.name}” (${items.length} items)`) }
    },
  },
  {
    name: "delete_collection",
    description: "Remove a custom practice set.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    write: true,
    run(ctx, a) {
      const cfg = repo.getConfig(ctx.labId)
      const ch = new Change(ctx.labId, ctx.actor, "delete_collection")
      ch.config()
      repo.updateLab(ctx.labId, { config: { collections: cfg.collections.filter((c) => c.id !== a.id) } })
      return { change: changed(ctx, ch, `Removed a practice set`) }
    },
  },
  {
    name: "update_study_settings",
    description: "Adjust the learner's study settings: exam date (YYYY-MM-DD or null), new cards per day, new questions per day, session size.",
    schema: {
      type: "object",
      properties: {
        exam_date: { type: ["string", "null"] },
        new_cards_per_day: { type: "number" },
        new_questions_per_day: { type: "number" },
        session_max: { type: "number" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
    write: true,
    run(ctx, a) {
      const meta = repo.readMeta(ctx.labId)
      const ch = new Change(ctx.labId, ctx.actor, "update_study_settings")
      ch.settings()
      const s = { ...meta.settings }
      if (a.exam_date === null) s.examDate = null
      else if (typeof a.exam_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.exam_date)) s.examDate = a.exam_date
      if (a.new_cards_per_day != null) s.newCards = num(a.new_cards_per_day, s.newCards, 0, 300)
      if (a.new_questions_per_day != null) s.newQs = num(a.new_questions_per_day, s.newQs, 0, 200)
      if (a.session_max != null) s.sessionMax = num(a.session_max, s.sessionMax, 10, 500)
      repo.writeMeta(ctx.labId, { ...meta, settings: s })
      return { settings: s, change: changed(ctx, ch, `Study settings: ${str(a.reason, 200)}`) }
    },
  },
  {
    name: "remember",
    description: "Save a durable note about the learner or this lab (goals, preferences, schedule, recurring weaknesses) to the lab memory you see at the start of every conversation. mode 'append' (default) or 'replace'.",
    schema: { type: "object", properties: { note: { type: "string" }, mode: { type: "string", enum: ["append", "replace"] } }, required: ["note"] },
    write: true,
    run(ctx, a) {
      const cfg = repo.getConfig(ctx.labId)
      const note = str(a.note, 2000)
      const memory = a.mode === "replace" ? note : [cfg.memory, `- ${dayKey()}: ${note}`].filter(Boolean).join("\n").slice(-6000)
      const ch = new Change(ctx.labId, ctx.actor, "remember")
      ch.config()
      repo.updateLab(ctx.labId, { config: { memory } })
      return { change: changed(ctx, ch, `Remembered: ${clip(note, 120)}`) }
    },
  },
]

/** Does a path of prerequisite edges lead from a to b? */
function reaches(edges: { src: string; dst: string; type: string }[], a: string, b: string): boolean {
  const next = new Map<string, string[]>()
  for (const e of edges) if (e.type === "prerequisite") next.set(e.src, [...(next.get(e.src) ?? []), e.dst])
  const seen = new Set<string>()
  const stack = [a]
  while (stack.length) {
    const x = stack.pop()!
    if (x === b) return true
    if (seen.has(x)) continue
    seen.add(x)
    stack.push(...(next.get(x) ?? []))
  }
  return false
}

/**
 * The coach may edit a computed plan only within limits: every due review, retest, exam-risk and mock
 * task the planner scheduled stays, and each day stays within +20% of the planner's minutes.
 */
function enforceComputed(labId: string, days: PlanDay[]) {
  const ref = labPlan(labId, { days: days.length })
  ref.days.forEach((rd, i) => {
    const d = days[i]
    if (!d) return
    for (const must of rd.tasks.filter((t) => t.reason && ["due_review", "retest", "mock", "exam_risk"].includes(t.reason))) {
      if (!d.tasks.some((t) => t.reason === must.reason)) d.tasks.unshift({ ...must, id: `${must.id}r` })
    }
    const refMin = rd.tasks.reduce((x, t) => x + t.minutes, 0)
    const total = d.tasks.reduce((x, t) => x + t.minutes, 0)
    if (refMin && total > refMin * 1.2) {
      const f = (refMin * 1.2) / total
      for (const t of d.tasks) t.minutes = Math.max(3, Math.round(t.minutes * f))
    }
  })
}

export const TOOLS: Tool[] = [...readTools, ...writeTools]
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>, override?: Tool): { ok: boolean; result: unknown } {
  const tool = override ?? TOOL_BY_NAME.get(name)
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}` } }
  try {
    return { ok: true, result: tool.write ? tx(() => tool.run(ctx, args ?? {})) : tool.run(ctx, args ?? {}) }
  } catch (e) {
    return { ok: false, result: { error: (e as Error).message } }
  }
}
