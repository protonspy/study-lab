import { safeStorage } from "electron"
import { DEFAULT_MODEL } from "@shared/defaults"
import type { ModelInfo } from "@shared/types"
import { getSetting, setSetting } from "./db"
import { logAiCall } from "./repo"

const BASE = "https://openrouter.ai/api/v1"

/* ---------- key, kept encrypted with the OS keychain (DPAPI on Windows) ---------- */

let cachedKey: string | null = null

/** Decrypt the stored key once at startup; afterwards readKey() is a cheap synchronous read. */
export async function initKey() {
  const v = getSetting<{ enc: boolean; v: string } | null>("openrouter.key", null)
  if (!v) {
    cachedKey = null
    return
  }
  try {
    const buf = Buffer.from(v.v, "base64")
    cachedKey = v.enc ? (await safeStorage.decryptStringAsync(buf)).result : buf.toString()
  } catch {
    cachedKey = null
  }
}

export async function saveKey(key: string | null) {
  if (!key) {
    setSetting("openrouter.key", null)
    cachedKey = null
    return
  }
  const trimmed = key.trim()
  const value = (await safeStorage.isAsyncEncryptionAvailable())
    ? { enc: true, v: (await safeStorage.encryptStringAsync(trimmed)).toString("base64") }
    : { enc: false, v: Buffer.from(trimmed).toString("base64") }
  setSetting("openrouter.key", value)
  cachedKey = trimmed
}

export function readKey(): string | null {
  return cachedKey
}

/** Turn provider errors into something a learner can act on. */
export function friendlyAiError(e: unknown): Error {
  const err = e as { statusCode?: number; status?: number; message?: string; name?: string }
  const status = err?.statusCode ?? err?.status
  const msg = String(err?.message ?? e)
  if (status === 401 || err?.name === "OpenRouterAuthError" || /user not found|invalid api key|no auth credentials/i.test(msg))
    return new AiError("OpenRouter rejected the API key. Reconnect in Settings → AI coach.", 401)
  if (status === 402 || /insufficient credits|payment required/i.test(msg)) return new AiError("Your OpenRouter account is out of credits.", 402)
  if (status === 429) return new AiError("OpenRouter is rate-limiting this model right now. Try again in a minute or pick another model.", 429)
  if (/no endpoints found.*tool/i.test(msg)) return new AiError("This model has no provider that supports tool calling right now. Pick another model in Settings → AI coach.")
  if ((e as Error)?.name === "AbortError" || /aborted/i.test(msg)) return new AiError("Cancelled.")
  return e instanceof Error ? e : new Error(msg)
}

export function keyHint(): string {
  const k = readKey()
  return k ? `${k.slice(0, 8)}…${k.slice(-4)}` : ""
}

export function currentModel(): string {
  return getSetting("ai.model", DEFAULT_MODEL)
}

/* ---------- models ---------- */

let modelCache: { at: number; list: ModelInfo[] } | null = null

/** The agent harness needs tool calling and text output; it is happier with a wide context, forced tool choice and JSON mode. */
export const MIN_CONTEXT = 64_000

interface RawModel {
  id: string
  name: string
  context_length: number
  pricing: { prompt: string; completion: string }
  supported_parameters?: string[]
  architecture?: { output_modalities?: string[] }
}

export function harnessFit(m: RawModel): Pick<ModelInfo, "fit" | "notes" | "tools" | "structured"> {
  const p = new Set(m.supported_parameters ?? [])
  const tools = p.has("tools")
  const structured = p.has("structured_outputs") || p.has("response_format")
  const textOut = !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text")
  const notes: string[] = []
  if (!tools) notes.push("no tool calling: the coach cannot read your data or act")
  if (!textOut) notes.push("does not output text")
  if (m.context_length < MIN_CONTEXT) notes.push(`small context (${Math.round(m.context_length / 1000)}k): long sessions get trimmed`)
  if (tools && !p.has("tool_choice")) notes.push("cannot force a tool call")
  if (!structured) notes.push("no JSON mode: knowledge-base building retries more often")
  const fit = !tools || !textOut ? "unsupported" : notes.length ? "limited" : "ready"
  return { fit, notes, tools, structured }
}

export async function listModels(force = false): Promise<ModelInfo[]> {
  if (!force && modelCache && Date.now() - modelCache.at < 3600_000) return modelCache.list
  const res = await fetch(`${BASE}/models`)
  if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status} for the model list.`)
  const body = (await res.json()) as { data: RawModel[] }
  const list = body.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context_length,
      inPrice: Number(m.pricing?.prompt ?? 0) * 1e6,
      outPrice: Number(m.pricing?.completion ?? 0) * 1e6,
      ...harnessFit(m),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  modelCache = { at: Date.now(), list }
  return list
}

async function priceOf(model: string): Promise<{ inPrice: number; outPrice: number } | null> {
  try {
    return (await listModels()).find((m) => m.id === model) ?? null
  } catch {
    return null
  }
}

/* ---------- chat completions ---------- */

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ToolDef {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatRequest {
  messages: Msg[]
  tools?: ToolDef[]
  json?: { name: string; schema: Record<string, unknown> } | "object"
  temperature?: number
  maxTokens?: number
  model?: string
  signal?: AbortSignal
  /** for the usage log */
  task: string
  labId?: string | null
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: ToolCall[] }
  finish: string
  usage: { tokensIn: number; tokensOut: number; cost: number }
  model: string
}

export class AiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const key = readKey()
  if (!key) throw new AiError("Add your OpenRouter API key in Settings → AI coach first.")
  const model = req.model ?? currentModel()
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    temperature: req.temperature ?? 0.3,
    usage: { include: true },
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.tools?.length) body.tools = req.tools
  if (req.json === "object") body.response_format = { type: "json_object" }
  else if (req.json) body.response_format = { type: "json_schema", json_schema: { name: req.json.name, strict: false, schema: req.json.schema } }

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (req.signal?.aborted) throw new AiError("Cancelled.")
    try {
      const timeout = AbortSignal.timeout(240_000)
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/protonspy/study-lab",
          "X-Title": "Study Lab",
        },
        body: JSON.stringify(body),
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      })
      const text = await res.text()
      let data: {
        choices?: { message: ChatResult["message"]; finish_reason: string }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
        error?: { message?: string; code?: number }
        model?: string
      }
      try {
        data = JSON.parse(text)
      } catch {
        throw new AiError(`OpenRouter sent an unreadable reply (HTTP ${res.status}).`, res.status)
      }
      if (!res.ok || data.error) {
        const msg = data.error?.message ?? `HTTP ${res.status}`
        const status = res.status || data.error?.code
        if (status === 429 || (status && status >= 500)) {
          lastErr = new AiError(`OpenRouter: ${msg}`, status)
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
          continue
        }
        if (status === 401) throw new AiError("OpenRouter rejected the API key. Check it in Settings → AI coach.", 401)
        if (status === 402) throw new AiError("Your OpenRouter account is out of credits.", 402)
        throw new AiError(`OpenRouter: ${msg}`, status)
      }
      const choice = data.choices?.[0]
      if (!choice) throw new AiError("OpenRouter returned no answer.")
      const tokensIn = data.usage?.prompt_tokens ?? 0
      const tokensOut = data.usage?.completion_tokens ?? 0
      let cost = data.usage?.cost
      if (cost == null) {
        const p = await priceOf(model)
        cost = p ? (tokensIn * p.inPrice + tokensOut * p.outPrice) / 1e6 : 0
      }
      logAiCall(req.labId ?? null, req.task, model, tokensIn, tokensOut, cost)
      return { message: choice.message, finish: choice.finish_reason, usage: { tokensIn, tokensOut, cost }, model: data.model ?? model }
    } catch (e) {
      if (e instanceof AiError && e.status !== 429 && !(e.status && e.status >= 500)) throw e
      if ((e as Error).name === "AbortError" || req.signal?.aborted) throw new AiError(req.signal?.aborted ? "Cancelled." : "OpenRouter took too long to answer.")
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiError("OpenRouter is unreachable.")
}

/** Pull a JSON object out of a reply, tolerating code fences and chatter around it. */
export function parseJson<T>(text: string | null): T {
  if (!text) throw new AiError("The model returned an empty answer.")
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end < start) throw new AiError("The model did not return JSON.")
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T
  } catch {
    throw new AiError("The model returned malformed JSON.")
  }
}

/** Ask for a JSON object, retrying once with the parse error when the model slips. */
export async function chatJson<T>(req: Omit<ChatRequest, "json"> & { schema: { name: string; schema: Record<string, unknown> } }): Promise<{ data: T; usage: ChatResult["usage"]; model: string }> {
  const { schema, ...rest } = req
  let messages = rest.messages
  let usage = { tokensIn: 0, tokensOut: 0, cost: 0 }
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat({ ...rest, messages, json: schema })
    usage = { tokensIn: usage.tokensIn + res.usage.tokensIn, tokensOut: usage.tokensOut + res.usage.tokensOut, cost: usage.cost + res.usage.cost }
    // A cut-off answer is broken JSON, and asking again would hit the same limit at the same price.
    if (res.finish === "length") throw new AiError(`The model's answer for ${schema.name} was cut off at its ${rest.maxTokens ?? "output"}-token limit.`)
    try {
      return { data: parseJson<T>(res.message.content), usage, model: res.model }
    } catch (e) {
      if (attempt) throw e
      messages = [
        ...messages,
        { role: "assistant", content: res.message.content ?? "" },
        { role: "user", content: `That was not valid JSON (${(e as Error).message}). Reply again with only the JSON object.` },
      ]
    }
  }
  throw new AiError("The model did not return JSON.")
}
