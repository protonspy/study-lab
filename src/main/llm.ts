import type { AiProvider } from "@shared/types"
import { claudeModel, ensureClaudeReady, runClaude } from "./claude/service"
import { getSetting, setSetting } from "./db"
import { chatJson as openRouterJson, currentModel, parseJson, readKey, type ChatResult, type Msg } from "./openrouter"
import { logAiCall } from "./repo"

/*
  Which AI runs the app: the learner's Claude plan through the app's Claude Code, or OpenRouter with
  an API key. Learners who already had a key keep OpenRouter until they switch.
*/

export function provider(): AiProvider {
  return getSetting<AiProvider>("ai.provider", "claude-code")
}

/**
  Once, at startup: an install from before Claude Code support keeps the OpenRouter key it has. It
  looks at the stored key, not the decrypted one, so a keychain hiccup never switches the provider.
*/
export function initProvider() {
  if (getSetting<AiProvider | null>("ai.provider", null) === null) setSetting("ai.provider", getSetting<unknown>("openrouter.key", null) ? "openrouter" : "claude-code")
}

/** The model as the journal and reports name it. */
export function activeModel(): string {
  return provider() === "claude-code" ? `claude-code/${claudeModel()}` : currentModel()
}

/** A JSON answer that fits `schema`, from whichever provider is active. Used by the knowledge-base builder. */
export async function askJson<T>(req: {
  messages: Msg[]
  schema: { name: string; schema: Record<string, unknown> }
  maxTokens?: number
  signal?: AbortSignal
  task: string
  labId?: string | null
}): Promise<{ data: T; usage: ChatResult["usage"]; model: string }> {
  if (provider() === "openrouter") return openRouterJson<T>(req)
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const prompt = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content ?? "")
    .join("\n\n")
  const end = await runClaude({ system, prompt, jsonSchema: req.schema.schema, signal: req.signal })
  const model = `claude-code/${claudeModel()}`
  const usage = { tokensIn: end.usage.tokensIn, tokensOut: end.usage.tokensOut, cost: 0 }
  logAiCall(req.labId ?? null, req.task, model, usage.tokensIn, usage.tokensOut, 0)
  const data = end.structured && typeof end.structured === "object" ? (end.structured as T) : parseJson<T>(end.text)
  return { data, usage, model }
}

/** Fail early, with what to fix, when the active provider is not set up. */
export async function ensureAiReady() {
  if (provider() === "claude-code") return ensureClaudeReady()
  if (!readKey()) throw new Error("Add your OpenRouter API key in Settings → AI coach first.")
}
