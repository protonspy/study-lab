import type { BuildKbOptions } from "@shared/api"
import { GENERAL_DOMAIN } from "@shared/defaults"
import type { Card, CardKind, Domain, GraphEdge, Kc, Question, Topic } from "@shared/types"
import { systemPrompt } from "./agent"
import { all, one, run, tx } from "./db"
import { cosine, getEmbedder, toBlob } from "./embeddings"
import * as graph from "./graph"
import { emit, type JobHandle } from "./jobs"
import { Change } from "./journal"
import { chatJson } from "./openrouter"
import * as repo from "./repo"

/*
  Knowledge-base builder (docs/methodology.md §1): course material → a graph of knowledge components.

  1. chunk      lectures → ~1800-character chunks with stable ids (evidence for everything below)
  2. extract    per group of lectures, the LLM lists the concepts each chunk teaches (fixed schema)
  3. resolve    near-duplicates merge by embedding similarity; the grey zone goes to the LLM
  4. organise   concepts → topics → domains (the LLM names the groups)
  5. relate     prerequisite edges from an ensemble (course order + reference distance + LLM check,
                kept acyclic), confusable edges from distractors and similarity, related edges by kNN
  6. Q-matrix   each question → primary/secondary concepts and the concept each wrong option describes,
                chosen from embedding candidates (the LLM may propose a missing concept)
  7. notes      per topic, notes and flashcards grounded in that topic's chunks, near-duplicates dropped

  Incremental: with `keep`, only lectures and questions not yet in the graph are processed and new
  concepts merge into the existing ones. Every write is journaled in one undoable change.
*/

interface Chunk {
  id: string
  lecture: number
  ord: number
  text: string
  context: string
}

interface Candidate {
  name: string
  definition: string
  kind: Kc["kind"]
  chunks: string[]
  mentions: string[]
  lecture: number
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)

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

const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])
const KINDS: Kc["kind"][] = ["fact", "concept", "procedure", "comparison"]

/* ---------- 1. chunks ---------- */

export function chunkLectures(labId: string, lectureNs?: Set<number>): Chunk[] {
  const out: Chunk[] = []
  for (const l of repo.getLectures(labId)) {
    if (lectureNs && !lectureNs.has(l.n)) continue
    let buf = ""
    let ord = 0
    const flush = () => {
      if (buf.trim()) out.push({ id: `${l.n}:${ord}`, lecture: l.n, ord, text: buf.trim(), context: `${l.sec ? `${l.sec} — ` : ""}${l.title}` })
      ord++
      buf = ""
    }
    for (const p of l.p) {
      if (buf.length + p.length > 1800 && buf) flush()
      buf += (buf ? "\n\n" : "") + p
    }
    flush()
  }
  return out
}

/* ---------- the builder ---------- */

export async function runBuildKb(labId: string, job: JobHandle, o: BuildKbOptions) {
  const lab = repo.getLab(labId)
  const content = repo.readContent(labId)
  const cfg = repo.getConfig(labId)
  if (!lab.counts.lectures && !content.questions.length) throw new Error("Import lectures or questions first — there is nothing to build from.")
  const sys = systemPrompt(labId)
  const ch = new Change(labId, "knowledge-builder", "build_kb")
  const keep = (o.keep ?? true) && graph.hasKcs(labId)
  const cardsPerTopic = Math.max(0, Math.min(25, o.cardsPerTopic ?? 10))
  const usage = (u: { tokensIn: number; tokensOut: number; cost: number }, m: string) => job.addUsage(u, m)
  const ask = async <T>(task: string, schema: Record<string, unknown>, user: string, maxTokens = 8000) => {
    const r = await chatJson<T>({ task: `build-kb:${task}`, labId, signal: job.signal, maxTokens, schema: { name: task, schema }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] })
    usage(r.usage, r.model)
    return r.data
  }

  /* 1. chunks (only lectures not yet covered when incremental) */
  job.step("Splitting lectures into chunks…", 0.02)
  const covered = new Set<number>()
  if (keep) for (const k of all<{ evidence: string }>("SELECT evidence FROM kcs WHERE lab_id = ?", labId)) for (const e of JSON.parse(k.evidence) as string[]) covered.add(Number(e.split(":")[0]))
  const lectureNs = new Set(repo.getLectures(labId).filter((l) => !covered.has(l.n)).map((l) => l.n))
  const chunks = chunkLectures(labId, lectureNs)
  const embedder = await getEmbedder(labId, job.signal)
  job.step(`Embedding ${chunks.length} chunks (${embedder.kind === "model" ? embedder.model : "local lexical vectors"})…`, 0.05)
  const chunkVec = new Map<string, Float32Array>()
  const vecs = await embedder.embed(
    chunks.map((c) => `${c.context}\n${c.text}`),
    job.signal,
  )
  chunks.forEach((c, i) => chunkVec.set(c.id, vecs[i]))
  tx(() => {
    for (const c of chunks)
      run(
        "INSERT INTO chunks(lab_id, id, lecture_n, ord, text, embedding) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(lab_id, id) DO UPDATE SET text = excluded.text, embedding = excluded.embedding",
        labId,
        c.id,
        c.lecture,
        c.ord,
        c.text,
        toBlob(chunkVec.get(c.id)!),
      )
  })

  /* 2. extract concepts per group of lectures */
  const groups: Chunk[][] = []
  let cur: Chunk[] = []
  let size = 0
  for (const c of chunks) {
    if (size + c.text.length > 14_000 && cur.length) {
      groups.push(cur)
      cur = []
      size = 0
    }
    cur.push(c)
    size += c.text.length
  }
  if (cur.length) groups.push(cur)
  const candidates: Candidate[] = []
  let doneGroups = 0
  await pool(groups, 3, async (g) => {
    if (job.signal.aborted) return
    const data = await ask<{ concepts: { name: string; definition: string; kind: string; chunks: string[]; relies_on: string[] }[] }>(
      "extract",
      {
        type: "object",
        properties: {
          concepts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                definition: { type: "string" },
                kind: { type: "string", enum: KINDS },
                chunks: { type: "array", items: { type: "string" } },
                relies_on: { type: "array", items: { type: "string" } },
              },
              required: ["name", "definition", "kind", "chunks"],
            },
          },
        },
        required: ["concepts"],
      },
      `List the knowledge components taught in these course chunks. A knowledge component is one fact, concept, procedure or comparison a learner could be tested on in isolation (e.g. a service and what it is for, a metric and when to use it, a step in a process). Skip course logistics and small talk.
For each: a short canonical name (as the course names it), a one-sentence definition from the text, its kind, the chunk ids that teach it, and the names of other concepts it relies on (only if the text makes that dependency explicit).
${o.instructions ? `Learner's guidance: ${o.instructions}\n` : ""}
${g.map((c) => `[chunk ${c.id}] (${c.context})\n${c.text}`).join("\n\n")}`,
      10_000,
    )
    const valid = new Set(g.map((c) => c.id))
    for (const k of data.concepts ?? []) {
      if (!k?.name || !k.definition) continue
      const ids = arr(k.chunks).filter((id) => valid.has(id))
      const ev = ids.length ? ids : [g[0].id]
      candidates.push({
        name: String(k.name).slice(0, 120),
        definition: String(k.definition).slice(0, 500),
        kind: (KINDS.includes(k.kind as Kc["kind"]) ? k.kind : "concept") as Kc["kind"],
        chunks: ev,
        mentions: arr(k.relies_on).slice(0, 6),
        lecture: Math.min(...ev.map((id) => Number(id.split(":")[0]))),
      })
    }
    doneGroups++
    job.step(`Extracting concepts (${doneGroups}/${groups.length} parts)…`, 0.08 + 0.3 * (doneGroups / Math.max(1, groups.length)))
  })
  if (job.signal.aborted) return

  /* 3. resolve near-duplicates against each other and the existing graph */
  job.step("Merging duplicate concepts…", 0.4)
  const existing = keep ? graph.readGraph(labId).kcs : []
  const kcs = new Map<string, Kc>(existing.map((k) => [k.id, { ...k }]))
  const kcVec = new Map<string, Float32Array>()
  if (existing.length) {
    const ev = await embedder.embed(
      existing.map((k) => `${k.name}: ${k.definition}`),
      job.signal,
    )
    existing.forEach((k, i) => kcVec.set(k.id, ev[i]))
  }
  candidates.sort((a, b) => a.lecture - b.lecture)
  const candVec = await embedder.embed(
    candidates.map((c) => `${c.name}: ${c.definition}`),
    job.signal,
  )
  const grey: { cand: Candidate; vec: Float32Array; kc: string }[] = []
  const mentionsOf = new Map<string, Set<string>>()
  const addMentions = (id: string, m: string[]) => {
    const s = mentionsOf.get(id) ?? new Set()
    for (const x of m) s.add(x.toLowerCase())
    mentionsOf.set(id, s)
  }
  const nearest = (v: Float32Array) => {
    let best: { id: string; sim: number } | null = null
    for (const [id, kv] of kcVec) {
      const s = cosine(v, kv)
      if (!best || s > best.sim) best = { id, sim: s }
    }
    return best
  }
  const mergeInto = (id: string, c: Candidate) => {
    const k = kcs.get(id)!
    k.evidence = [...new Set([...k.evidence, ...c.chunks])].slice(0, 40)
    k.firstLecture = Math.min(k.firstLecture ?? c.lecture, c.lecture)
    if (!k.definition && c.definition) k.definition = c.definition
    addMentions(id, c.mentions)
  }
  const create = (c: Candidate, v: Float32Array) => {
    let id = `kc-${slug(c.name)}`
    for (let i = 2; kcs.has(id); i++) id = `kc-${slug(c.name)}-${i}`
    kcs.set(id, { id, topic: null, name: c.name, definition: c.definition, kind: c.kind, status: "active", firstLecture: c.lecture, evidence: c.chunks })
    kcVec.set(id, v)
    addMentions(id, c.mentions)
    return id
  }
  candidates.forEach((c, i) => {
    const v = candVec[i]
    const n = nearest(v)
    const sameName = [...kcs.values()].find((k) => k.name.toLowerCase() === c.name.toLowerCase())
    if (sameName) mergeInto(sameName.id, c)
    else if (n && n.sim >= embedder.thresholds.high) mergeInto(n.id, c)
    else if (n && n.sim >= embedder.thresholds.low) grey.push({ cand: c, vec: v, kc: n.id })
    else create(c, v)
  })
  // Grey zone: the LLM decides same or different, in batches.
  for (let i = 0; i < grey.length; i += 30) {
    if (job.signal.aborted) return
    const batch = grey.slice(i, i + 30)
    const data = await ask<{ verdicts: { i: number; same: boolean }[] }>(
      "resolve",
      { type: "object", properties: { verdicts: { type: "array", items: { type: "object", properties: { i: { type: "number" }, same: { type: "boolean" } }, required: ["i", "same"] } } }, required: ["verdicts"] },
      `For each pair, say whether A and B are the SAME knowledge component (same thing, maybe worded differently) or different ones (one more general, more specific, or unrelated).
${batch.map((g, j) => `${j}. A: ${g.cand.name} — ${g.cand.definition}\n   B: ${kcs.get(g.kc)!.name} — ${kcs.get(g.kc)!.definition}`).join("\n")}`,
      3000,
    )
    const same = new Set((data.verdicts ?? []).filter((v) => v.same).map((v) => v.i))
    batch.forEach((g, j) => (same.has(j) ? mergeInto(g.kc, g.cand) : create(g.cand, g.vec)))
  }
  job.step(`${kcs.size} concepts after merging duplicates…`, 0.45)

  /* 4. organise concepts into topics and domains */
  const generalOnly = cfg.domains.length === 1 && cfg.domains[0].name === GENERAL_DOMAIN.name
  const unplaced = [...kcs.values()].filter((k) => !k.topic)
  const topicsBefore = repo.readTopics(labId)
  if (unplaced.length) {
    const data = await ask<{ domains?: Domain[]; topics: { id: string; title: string; domain: number; covers: string }[]; assign: { kc: string; topic: string }[] }>(
      "organise",
      {
        type: "object",
        properties: {
          domains: { type: "array", items: { type: "object", properties: { n: { type: "number" }, name: { type: "string" }, short: { type: "string" }, w: { type: "number" } }, required: ["n", "name", "short", "w"] } },
          topics: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, domain: { type: "number" }, covers: { type: "string" } }, required: ["id", "title", "domain", "covers"] } },
          assign: { type: "array", items: { type: "object", properties: { kc: { type: "string" }, topic: { type: "string" } }, required: ["kc", "topic"] } },
        },
        required: ["topics", "assign"],
      },
      `Organise these knowledge components into topics (groups of 3–15 closely related concepts a learner studies together) and assign every concept to exactly one topic.
${generalOnly ? "The lab has no real domains yet: also propose 3–6 domains (n from 1, short label, exam weight % summing to 100 — the official exam guide's weights if you know them, otherwise by how much material each covers)." : `Domains (keep them): ${cfg.domains.map((d) => `D${d.n} ${d.name}`).join("; ")}.`}
${topicsBefore.length ? `Existing topics (reuse their ids where they fit): ${topicsBefore.map((t) => `${t.id}: ${t.title} (D${t.d})`).join("; ")}` : ""}
Return topic ids in kebab-case.${o.instructions ? `\nLearner's guidance: ${o.instructions}` : ""}

${unplaced.map((k) => `${k.id} | ${k.name} — ${k.definition.slice(0, 120)} (lecture ${k.firstLecture ?? "?"})`).join("\n")}`,
      12_000,
    )
    tx(() => {
      if (generalOnly && data.domains?.length) {
        ch.config()
        repo.updateLab(labId, { config: { domains: data.domains.slice(0, 8).map((d, i) => ({ n: i + 1, name: String(d.name), short: String(d.short || d.name).slice(0, 40), w: Number(d.w) || 0 })) } })
      }
      const domains = repo.getConfig(labId).domains
      const known = new Map(topicsBefore.map((t) => [t.id, t]))
      for (const t of data.topics ?? []) {
        const id = slug(t.id || t.title)
        if (!id || known.has(id)) continue
        const topic: Topic = {
          id,
          d: domains.some((d) => d.n === t.domain) ? t.domain : domains[0].n,
          title: String(t.title),
          covers: String(t.covers ?? ""),
          summary: [],
          lec: { keyPoints: [], examTips: [], pitfalls: [] },
          exam: { keyPoints: [], examTips: [], pitfalls: [] },
          mnemonics: [],
          tables: [],
          lectures: [],
        }
        ch.topic(id)
        repo.upsertTopic(labId, topic)
        known.set(id, topic)
      }
      for (const a of data.assign ?? []) {
        const k = kcs.get(a.kc)
        const tid = slug(a.topic)
        if (k && known.has(tid)) k.topic = tid
      }
      // Anything the model skipped goes to the topic of its most similar placed concept.
      for (const k of kcs.values()) {
        if (k.topic) continue
        const v = kcVec.get(k.id)
        let best: { id: string; sim: number } | null = null
        if (v) for (const o2 of kcs.values()) if (o2.topic && o2.id !== k.id) {
          const s = cosine(v, kcVec.get(o2.id) ?? v)
          if (!best || s > best.sim) best = { id: o2.id, sim: s }
        }
        k.topic = best ? kcs.get(best.id)!.topic : ([...known.keys()][0] ?? null)
      }
      // Topic lecture lists follow their concepts' evidence.
      for (const [tid, t] of known) {
        const lecs = new Set<number>(t.lectures)
        for (const k of kcs.values()) if (k.topic === tid) for (const e of k.evidence) lecs.add(Number(e.split(":")[0]))
        const fresh = repo.getTopic(labId, tid)
        if (fresh) {
          ch.topic(tid)
          repo.upsertTopic(labId, { ...fresh, lectures: [...lecs].sort((x, y) => x - y) })
        }
      }
      for (const k of kcs.values()) {
        ch.kc(k.id)
        graph.upsertKc(labId, k, kcVec.get(k.id) ?? null)
      }
    })
    emit({ type: "lab-changed", labId, what: ["content", "config"] })
  }
  job.step("Inferring prerequisites and look-alikes…", 0.5)
  if (job.signal.aborted) return finish()

  /* 5. relations */
  const all_ = [...kcs.values()]
  const nameRe = new Map(all_.map((k) => [k.id, new RegExp(`\\b${k.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")]))
  const chunkText = new Map(all<{ id: string; text: string }>("SELECT id, text FROM chunks WHERE lab_id = ?", labId).map((r) => [r.id, r.text]))
  // Reference distance (lite): how much of B's material refers to A, minus the reverse.
  const refers = (a: Kc, b: Kc) => {
    const ev = b.evidence.map((e) => chunkText.get(e) ?? "")
    if (!ev.length) return 0
    return ev.filter((t) => nameRe.get(a.id)!.test(t)).length / ev.length
  }
  const prereqCands: { a: Kc; b: Kc; score: number; mention: boolean }[] = []
  for (const b of all_) {
    const mentions = mentionsOf.get(b.id) ?? new Set()
    for (const a of all_) {
      if (a.id === b.id) continue
      const mention = [...mentions].some((m) => a.name.toLowerCase() === m || a.name.toLowerCase().includes(m) || m.includes(a.name.toLowerCase()))
      const sim = cosine(kcVec.get(a.id)!, kcVec.get(b.id)!)
      if (!mention && sim < embedder.thresholds.related - 0.1) continue
      const order = (a.firstLecture ?? 0) < (b.firstLecture ?? 0) ? 1 : (a.firstLecture ?? 0) > (b.firstLecture ?? 0) ? -1 : 0
      const refd = refers(a, b) - refers(b, a)
      const score = (mention ? 1 : 0) + 0.6 * order + refd + 0.3 * sim
      if (score > 0.6) prereqCands.push({ a, b, score, mention })
    }
  }
  prereqCands.sort((x, y) => y.score - x.score)
  const toVerify = prereqCands.slice(0, 90)
  const accepted: GraphEdge[] = []
  for (let i = 0; i < toVerify.length; i += 30) {
    if (job.signal.aborted) return finish()
    const batch = toVerify.slice(i, i + 30)
    const data = await ask<{ verdicts: { i: number; prerequisite: boolean; confidence: number; reason: string }[] }>(
      "prerequisites",
      {
        type: "object",
        properties: { verdicts: { type: "array", items: { type: "object", properties: { i: { type: "number" }, prerequisite: { type: "boolean" }, confidence: { type: "number" }, reason: { type: "string" } }, required: ["i", "prerequisite", "confidence"] } } },
        required: ["verdicts"],
      },
      `For each pair, is A a PREREQUISITE of B — do you need to understand A before you can really understand B? Being taught earlier or being related is not enough. Give a confidence 0–1 and a short reason.
${batch.map((p, j) => `${j}. A: ${p.a.name} — ${p.a.definition.slice(0, 140)}\n   B: ${p.b.name} — ${p.b.definition.slice(0, 140)}`).join("\n")}`,
      4000,
    )
    for (const v of data.verdicts ?? []) {
      const p = batch[v.i]
      if (!p || !v.prerequisite || (v.confidence ?? 0) < 0.6) continue
      // Accept only when a structural signal agrees with the model (course order or reference distance).
      const structural = (p.a.firstLecture ?? 0) <= (p.b.firstLecture ?? 0) || refers(p.a, p.b) > refers(p.b, p.a)
      if (structural) accepted.push({ src: p.a.id, dst: p.b.id, type: "prerequisite", weight: Math.round(v.confidence * 100) / 100, method: p.mention ? "llm+mention" : "llm+order", evidence: String(v.reason ?? "").slice(0, 300), status: "accepted" })
    }
  }
  const dag = breakCycles(accepted)

  // Related: k nearest neighbours above the threshold.
  const related: GraphEdge[] = []
  for (const a of all_) {
    const near = all_
      .filter((b) => b.id !== a.id)
      .map((b) => ({ b, sim: cosine(kcVec.get(a.id)!, kcVec.get(b.id)!) }))
      .filter((x) => x.sim >= embedder.thresholds.related)
      .sort((x, y) => y.sim - x.sim)
      .slice(0, 3)
    for (const n of near) related.push({ src: a.id, dst: n.b.id, type: "related", weight: Math.round(n.sim * 100) / 100, method: embedder.kind === "model" ? "embedding" : "lexical", evidence: "", status: "accepted" })
  }
  tx(() => {
    for (const e of [...dag, ...related]) {
      if (e.type === "related" && dag.some((d) => (d.src === e.src && d.dst === e.dst) || (d.src === e.dst && d.dst === e.src))) continue
      ch.edge(e.src, e.dst, e.type)
      graph.setEdge(labId, e)
    }
  })
  job.step(`${dag.length} prerequisites, ${related.length} related links. Tagging questions…`, 0.6)

  /* 6. Q-matrix: question → concepts, wrong option → concept */
  const tagged = new Set(all<{ item_id: string }>("SELECT DISTINCT item_id FROM item_kc WHERE lab_id = ? AND item_kind = 'q'", labId).map((r) => r.item_id))
  const qs = content.questions.filter((q) => !keep || !tagged.has(q.id))
  const qVecs = await embedder.embed(
    qs.map((q) => `${q.stem}\n${q.ans.map((i) => q.opts[i]).join(" ")}`),
    job.signal,
  )
  const confusion = new Map<string, { a: string; b: string; n: number; qids: string[] }>()
  let qDone = 0
  const batches: { q: Question; cands: Kc[] }[][] = []
  for (let i = 0; i < qs.length; i += 15)
    batches.push(
      qs.slice(i, i + 15).map((q, j) => ({
        q,
        cands: all_
          .map((k) => ({ k, sim: cosine(qVecs[i + j], kcVec.get(k.id)!) }))
          .sort((x, y) => y.sim - x.sim)
          .slice(0, 10)
          .map((x) => x.k),
      })),
    )
  await pool(batches, 3, async (batch) => {
    if (job.signal.aborted) return
    const data = await ask<{ items: { qid: string; primary: string; secondary?: string[]; distractors?: Record<string, string>; confidence?: number }[] }>(
      "qmatrix",
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                qid: { type: "string" },
                primary: { type: "string" },
                secondary: { type: "array", items: { type: "string" } },
                distractors: { type: "object", additionalProperties: { type: "string" } },
                confidence: { type: "number" },
              },
              required: ["qid", "primary"],
            },
          },
        },
        required: ["items"],
      },
      `For each question pick, from its candidate concepts, the PRIMARY concept it tests and up to 2 secondary ones. For each WRONG option, name the candidate concept that option actually describes (that is the confusion a learner who picks it is making); omit options that describe no candidate. Give your confidence 0–1. Use only the candidate ids shown.

${batch
  .map(
    ({ q, cands }) =>
      `[${q.id}] ${q.stem.slice(0, 600)}\n${q.opts.map((o2, i) => `  ${i}${q.ans.includes(i) ? " (correct)" : ""}: ${o2.slice(0, 140)}`).join("\n")}\n  candidates: ${cands.map((k) => `${k.id} (${k.name})`).join("; ")}`,
  )
  .join("\n\n")}`,
      6000,
    )
    tx(() => {
      for (const it of data.items ?? []) {
        const b = batch.find((x) => x.q.id === it.qid)
        if (!b) continue
        const ids = new Set(b.cands.map((k) => k.id))
        if (!ids.has(it.primary)) continue
        const conf = Math.max(0, Math.min(1, Number(it.confidence ?? 0.7)))
        ch.itemKc(b.q.id)
        graph.setItemKcs(labId, b.q.id, [
          { kc: it.primary, role: "primary", conf, method: "llm" },
          ...arr(it.secondary)
            .filter((x) => ids.has(x) && x !== it.primary)
            .slice(0, 2)
            .map((kc) => ({ kc, role: "secondary" as const, conf: conf * 0.8, method: "llm" })),
        ])
        const opts: Record<number, string> = {}
        for (const [k, v] of Object.entries(it.distractors ?? {})) {
          const i = Number(k)
          if (Number.isInteger(i) && i < b.q.opts.length && !b.q.ans.includes(i) && ids.has(String(v)) && v !== it.primary) {
            opts[i] = String(v)
            const [x, y] = [it.primary, String(v)].sort()
            const c = confusion.get(`${x}|${y}`) ?? { a: x, b: y, n: 0, qids: [] }
            c.n++
            c.qids.push(b.q.id)
            confusion.set(`${x}|${y}`, c)
          }
        }
        graph.setOptionKcs(labId, b.q.id, opts)
        // Topic-level tags and the question's domain follow its concepts, so every view stays consistent.
        const topicsOf = [it.primary, ...arr(it.secondary)].map((id) => kcs.get(id)?.topic).filter((t): t is string => !!t)
        if (topicsOf.length) {
          ch.question(b.q.id)
          repo.setTags(labId, b.q.id, [...new Set(topicsOf)])
          const t = repo.getTopic(labId, topicsOf[0])
          if (t && t.d > 0 && t.d !== b.q.d) repo.upsertQuestion(labId, { ...b.q, d: t.d })
        }
      }
    })
    qDone += batch.length
    job.step(`Tagging questions (${qDone}/${qs.length})…`, 0.6 + 0.2 * (qDone / Math.max(1, qs.length)))
  })
  // Confusable edges come from distractors: an option that describes B in a question about A.
  tx(() => {
    for (const c of confusion.values()) {
      ch.edge(c.a, c.b, "confusable")
      const prev = graph.getEdge(labId, c.a, c.b, "confusable")
      graph.setEdge(labId, { src: c.a, dst: c.b, type: "confusable", weight: (prev?.weight ?? 0) + c.n, method: "distractor", evidence: `questions: ${c.qids.slice(0, 6).join(", ")}`, status: "accepted" })
    }
  })
  if (job.signal.aborted) return finish()

  /* 7. notes and flashcards per topic, grounded in the topic's chunks, without near-duplicates */
  const topics = repo.readTopics(labId).filter((t) => !keep || !(t.lec.keyPoints.length || t.exam.keyPoints.length))
  const existingCards = repo.readContent(labId).kb.cards
  const cardVecs = await embedder.embed(
    existingCards.map((c) => `${c.f} ${c.b}`),
    job.signal,
  )
  const seenCards: Float32Array[] = [...cardVecs]
  let tDone = 0
  await pool(topics, 3, async (t) => {
    if (job.signal.aborted) return
    const tk = [...kcs.values()].filter((k) => k.topic === t.id)
    const ev = [...new Set(tk.flatMap((k) => k.evidence))]
    let material = ""
    for (const id of ev) {
      const text = chunkText.get(id)
      if (!text) continue
      material += `\n\n[chunk ${id}]\n${text}`
      if (material.length > 50_000) break
    }
    const n = await ask<{
      summary: string[]
      keyPoints: string[]
      examTips: string[]
      pitfalls: string[]
      mnemonics: string[]
      cards: { front: string; back: string; kind: CardKind; why?: string; concept?: string; chunk?: string }[]
    }>(
      "notes",
      {
        type: "object",
        properties: {
          summary: { type: "array", items: { type: "string" } },
          keyPoints: { type: "array", items: { type: "string" } },
          examTips: { type: "array", items: { type: "string" } },
          pitfalls: { type: "array", items: { type: "string" } },
          mnemonics: { type: "array", items: { type: "string" } },
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                front: { type: "string" },
                back: { type: "string" },
                kind: { type: "string", enum: ["fact", "concept", "compare", "scenario", "list", "trigger"] },
                why: { type: "string" },
                concept: { type: "string" },
                chunk: { type: "string" },
              },
              required: ["front", "back", "kind", "chunk"],
            },
          },
        },
        required: ["summary", "keyPoints", "examTips", "pitfalls", "cards"],
      },
      `Write study notes for the topic "${t.title}" (${t.covers}) using ONLY the material below. Return:
- summary: 2–4 sentences;
- keyPoints: 6–15 crisp standalone facts;
- examTips: 3–8 lines like "If the scenario says <cue>, pick <answer> because <reason>";
- pitfalls: 2–6 lines like "Trap: <tempting idea>. Reality: <correct idea>.";
- mnemonics: 0–3 memory hooks;
- cards: ${cardsPerTopic} flashcards (mix concept, compare, scenario, trigger), each with the concept id it tests and the chunk id that supports it. Backs under 40 words.
Concepts in this topic: ${tk.map((k) => `${k.id} (${k.name})`).join("; ") || "(none)"}
${material || "(no transcript for this topic — rely on the concept definitions and say less)"}`,
      10_000,
    )
    // Grounding: a card must cite one of this topic's chunks (when the topic has any material).
    const fresh = (n.cards ?? []).filter((c) => c?.front && c?.back && (!ev.length || ev.includes(String(c.chunk ?? ""))))
    const vecs2 = await embedder.embed(
      fresh.map((c) => `${c.front} ${c.back}`),
      job.signal,
    )
    tx(() => {
      ch.topic(t.id)
      const cur2 = repo.getTopic(labId, t.id) ?? t
      repo.upsertTopic(labId, {
        ...cur2,
        summary: arr(n.summary).slice(0, 6),
        lec: { keyPoints: arr(n.keyPoints).slice(0, 30), examTips: arr(n.examTips).slice(0, 15), pitfalls: arr(n.pitfalls).slice(0, 12) },
        mnemonics: arr(n.mnemonics).slice(0, 5),
      })
      fresh.forEach((c, i) => {
        if (seenCards.some((v) => cosine(v, vecs2[i]) >= embedder.thresholds.duplicate)) return
        seenCards.push(vecs2[i])
        const card: Card = {
          id: `kb-${t.id}-${Date.now().toString(36)}${i}`,
          t: t.id,
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
    tDone++
    job.step(`Writing notes and flashcards (${tDone}/${topics.length})…`, 0.82 + 0.17 * (tDone / Math.max(1, topics.length)))
    emit({ type: "lab-changed", labId, what: ["content"] })
  })
  return finish()

  function finish() {
    tx(() => {
      repo.setBuilt(labId)
      const n = one<{ n: number }>("SELECT COUNT(*) n FROM kcs WHERE lab_id = ? AND status = 'active'", labId)?.n ?? 0
      ch.commit(`Built the knowledge graph: ${n} concepts, their topics, relations, question tags, notes and flashcards (${embedder.kind === "model" ? embedder.model : "lexical similarity"})`)
    })
    emit({ type: "lab-changed", labId, what: ["content", "config"] })
  }
}

/** Keep the prerequisite graph acyclic: drop the weakest edge of each cycle found. */
export function breakCycles(edges: GraphEdge[]): GraphEdge[] {
  const kept = [...edges].sort((a, b) => b.weight - a.weight)
  const out: GraphEdge[] = []
  const next = new Map<string, string[]>()
  const reaches = (a: string, b: string) => {
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
  // Adding strongest-first and skipping any edge that would close a cycle drops each cycle's weakest link.
  for (const e of kept) {
    if (reaches(e.dst, e.src)) continue
    next.set(e.src, [...(next.get(e.src) ?? []), e.dst])
    out.push(e)
  }
  return out
}

