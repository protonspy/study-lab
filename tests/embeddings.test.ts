import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeDb, openDb, setSetting } from "../src/main/db"
import { saveKey } from "../src/main/openrouter"
import { backoffMs, getEmbedder } from "../src/main/embeddings"

/* The embeddings endpoint against a scripted OpenRouter that rate-limits some requests. */

const dir = mkdtempSync(join(tmpdir(), "study-lab-embed-"))
const realFetch = globalThis.fetch
let statuses: number[] = []
let calls = 0

before(async () => {
  openDb(join(dir, "embed.db"))
  await saveKey("sk-or-test")
  // These run against OpenRouter's endpoint; the local model has its own tests.
  setSetting("ai.embeddings", "openrouter")
  setSetting("ai.provider", "openrouter")
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++
    const status = statuses.shift() ?? 200
    if (status !== 200) return new Response("{}", { status, headers: { "retry-after": "0.01" } })
    const input = JSON.parse(String(init?.body)).input as string[]
    return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, index, 0] })), usage: { prompt_tokens: 1, cost: 0 } })
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe("model embeddings", () => {
  it("waits out a 429 mid-build instead of failing", async () => {
    statuses = []
    const e = await getEmbedder(null)
    assert.equal(e.kind, "model")
    statuses = [429, 503]
    calls = 0
    const vecs = await e.embed(["a", "b"])
    assert.equal(vecs.length, 2)
    assert.equal(calls, 3)
  })

  it("gives up with a clear message when the rate limit persists", async () => {
    statuses = []
    const e = await getEmbedder(null)
    statuses = Array(10).fill(429)
    await assert.rejects(e.embed(["a"]), /rate-limited.*after 6 tries/)
  })

  it("does not retry a client error", async () => {
    statuses = []
    const e = await getEmbedder(null)
    statuses = [400]
    calls = 0
    await assert.rejects(e.embed(["a"]), /HTTP 400/)
    assert.equal(calls, 1)
  })

  it("honours Retry-After and caps the backoff", () => {
    assert.equal(backoffMs(0, "3"), 3000)
    assert.equal(backoffMs(0, "600"), 60_000)
    const b = backoffMs(2, null)
    assert.ok(b >= 6000 && b <= 10_000)
    assert.ok(backoffMs(20, null) <= 60_000)
  })
})
