import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { app } from "electron"
import type { EmbeddingDevice, LocalModelStatus } from "@shared/types"

/*
  The local embedding model: EmbeddingGemma 300M (8-bit ONNX), multilingual and the strongest open
  embedder under 500M parameters on MMTEB. Downloaded once from Hugging Face at a pinned revision,
  each file accepted only with its pinned SHA-256, then run with onnxruntime-node on the CPU or,
  when the learner picks it, on a GPU through DirectML (Windows). The ONNX graph already pools and
  normalises, so its `sentence_embedding` output is the vector.
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
    device: device.kind,
    gpu: device.gpu,
    gpus,
    gpuError,
    speed,
  }
}

/* ---------- device ---------- */

// The software rasteriser (WARP): DirectML refuses it, and Windows always lists it last.
const isSoftware = (g: { vendorId: number; deviceId: number }) => g.vendorId === 0x1414 && g.deviceId === 0x8c
const DIRECTML = process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")

let device: { kind: EmbeddingDevice; gpu: number } = { kind: "cpu", gpu: 0 }
let gpus: LocalModelStatus["gpus"] = []
let gpuError: string | undefined
let speed: LocalModelStatus["speed"]

/**
  The GPUs DirectML can use. Chromium lists the adapters in DXGI order, which is DirectML's device
  id, so a GPU's position here is the id to ask for. Returns the index of the high-performance one.
*/
export async function detectGpus(): Promise<number> {
  if (!DIRECTML) return 0
  const info = (await app.getGPUInfo("basic")) as { gpuDevice?: { vendorId: number; deviceId: number; deviceString?: string; gpuPreference?: number }[] }
  // gpuPreference 3 is Chromium's "high performance": the discrete GPU on a laptop with two.
  gpus = (info.gpuDevice ?? []).filter((g) => !isSoftware(g)).map((g, i) => ({ name: g.deviceString || `GPU ${i + 1}`, highPerformance: g.gpuPreference === 3 }))
  return Math.max(0, gpus.findIndex((g) => g.highPerformance))
}

/**
  Where the model runs from now on; the same choice again retries a GPU that failed. A session
  already open is released once its calls end.
*/
export function setLocalDevice(kind: EmbeddingDevice, gpu: number) {
  const next = { kind: DIRECTML ? kind : "cpu", gpu }
  if (next.kind === device.kind && next.gpu === device.gpu && !gpuError) return
  device = next
  gpuError = undefined
  void retire()
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
  await retire()
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
  on: EmbeddingDevice
  /** calls using the session, which is released only once they end */
  runs: number
  retired: boolean
}

let loaded: Promise<Loaded> | null = null
let idle: ReturnType<typeof setTimeout> | null = null
// The session holds a few hundred MB; let it go once the builder has been quiet for a while.
const IDLE_MS = 3 * 60_000

// DirectML's errors carry the source path and an HRESULT ahead of the message.
const gpuMessage = (e: unknown) => {
  const msg = (e as Error).message ?? String(e)
  return (/\b[0-9A-F]{8}\s+(.+)$/s.exec(msg)?.[1] ?? msg).trim()
}

async function load(): Promise<Loaded> {
  const dir = modelDir()
  const ort = await import("onnxruntime-node")
  const { Tokenizer } = await import("@huggingface/tokenizers")
  const tokenizer = new Tokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")), JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")))
  const file = join(dir, "onnx", "model_quantized.onnx")
  // No memory arena: a little slower, and well under half the resident memory.
  const cpu = { executionProviders: ["cpu"], graphOptimizationLevel: "all", enableCpuMemArena: false } as const
  if (device.kind === "gpu" && !gpuError) {
    try {
      // DirectML runs operators one at a time and plans its own memory; the few it lacks run on the
      // CPU (the warning saying so is muted).
      const session = await ort.InferenceSession.create(file, { ...cpu, executionProviders: [{ name: "dml", deviceId: device.gpu }], enableMemPattern: false, executionMode: "sequential", logSeverityLevel: 3 })
      return { ort, session, tokenizer, on: "gpu", runs: 0, retired: false }
    } catch (e) {
      gpuError = gpuMessage(e)
    }
  }
  const session = await ort.InferenceSession.create(file, cpu)
  return { ort, session, tokenizer, on: "cpu", runs: 0, retired: false }
}

/** Drop the open session: the next call loads a new one, and this one goes once its calls end. */
function retire(): Promise<void> {
  if (idle) clearTimeout(idle)
  idle = null
  const l = loaded
  loaded = null
  return (l ?? Promise.resolve(null))
    .then(async (x) => {
      if (!x) return
      x.retired = true
      if (x.runs === 0) await x.session.release()
    })
    .catch(() => undefined)
}

async function acquire(): Promise<Loaded> {
  for (;;) {
    const p = (loaded ??= load().catch((e) => {
      loaded = null
      throw e
    }))
    const l = await p
    // Retired while loading (the device changed): load again for the new one.
    if (loaded !== p) continue
    l.runs++
    return l
  }
}

function done(l: Loaded) {
  l.runs--
  if (l.retired && l.runs === 0) void l.session.release().catch(() => undefined)
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => void retire(), IDLE_MS)
  idle.unref?.()
}

// DirectML takes one run at a time per session, and on the CPU one run already uses every core.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn)
  queue = p.catch(() => undefined)
  return p
}

/** Unit vectors for `texts`, shortest first in batches so padding stays small, returned in order. */
export async function embedLocal(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  if (!isInstalled()) throw new Error("The local embedding model is not downloaded.")
  const l = await acquire()
  try {
    return await serial(() => run(l, texts, signal))
  } catch (e) {
    if (signal?.aborted || l.on !== "gpu") throw e
    // A GPU that fails mid-build (driver reset, out of memory) hands the work to the CPU until the
    // device setting changes.
    gpuError = gpuMessage(e)
    void retire()
    return embedLocal(texts, signal)
  } finally {
    done(l)
  }
}

async function run({ ort, session, tokenizer, on }: Loaded, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const max = LOCAL_MODEL.maxTokens
  // Larger batches keep a GPU busy; on the CPU they only cost memory.
  const size = on === "gpu" ? 32 : 8
  const ids = texts.map((t) => {
    const e = tokenizer.encode(LOCAL_MODEL.prefix + (t || " ")).ids
    // Keep the end-of-sequence token when cutting a long text.
    return e.length > max ? [...e.slice(0, max - 1), e[e.length - 1]] : e
  })
  const order = ids.map((_, i) => i).sort((a, b) => ids[a].length - ids[b].length)
  const out: Float32Array[] = new Array(texts.length)
  const start = performance.now()
  for (let s = 0; s < order.length; s += size) {
    if (signal?.aborted) throw new Error("Cancelled.")
    const batch = order.slice(s, s + size)
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
  if (texts.length >= 64) speed = { device: on, perSecond: Math.round((texts.length * 1000) / (performance.now() - start)) }
  return out
}
