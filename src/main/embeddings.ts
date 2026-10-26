import type { EmbeddingSource } from "@shared/types"
import { getSetting } from "./db"
import { downloadLocalModel, embedLocal, LOCAL_MODEL, localModelStatus } from "./localEmbed"
import { readKey } from "./openrouter"
import { logAiCall } from "./repo"

/*
  Text embeddings for the knowledge graph (similarity, deduplication, candidate search).
  By default the local model (localEmbed.ts), downloaded on first use; or OpenRouter's /embeddings
  endpoint with a key. When neither works, a lexical vector (hashed TF with log weighting) so
  building still works offline, with stricter thresholds.
*/

export const DEFAULT_EMBEDDING_MODEL = "baai/bge-m3"
const DIM_LEXICAL = 1024

export type EmbeddingKind = "model" | "lexical"

export function embeddingSource(): EmbeddingSource {
  return getSetting<EmbeddingSource>("ai.embeddings", "local")
}

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

const MAX_ATTEMPTS = 6

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled."))
    const t = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", stop)
      resolve()
    }
    function stop() {
      clearTimeout(t)
      reject(new Error("Cancelled."))
    }
    signal?.addEventListener("abort", stop, { once: true })
  })
}

/** Retry-After (seconds or an HTTP date) when the provider sends one, else exponential backoff with jitter, capped at 60 s. */
export function backoffMs(attempt: number, retryAfter: string | null): number {
  const secs = retryAfter != null ? Number(retryAfter) : NaN
  const hinted = Number.isFinite(secs) ? secs * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 60_000)
  return Math.min(2000 * 2 ** attempt * (0.75 + Math.random() * 0.5), 60_000)
}

/**
  One batch, retried on rate limits and server errors. A build can't fall back to lexical vectors halfway
  (they live in another space), so a 429 mid-build is waited out instead of failing the whole job.
*/
async function postBatch(model: string, key: string, input: string[], signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/protonspy/study-lab", "X-Title": "Study Lab" },
      body: JSON.stringify({ model, input }),
      signal,
    })
    if (res.ok) return (await res.json()) as { data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number; cost?: number } }
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt + 1 >= MAX_ATTEMPTS) {
      if (res.status === 429) throw new Error(`Embeddings are rate-limited by OpenRouter (HTTP 429) after ${MAX_ATTEMPTS} tries. Wait a few minutes and build again.`)
      if (res.status === 402) throw new Error("Your OpenRouter account is out of credits.")
      throw new Error(`Embeddings failed: HTTP ${res.status}`)
    }
    await wait(backoffMs(attempt, res.headers.get("retry-after")), signal)
  }
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
        const body = await postBatch(model, key, batch, signal)
        if (!body.data?.length) throw new Error("Embeddings returned no vectors.")
        const sorted = [...body.data].sort((a, b) => a.index - b.index)
        for (const d of sorted) out.push(normalize(Float32Array.from(d.embedding)))
        logAiCall(labId, "embeddings", model, body.usage?.prompt_tokens ?? 0, 0, body.usage?.cost ?? 0)
      }
      return out
    },
  }
}

/*
  Calibrated on paraphrases (0.84–0.91, across Portuguese and English too), related concepts
  (0.58–0.72) and unrelated ones (0.32–0.46): EmbeddingGemma's scale sits lower than bge-m3's.
*/
const local: Embedder = {
  kind: "model",
  model: `${LOCAL_MODEL.name} (local)`,
  thresholds: { high: 0.88, low: 0.76, related: 0.62, duplicate: 0.9 },
  embed: (texts, signal) => embedLocal(texts, signal),
}

/**
  The embedder for a build: the local model (downloading it first if needed, `onStep` tells the
  progress), or OpenRouter's when chosen and it answers a probe; the lexical one when neither works.
*/
export async function getEmbedder(labId: string | null, signal?: AbortSignal, onStep?: (text: string) => void): Promise<Embedder> {
  if (embeddingSource() === "local") {
    try {
      if (localModelStatus().state !== "ready") {
        const mb = Math.round(localModelStatus().size / 1e6)
        onStep?.(`Downloading the local embedding model (${mb} MB, once)…`)
        await downloadLocalModel(signal, (p) => onStep?.(`Downloading the local embedding model (${Math.round(p * 100)}% of ${mb} MB, once)…`))
      }
      await local.embed(["probe"], signal)
      return local
    } catch {
      if (signal?.aborted) throw new Error("Cancelled.")
      return lexical
    }
  }
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
