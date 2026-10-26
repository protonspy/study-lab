import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { app } from "electron"
import type { LocalModelStatus } from "@shared/types"

/*
  The local embedding model: EmbeddingGemma 300M (8-bit ONNX), multilingual and the strongest open
  embedder under 500M parameters on MMTEB. Downloaded once from Hugging Face at a pinned revision,
  each file accepted only with its pinned SHA-256, then run on the CPU with onnxruntime-node. The
  ONNX graph already pools and normalises, so its `sentence_embedding` output is the vector.
*/

export const LOCAL_MODEL = {
  id: "embeddinggemma-300m-q8",
  name: "EmbeddingGemma 300M",
  repo: "onnx-community/embeddinggemma-300m-ONNX",
  revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
  /** symmetric similarity: the builder compares concepts, chunks and cards with each other */
  prefix: "task: sentence similarity | query: ",
  maxTokens: 768,
  files: [
    { path: "tokenizer.json", sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47", size: 20323312 },
    { path: "tokenizer_config.json", sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a", size: 1156830 },
    { path: "onnx/model_quantized.onnx", sha256: "172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8", size: 567874 },
    { path: "onnx/model_quantized.onnx_data", sha256: "705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0", size: 308890624 },
  ],
}

const TOTAL = LOCAL_MODEL.files.reduce((n, f) => n + f.size, 0)

export function modelDir(): string {
  const root = process.env.STUDY_LAB_MODELS ?? join(app.getPath("userData"), "models")
  return join(root, LOCAL_MODEL.id, LOCAL_MODEL.revision.slice(0, 12))
}

const isInstalled = () => LOCAL_MODEL.files.every((f) => existsSync(join(modelDir(), f.path)))

let downloading: { progress: number; promise: Promise<void>; ctrl: AbortController; listeners: Set<(p: number) => void> } | null = null
let lastError: string | undefined
let onChange: (s: LocalModelStatus) => void = () => undefined

export function onLocalModelChange(fn: (s: LocalModelStatus) => void) {
  onChange = fn
}

export function localModelStatus(): LocalModelStatus {
  return {
    name: LOCAL_MODEL.name,
    size: TOTAL,
    state: downloading ? "downloading" : isInstalled() ? "ready" : lastError ? "failed" : "missing",
    progress: downloading?.progress,
    error: downloading ? undefined : lastError,
  }
}

async function fetchFile(f: (typeof LOCAL_MODEL.files)[number], target: string, signal: AbortSignal, onBytes: (n: number) => void) {
  const url = `https://huggingface.co/${LOCAL_MODEL.repo}/resolve/${LOCAL_MODEL.revision}/${f.path}`
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Downloading ${f.path} failed: HTTP ${res.status}.`)
  const hash = createHash("sha256")
  let size = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      size += chunk.length
      if (size > f.size) return done(new Error(`${f.path} is larger than the pinned file.`))
      onBytes(chunk.length)
      done(null, chunk)
    },
  })
  const partial = `${target}.partial`
  mkdirSync(dirname(target), { recursive: true })
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), count, createWriteStream(partial))
    if (hash.digest("hex") !== f.sha256) throw new Error(`${f.path} does not match the pinned model.`)
    renameSync(partial, target)
  } finally {
    rmSync(partial, { force: true })
  }
}

/** Download what is missing, verifying every file. Concurrent callers share one download. */
export function downloadLocalModel(signal?: AbortSignal, onProgress?: (p: number) => void): Promise<void> {
  if (isInstalled()) return Promise.resolve()
  if (!downloading) {
    const ctrl = new AbortController()
    const state = { progress: 0, ctrl, promise: Promise.resolve(), listeners: new Set<(p: number) => void>() }
    let done = 0
    let pct = -1
    const tick = (n: number) => {
      done += n
      state.progress = done / TOTAL
      if (Math.floor(state.progress * 100) !== pct) {
        pct = Math.floor(state.progress * 100)
        onChange(localModelStatus())
        for (const l of state.listeners) l(state.progress)
      }
    }
    state.promise = (async () => {
      lastError = undefined
      for (const f of LOCAL_MODEL.files) {
        const target = join(modelDir(), f.path)
        if (existsSync(target)) tick(f.size)
        else await fetchFile(f, target, ctrl.signal, tick)
      }
    })()
      .catch((e: Error) => {
        lastError = ctrl.signal.aborted ? undefined : e.message
        throw ctrl.signal.aborted ? new Error("Cancelled.") : e
      })
      .finally(() => {
        downloading = null
        onChange(localModelStatus())
      })
    downloading = state
    onChange(localModelStatus())
  }
  const d = downloading
  signal?.addEventListener("abort", () => d.ctrl.abort(), { once: true })
  if (onProgress) {
    d.listeners.add(onProgress)
    void d.promise.catch(() => undefined).finally(() => d.listeners.delete(onProgress))
  }
  return d.promise
}

export function cancelLocalModelDownload() {
  downloading?.ctrl.abort()
}

export async function removeLocalModel() {
  cancelLocalModelDownload()
  await unload()
  rmSync(join(modelDir(), ".."), { recursive: true, force: true })
  lastError = undefined
  onChange(localModelStatus())
}

/* ---------- inference ---------- */

type Ort = typeof import("onnxruntime-node")
interface Loaded {
  ort: Ort
  session: import("onnxruntime-node").InferenceSession
  tokenizer: import("@huggingface/tokenizers").Tokenizer
}

let loaded: Promise<Loaded> | null = null
let idle: ReturnType<typeof setTimeout> | null = null
// The session holds a few hundred MB; let it go once the builder has been quiet for a while.
const IDLE_MS = 3 * 60_000

async function load(): Promise<Loaded> {
  const dir = modelDir()
  const ort = await import("onnxruntime-node")
  const { Tokenizer } = await import("@huggingface/tokenizers")
  const tokenizer = new Tokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")), JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")))
  // No memory arena: a little slower, and well under half the resident memory.
  const session = await ort.InferenceSession.create(join(dir, "onnx", "model_quantized.onnx"), { executionProviders: ["cpu"], graphOptimizationLevel: "all", enableCpuMemArena: false })
  return { ort, session, tokenizer }
}

async function unload() {
  if (idle) clearTimeout(idle)
  idle = null
  const l = loaded
  loaded = null
  if (l) await (await l.catch(() => null))?.session.release()
}

function touch() {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => void unload(), IDLE_MS)
  idle.unref?.()
}

/** Unit vectors for `texts`, shortest first in batches so padding stays small, returned in order. */
export async function embedLocal(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  if (!isInstalled()) throw new Error("The local embedding model is not downloaded.")
  loaded ??= load().catch((e) => {
    loaded = null
    throw e
  })
  const { ort, session, tokenizer } = await loaded
  const max = LOCAL_MODEL.maxTokens
  const ids = texts.map((t) => {
    const e = tokenizer.encode(LOCAL_MODEL.prefix + (t || " ")).ids
    // Keep the end-of-sequence token when cutting a long text.
    return e.length > max ? [...e.slice(0, max - 1), e[e.length - 1]] : e
  })
  const order = ids.map((_, i) => i).sort((a, b) => ids[a].length - ids[b].length)
  const out: Float32Array[] = new Array(texts.length)
  for (let s = 0; s < order.length; s += 8) {
    if (signal?.aborted) throw new Error("Cancelled.")
    const batch = order.slice(s, s + 8)
    const len = Math.max(...batch.map((i) => ids[i].length))
    const inp = new BigInt64Array(batch.length * len)
    const mask = new BigInt64Array(batch.length * len)
    batch.forEach((i, r) => {
      ids[i].forEach((id, j) => {
        inp[r * len + j] = BigInt(id)
        mask[r * len + j] = 1n
      })
    })
    const res = await session.run({ input_ids: new ort.Tensor("int64", inp, [batch.length, len]), attention_mask: new ort.Tensor("int64", mask, [batch.length, len]) })
    const v = res.sentence_embedding
    const dim = v.dims[1]
    const data = v.data as Float32Array
    batch.forEach((i, r) => {
      out[i] = data.slice(r * dim, (r + 1) * dim)
    })
  }
  touch()
  return out
}
