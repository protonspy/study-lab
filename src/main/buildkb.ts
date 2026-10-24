import type { BuildKbOptions } from "@shared/api"
import type { Card, CardKind, Domain, Topic } from "@shared/types"
import { GENERAL_DOMAIN } from "@shared/defaults"
import { systemPrompt } from "./agent"
import { tx } from "./db"
import { emit, type JobHandle } from "./jobs"
import { Change } from "./journal"
import { chatJson, currentModel } from "./openrouter"
import * as repo from "./repo"

/*
  Turn raw imported material (lecture transcripts + question banks) into a study knowledge base,
  the same shape the hand-built labs have: domains → topics (notes, exam tips, pitfalls) →
  flashcards, with every question tagged to its topics. Three passes:
  1. outline: one call proposes domains and topics from the lecture/section titles and sample questions;
  2. notes: one call per topic reads that topic's transcripts and writes notes and flashcards;
  3. tagging: batches of questions are assigned to topics.
*/

interface OutlineTopic {
  id: string
  title: string
  domain: number
  covers: string
  lectures: number[]
}

interface Outline {
  domains?: Domain[]
  topics: OutlineTopic[]
}

interface TopicNotes {
  summary: string[]
  keyPoints: string[]
  examTips: string[]
  pitfalls: string[]
  mnemonics: string[]
  confusable: string[]
  cards: { front: string; back: string; kind: CardKind; why?: string }[]
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

async function pool<T, R>(items: T[], size: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

export async function runBuildKb(labId: string, job: JobHandle, o: BuildKbOptions) {
  const lab = repo.getLab(labId)
  const content = repo.readContent(labId)
  const lectures = repo.getLectures(labId)
  if (!lectures.length && !content.questions.length) throw new Error("Import lectures or questions first — there is nothing to build from.")
  const sys = systemPrompt(labId)
  const model = currentModel()
  const ch = new Change(labId, model, "build_kb")
  const keep = o.keep ?? content.kb.topics.length > 0
  const cardsPerTopic = Math.max(0, Math.min(25, o.cardsPerTopic ?? 10))

  /* 1. outline */
  job.step("Outlining domains and topics…", 0.05)
  const sections = new Map<string, { n: number; title: string }[]>()
  for (const l of lectures) {
    if (!sections.has(l.sec)) sections.set(l.sec, [])
    sections.get(l.sec)!.push({ n: l.n, title: l.title })
  }
  const outlineText = [...sections.entries()].map(([sec, ls]) => `## ${sec}\n${ls.map((l) => `${l.n}. ${l.title}`).join("\n")}`).join("\n\n")
  const sets = [...new Set(content.questions.map((q) => q.set))]
  const sample = content.questions
    .filter((_, i) => i % Math.max(1, Math.floor(content.questions.length / 12)) === 0)
    .slice(0, 12)
    .map((q) => `- ${q.stem.slice(0, 240)}`)
    .join("\n")
  const generalOnly = lab.config.domains.length === 1 && lab.config.domains[0].name === GENERAL_DOMAIN.name
  const existing = content.kb.topics.map((t) => `${t.id}: ${t.title} (D${t.d})`).join("\n")

  const outline = await chatJson<Outline>({
    task: "build-kb:outline",
    labId,
    signal: job.signal,
    maxTokens: 12000,
    schema: {
      name: "outline",
      schema: {
        type: "object",
        properties: {
          domains: { type: "array", items: { type: "object", properties: { n: { type: "number" }, name: { type: "string" }, short: { type: "string" }, w: { type: "number" } }, required: ["n", "name", "short", "w"] } },
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, title: { type: "string" }, domain: { type: "number" }, covers: { type: "string" }, lectures: { type: "array", items: { type: "number" } } },
              required: ["id", "title", "domain", "covers", "lectures"],
            },
          },
        },
        required: ["topics"],
      },
    },
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `Design the knowledge base for this lab. Return JSON only.

${generalOnly ? "The lab has no real domains yet: propose 3–6 domains (n from 1, short label, weight % summing to 100 — use the official exam guide weights if you know them, otherwise weight by how much material each covers)." : `Keep these domains: ${lab.config.domains.map((d) => `D${d.n} ${d.name}`).join("; ")}. Do not return a "domains" field.`}
Propose 12–32 topics. Each topic: a stable kebab-case id, a title, its domain number, one line on what it covers, and the lecture numbers that teach it (every substantive lecture should belong to at least one topic; skip intro/feedback/admin lectures). Topics should be the units a learner masters and an exam tests — not too broad, not single facts.
${keep && existing ? `\nExisting topics (reuse their ids where they fit; you may add new ones):\n${existing}` : ""}
${o.instructions ? `\nLearner's instructions: ${o.instructions}` : ""}

# Lecture outline
${outlineText || "(no lectures)"}

# Question sets
${sets.join("\n") || "(none)"}

# Sample questions
${sample || "(none)"}`,
      },
    ],
  })
  job.addUsage(outline.usage, outline.model)
  const topicsOut = outline.data.topics.filter((t) => t.title).slice(0, 40)
  if (!topicsOut.length) throw new Error("The model did not propose any topics.")
  const validLectures = new Set(lectures.map((l) => l.n))

  tx(() => {
    if (generalOnly && outline.data.domains?.length) {
      ch.config()
      const domains = outline.data.domains.slice(0, 8).map((d, i) => ({ n: i + 1, name: String(d.name), short: String(d.short || d.name).slice(0, 40), w: Number(d.w) || 0 }))
      repo.updateLab(labId, { config: { domains } })
    }
  })
  const domains = repo.getConfig(labId).domains
  const domainNs = new Set(domains.map((d) => d.n))
  const usedIds = new Set<string>()
  const plan: { topic: Topic; lectures: number[] }[] = []
  for (const raw of topicsOut) {
    let id = slug(raw.id || raw.title) || `topic-${plan.length + 1}`
    while (usedIds.has(id)) id = `${id}-2`
    usedIds.add(id)
    const prev = content.kb.topics.find((t) => t.id === id)
    const lecs = (raw.lectures ?? []).map(Number).filter((n) => validLectures.has(n))
    const topic: Topic = prev ?? {
      id,
      d: domainNs.has(raw.domain) ? raw.domain : domains[0].n,
      title: raw.title,
      covers: raw.covers ?? "",
      summary: [],
      lec: { keyPoints: [], examTips: [], pitfalls: [] },
      exam: { keyPoints: [], examTips: [], pitfalls: [] },
      mnemonics: [],
      tables: [],
      lectures: lecs,
    }
    if (!prev) {
      tx(() => {
        ch.topic(id)
        repo.upsertTopic(labId, topic, plan.length)
      })
    }
    plan.push({ topic, lectures: lecs })
  }
  emit({ type: "lab-changed", labId, what: ["content", "config"] })

  /* 2. notes and flashcards per topic */
  const lecById = new Map(lectures.map((l) => [l.n, l]))
  const topicList = plan.map((p) => `${p.topic.id}: ${p.topic.title}`).join("\n")
  let done = 0
  const needNotes = plan.filter((p) => !keep || !(p.topic.lec.keyPoints.length || p.topic.exam.keyPoints.length))
  await pool(needNotes, 3, async (p) => {
    if (job.signal.aborted) return
    let text = ""
    for (const n of p.lectures) {
      const l = lecById.get(n)
      if (!l) continue
      text += `\n\n### Lecture ${l.n}: ${l.title}\n${l.p.join("\n")}`
      if (text.length > 60000) break
    }
    const qs = content.questions
      .filter((q) => (content.kb.tags[q.id] ?? []).includes(p.topic.id))
      .slice(0, 6)
      .map((q) => `- ${q.stem.slice(0, 300)}`)
      .join("\n")
    try {
      const res = await chatJson<TopicNotes>({
        task: "build-kb:notes",
        labId,
        signal: job.signal,
        maxTokens: 10000,
        schema: {
          name: "topic_notes",
          schema: {
            type: "object",
            properties: {
              summary: { type: "array", items: { type: "string" } },
              keyPoints: { type: "array", items: { type: "string" } },
              examTips: { type: "array", items: { type: "string" } },
              pitfalls: { type: "array", items: { type: "string" } },
              mnemonics: { type: "array", items: { type: "string" } },
              confusable: { type: "array", items: { type: "string" } },
              cards: {
                type: "array",
                items: {
                  type: "object",
                  properties: { front: { type: "string" }, back: { type: "string" }, kind: { type: "string", enum: ["fact", "concept", "compare", "scenario", "list", "trigger"] }, why: { type: "string" } },
                  required: ["front", "back", "kind"],
                },
              },
            },
            required: ["summary", "keyPoints", "examTips", "pitfalls", "cards"],
          },
        },
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: `Write study notes for the topic "${p.topic.title}" (${p.topic.covers}). Use ONLY the material below. Return JSON:
- summary: 2–4 sentences;
- keyPoints: 6–15 crisp standalone facts (names, limits, defaults, numbers);
- examTips: 3–8 lines like "If the scenario says <cue>, pick <answer> because <reason>";
- pitfalls: 2–6 lines like "Trap: <tempting wrong idea>. Reality: <correct idea>.";
- mnemonics: 0–3 memory hooks;
- confusable: ids of other topics from the list that learners mix up with this one;
- cards: ${cardsPerTopic} flashcards (mix concept, compare, scenario and trigger; trigger = exam cue on the front, the answer on the back, reason in "why"). Backs under 40 words.

Other topics:
${topicList}
${qs ? `\nQuestions on this topic:\n${qs}` : ""}

# Material${text || "\n(no lecture transcripts for this topic — rely on the questions and say less)"}`,
          },
        ],
      })
      job.addUsage(res.usage, res.model)
      const n = res.data
      const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])
      tx(() => {
        ch.topic(p.topic.id)
        const fresh = repo.getTopic(labId, p.topic.id) ?? p.topic
        repo.upsertTopic(labId, {
          ...fresh,
          summary: arr(n.summary).slice(0, 6),
          lec: { keyPoints: arr(n.keyPoints).slice(0, 30), examTips: arr(n.examTips).slice(0, 15), pitfalls: arr(n.pitfalls).slice(0, 12) },
          mnemonics: arr(n.mnemonics).slice(0, 5),
          confusable: arr(n.confusable).filter((x) => usedIds.has(x) && x !== p.topic.id),
        })
        ;(Array.isArray(n.cards) ? n.cards : []).slice(0, cardsPerTopic + 5).forEach((c, i) => {
          if (!c?.front || !c?.back) return
          const card: Card = {
            id: `kb-${p.topic.id}-${Date.now().toString(36)}${i}`,
            t: p.topic.id,
            f: String(c.front),
            b: String(c.back),
            k: (["fact", "concept", "compare", "scenario", "list", "trigger"].includes(c.kind) ? c.kind : "fact") as CardKind,
            s: "L",
            status: "active",
            created: Date.now(),
          }
          if (c.why) card.x = String(c.why)
          ch.card(card.id)
          repo.upsertCard(labId, card)
        })
      })
    } finally {
      done++
      job.step(`Writing notes and cards (${done}/${needNotes.length})…`, 0.1 + 0.55 * (done / Math.max(1, needNotes.length)))
      emit({ type: "lab-changed", labId, what: ["content"] })
    }
  })
  if (job.signal.aborted) return finish()

  /* 3. tag questions */
  const untagged = keep ? content.questions.filter((q) => !(content.kb.tags[q.id] ?? []).length) : content.questions
  const batches: (typeof untagged)[] = []
  for (let i = 0; i < untagged.length; i += 30) batches.push(untagged.slice(i, i + 30))
  const catalog = plan.map((p) => `${p.topic.id} (D${p.topic.d}): ${p.topic.title} — ${p.topic.covers}`).join("\n")
  let tagged = 0
  await pool(batches, 3, async (batch) => {
    if (job.signal.aborted) return
    const res = await chatJson<{ assignments: { qid: string; topics: string[] }[] }>({
      task: "build-kb:tags",
      labId,
      signal: job.signal,
      maxTokens: 6000,
      schema: {
        name: "tags",
        schema: {
          type: "object",
          properties: { assignments: { type: "array", items: { type: "object", properties: { qid: { type: "string" }, topics: { type: "array", items: { type: "string" } } }, required: ["qid", "topics"] } } },
          required: ["assignments"],
        },
      },
      messages: [
        { role: "system", content: "You classify exam questions into topics. Reply with JSON only." },
        {
          role: "user",
          content: `Assign each question to 1–3 topics from the catalog, most relevant first (the first decides the domain). Use only catalog ids.

# Catalog
${catalog}

# Questions
${batch.map((q) => `[${q.id}] ${q.stem.slice(0, 500)}\nOptions: ${q.opts.map((x) => x.slice(0, 80)).join(" | ")}\nAnswer: ${q.ans.map((i) => q.opts[i]?.slice(0, 80)).join(" | ")}`).join("\n\n")}`,
        },
      ],
    })
    job.addUsage(res.usage, res.model)
    tx(() => {
      for (const a of res.data.assignments ?? []) {
        const q = batch.find((x) => x.id === a.qid)
        const ts = (a.topics ?? []).filter((t) => usedIds.has(t) || content.kb.topics.some((x) => x.id === t)).slice(0, 3)
        if (!q || !ts.length) continue
        ch.question(q.id)
        repo.setTags(labId, q.id, ts)
        const primary = plan.find((p) => p.topic.id === ts[0])?.topic
        if (primary && primary.d > 0 && primary.d !== q.d) repo.upsertQuestion(labId, { ...q, d: primary.d })
        tagged++
      }
    })
    job.step(`Tagging questions (${tagged}/${untagged.length})…`, 0.65 + 0.33 * (tagged / Math.max(1, untagged.length)))
  })
  return finish()

  function finish() {
    tx(() => {
      repo.setBuilt(labId)
      ch.commit(`Built the knowledge base: ${plan.length} topics with notes, flashcards and question tags`)
    })
    emit({ type: "lab-changed", labId, what: ["content", "config"] })
  }
}
