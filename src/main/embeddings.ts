import { getSetting } from "./db"
import { readKey } from "./openrouter"
import { logAiCall } from "./repo"

/*
  Text embeddings for the knowledge graph (similarity, deduplication, candidate search).
  OpenRouter's /embeddings endpoint when a key is set; otherwise, or if it fails, a local lexical
  vector (hashed TF with log weighting) so building still works offline, with stricter thresholds.
*/

export const DEFAULT_EMBEDDING_MODEL = "baai/bge-m3"
const DIM_LEXICAL = 1024

export type EmbeddingKind = "model" | "lexical"

export interface Embedder {
  kind: EmbeddingKind
  model: string
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  /** cosine thresholds: merge automatically above `high`, ask the LLM between `low` and `high` */
  thresholds: { high: number; low: number; related: number; duplicate: number }
}

export function embeddingModel(): string {
  return getSetting("ai.embeddingModel", DEFAULT_EMBEDDING_MODEL)
}

const STOP = new Set(
  "the and for are with that this from your you can not use uses used into when what which their there then than also have has had was were will would should could may might must each other more most such only both any all some how why who its it's our out about over under between within without after before while very just like a an of to in on by or as at be is it no de da do das dos em um uma para por com que os as se na no nas nos é ao à".split(
    " ",
  ),
)

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOP.has(t))
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function lexicalVector(text: string): Float32Array {
  const v = new Float32Array(DIM_LEXICAL)
  const ts = tokens(text)
  const counts = new Map<string, number>()
  for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1)
  // Unigrams plus bigrams, so "object storage" differs from "storage object classes".
  for (let i = 0; i + 1 < ts.length; i++) {
    const b = `${ts[i]}_${ts[i + 1]}`
    counts.set(b, (counts.get(b) ?? 0) + 0.5)
  }
  for (const [t, c] of counts) {
    const h = hash(t)
    v[h % DIM_LEXICAL] += (h & 1 ? 1 : -1) * (1 + Math.log(c))
  }
  return normalize(v)
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

const lexical: Embedder = {
  kind: "lexical",
  model: "lexical-hash-1024",
  thresholds: { high: 0.8, low: 0.6, related: 0.55, duplicate: 0.85 },
  async embed(texts) {
    return texts.map(lexicalVector)
  },
}

function modelEmbedder(model: string, key: string, labId: string | null): Embedder {
  return {
    kind: "model",
    model,
    thresholds: { high: 0.9, low: 0.8, related: 0.75, duplicate: 0.92 },
    async embed(texts, signal) {
      const out: Float32Array[] = []
      for (let i = 0; i < texts.length; i += 64) {
        const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 6000) || " ")
        const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/protonspy/study-lab", "X-Title": "Study Lab" },
          body: JSON.stringify({ model, input: batch }),
          signal,
        })
        if (!res.ok) throw new Error(`Embeddings failed: HTTP ${res.status}`)
        const body = (await res.json()) as { data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number; cost?: number } }
        if (!body.data?.length) throw new Error("Embeddings returned no vectors.")
        const sorted = [...body.data].sort((a, b) => a.index - b.index)
        for (const d of sorted) out.push(normalize(Float32Array.from(d.embedding)))
        logAiCall(labId, "embeddings", model, body.usage?.prompt_tokens ?? 0, 0, body.usage?.cost ?? 0)
      }
      return out
    },
  }
}

/** The model embedder when it works (probed once), the lexical one otherwise. */
export async function getEmbedder(labId: string | null, signal?: AbortSignal): Promise<Embedder> {
  const key = readKey()
  if (!key) return lexical
  const e = modelEmbedder(embeddingModel(), key, labId)
  try {
    await e.embed(["probe"], signal)
    return e
  } catch {
    return lexical
  }
}

export const lexicalEmbedder = lexical

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

export function fromBlob(b: Uint8Array | null | undefined): Float32Array | null {
  if (!b) return null
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
