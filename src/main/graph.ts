import type { EdgeType, GraphEdge, Kc, KnowledgeGraph } from "@shared/types"
import { all, one, run } from "./db"
import * as repo from "./repo"

/*
  The knowledge graph: knowledge components (KCs) under topics, typed edges between KCs, the
  Q-matrix (question → KCs) and the KC each wrong option describes. Labs built before KCs existed
  get a topic-level graph instead, so the learner model and planner work for every lab.
*/

interface KcRow {
  id: string
  topic_id: string | null
  name: string
  definition: string
  kind: Kc["kind"]
  status: Kc["status"]
  first_lecture: number | null
  evidence: string
}

const toKc = (r: KcRow): Kc => ({
  id: r.id,
  topic: r.topic_id,
  name: r.name,
  definition: r.definition,
  kind: r.kind,
  status: r.status,
  firstLecture: r.first_lecture ?? undefined,
  evidence: JSON.parse(r.evidence || "[]"),
})

export function hasKcs(labId: string): boolean {
  return (one<{ n: number }>("SELECT COUNT(*) n FROM kcs WHERE lab_id = ? AND status = 'active'", labId)?.n ?? 0) > 0
}

export function readGraph(labId: string): KnowledgeGraph {
  if (!hasKcs(labId)) return topicGraph(labId)
  const kcs = all<KcRow>("SELECT * FROM kcs WHERE lab_id = ? AND status = 'active' ORDER BY first_lecture, created", labId).map(toKc)
  const edges = all<GraphEdge>("SELECT src, dst, type, weight, method, evidence, status FROM edges WHERE lab_id = ? AND status != 'rejected'", labId)
  const itemKc: KnowledgeGraph["itemKc"] = {}
  for (const r of all<{ item_id: string; kc_id: string; role: "primary" | "secondary" }>(
    "SELECT item_id, kc_id, role FROM item_kc WHERE lab_id = ? AND item_kind = 'q' ORDER BY role DESC, conf DESC",
    labId,
  )) {
    ;(itemKc[r.item_id] ??= []).push({ kc: r.kc_id, role: r.role })
  }
  const optionKc: KnowledgeGraph["optionKc"] = {}
  for (const r of all<{ qid: string; option: number; kc_id: string }>("SELECT qid, option, kc_id FROM option_kc WHERE lab_id = ?", labId)) {
    ;(optionKc[r.qid] ??= {})[r.option] = r.kc_id
  }
  return { kcs, edges, itemKc, optionKc, topicLevel: false }
}

/** Topics stand in for KCs: questions keep their topic tags, topic prereq/confusable fields become edges. */
function topicGraph(labId: string): KnowledgeGraph {
  const content = { kb: { topics: repo.readTopics(labId), tags: repo.getTags(labId) } }
  const firstLecture = (lecs: number[]) => (lecs.length ? Math.min(...lecs) : undefined)
  const kcs: Kc[] = content.kb.topics.map((t) => ({
    id: t.id,
    topic: t.id,
    name: t.title,
    definition: t.covers,
    kind: "concept",
    status: "active",
    firstLecture: firstLecture(t.lectures),
    evidence: [],
  }))
  const ids = new Set(kcs.map((k) => k.id))
  const edges: GraphEdge[] = []
  for (const t of content.kb.topics) {
    for (const p of t.prereq ?? []) if (ids.has(p)) edges.push({ src: p, dst: t.id, type: "prerequisite", weight: 1, method: "topic", evidence: "", status: "accepted" })
    for (const c of t.confusable ?? []) if (ids.has(c) && c !== t.id) edges.push({ src: t.id, dst: c, type: "confusable", weight: 1, method: "topic", evidence: "", status: "accepted" })
  }
  const itemKc: KnowledgeGraph["itemKc"] = {}
  for (const [qid, ts] of Object.entries(content.kb.tags)) itemKc[qid] = ts.filter((t) => ids.has(t)).map((kc, i) => ({ kc, role: i === 0 ? "primary" : "secondary" }))
  return { kcs, edges, itemKc, optionKc: {}, topicLevel: true }
}

/* ---------- writes (callers journal them) ---------- */

export function getKc(labId: string, id: string): Kc | null {
  const r = one<KcRow>("SELECT * FROM kcs WHERE lab_id = ? AND id = ?", labId, id)
  return r ? toKc(r) : null
}

export function upsertKc(labId: string, k: Kc, embedding?: Float32Array | null) {
  run(
    `INSERT INTO kcs(lab_id, id, topic_id, name, definition, kind, status, first_lecture, evidence, embedding, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lab_id, id) DO UPDATE SET topic_id = excluded.topic_id, name = excluded.name, definition = excluded.definition, kind = excluded.kind,
       status = excluded.status, first_lecture = excluded.first_lecture, evidence = excluded.evidence, embedding = COALESCE(excluded.embedding, kcs.embedding)`,
    labId,
    k.id,
    k.topic,
    k.name,
    k.definition,
    k.kind,
    k.status,
    k.firstLecture ?? null,
    JSON.stringify(k.evidence.slice(0, 40)),
    embedding ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null,
    Date.now(),
  )
}

export function deleteKc(labId: string, id: string) {
  run("DELETE FROM kcs WHERE lab_id = ? AND id = ?", labId, id)
  run("DELETE FROM edges WHERE lab_id = ? AND (src = ? OR dst = ?)", labId, id, id)
  run("DELETE FROM item_kc WHERE lab_id = ? AND kc_id = ?", labId, id)
  run("DELETE FROM option_kc WHERE lab_id = ? AND kc_id = ?", labId, id)
}

export function kcEmbedding(labId: string, id: string): Float32Array | null {
  const r = one<{ embedding: Uint8Array | null }>("SELECT embedding FROM kcs WHERE lab_id = ? AND id = ?", labId, id)
  return r?.embedding ? new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)) : null
}

export function allKcEmbeddings(labId: string): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  for (const r of all<{ id: string; embedding: Uint8Array | null }>("SELECT id, embedding FROM kcs WHERE lab_id = ? AND status = 'active'", labId)) {
    if (r.embedding) out.set(r.id, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)))
  }
  return out
}

/** Undirected types are stored once, with src < dst. */
export function edgeKey(src: string, dst: string, type: EdgeType): [string, string] {
  return type === "prerequisite" || type === "example_of" ? [src, dst] : src < dst ? [src, dst] : [dst, src]
}

export function getEdge(labId: string, src: string, dst: string, type: EdgeType): GraphEdge | null {
  const [a, b] = edgeKey(src, dst, type)
  return one<GraphEdge>("SELECT src, dst, type, weight, method, evidence, status FROM edges WHERE lab_id = ? AND src = ? AND dst = ? AND type = ?", labId, a, b, type) ?? null
}

export function setEdge(labId: string, e: GraphEdge) {
  const [a, b] = edgeKey(e.src, e.dst, e.type)
  run(
    `INSERT INTO edges(lab_id, src, dst, type, weight, method, evidence, status, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lab_id, src, dst, type) DO UPDATE SET weight = excluded.weight, method = excluded.method, evidence = excluded.evidence, status = excluded.status`,
    labId,
    a,
    b,
    e.type,
    e.weight,
    e.method,
    e.evidence.slice(0, 600),
    e.status,
    Date.now(),
  )
}

export function deleteEdge(labId: string, src: string, dst: string, type: EdgeType) {
  const [a, b] = edgeKey(src, dst, type)
  run("DELETE FROM edges WHERE lab_id = ? AND src = ? AND dst = ? AND type = ?", labId, a, b, type)
}

export function getItemKcs(labId: string, qid: string): { kc: string; role: string; conf: number; method: string }[] {
  return all("SELECT kc_id kc, role, conf, method FROM item_kc WHERE lab_id = ? AND item_kind = 'q' AND item_id = ?", labId, qid)
}

export function setItemKcs(labId: string, qid: string, kcs: { kc: string; role: "primary" | "secondary"; conf: number; method: string }[]) {
  run("DELETE FROM item_kc WHERE lab_id = ? AND item_kind = 'q' AND item_id = ?", labId, qid)
  for (const k of kcs) run("INSERT OR REPLACE INTO item_kc(lab_id, item_kind, item_id, kc_id, role, conf, method) VALUES(?, 'q', ?, ?, ?, ?, ?)", labId, qid, k.kc, k.role, k.conf, k.method)
}

export function getOptionKcs(labId: string, qid: string): Record<number, string> {
  const out: Record<number, string> = {}
  for (const r of all<{ option: number; kc_id: string }>("SELECT option, kc_id FROM option_kc WHERE lab_id = ? AND qid = ?", labId, qid)) out[r.option] = r.kc_id
  return out
}

export function setOptionKcs(labId: string, qid: string, map: Record<number, string>) {
  run("DELETE FROM option_kc WHERE lab_id = ? AND qid = ?", labId, qid)
  for (const [opt, kc] of Object.entries(map)) run("INSERT OR REPLACE INTO option_kc(lab_id, qid, option, kc_id) VALUES(?, ?, ?, ?)", labId, qid, Number(opt), kc)
}
