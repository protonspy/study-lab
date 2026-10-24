import { ChatOpenRouter } from "@langchain/openrouter"
import { currentModel, listModels, readKey } from "../openrouter"
import { logAiCall } from "../repo"

/* The chat model behind the agent harness: any OpenRouter model, with usage and cost logged per call. */

export interface UsageSink {
  add(u: { tokensIn: number; tokensOut: number; cost: number }, model: string): void
}

async function pricePerToken(model: string) {
  try {
    const m = (await listModels()).find((x) => x.id === model)
    return m ? { in: m.inPrice / 1e6, out: m.outPrice / 1e6 } : null
  } catch {
    return null
  }
}

export function makeModel(opts: { task: string; labId?: string | null; sink?: UsageSink; temperature?: number; model?: string }) {
  const apiKey = readKey()
  if (!apiKey) throw new Error("Add your OpenRouter API key in Settings → AI coach first.")
  const model = opts.model ?? currentModel()
  return new ChatOpenRouter({
    model,
    apiKey,
    temperature: opts.temperature ?? 0.3,
    siteUrl: "https://github.com/protonspy/study-lab",
    siteName: "Study Lab",
    callbacks: [
      {
        async handleLLMEnd(output) {
          const gen = output.generations?.[0]?.[0] as { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } } | undefined
          const u = gen?.message?.usage_metadata
          if (!u) return
          const tokensIn = u.input_tokens ?? 0
          const tokensOut = u.output_tokens ?? 0
          const p = await pricePerToken(model)
          const cost = p ? tokensIn * p.in + tokensOut * p.out : 0
          logAiCall(opts.labId ?? null, opts.task, model, tokensIn, tokensOut, cost)
          opts.sink?.add({ tokensIn, tokensOut, cost }, model)
        },
      },
    ],
  })
}
