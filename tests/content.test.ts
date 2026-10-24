import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADAPTERS, detectAdapter, splitMarkdown } from "../src/main/content/adapters"
import { connectOpenRouter, pkcePair } from "../src/main/oauth"
import { PACKAGE_FORMAT, validatePackage } from "../src/shared/content-package"
import { createHash } from "node:crypto"

const fixtures = join(import.meta.dirname, "fixtures")
const dir = mkdtempSync(join(tmpdir(), "study-lab-content-"))

describe("content adapters", () => {
  it("detects and groups a Udemy export into one valid package", async () => {
    const paths = [join(fixtures, "sample-simulados.md"), join(fixtures, "sample-transcricoes.md")]
    const a = await detectAdapter(paths)
    assert.equal(a?.id, "udemy-study-export")
    const { packages } = await a!.parse(paths)
    assert.equal(packages.length, 1)
    assert.deepEqual(validatePackage(packages[0]), [])
    assert.equal(packages[0].documents.length, 4)
    assert.equal(packages[0].assessments.length, 2)
    assert.equal(packages[0].assessments[1].kind, "exam")
  })

  it("reads native content packages and reports invalid ones", async () => {
    const good = { format: PACKAGE_FORMAT, version: 1, source: { adapter: "x", provider: "coursera", id: "c1", title: "C" }, documents: [{ id: "1", order: 1, title: "T", kind: "reading", text: "hi" }], assessments: [] }
    const bad = { ...good, source: { ...good.source, id: "c2" }, assessments: [{ id: "q", title: "Q", kind: "quiz", items: [{ id: "1", n: 1, stem: "s", options: ["a", "b"], answer: [5] }] }] }
    const f = join(dir, "pkgs.json")
    writeFileSync(f, JSON.stringify([good, bad]))
    assert.equal((await detectAdapter([f]))?.id, "content-package")
    const r = await ADAPTERS.find((x) => x.id === "content-package")!.parse([f])
    assert.equal(r.packages.length, 1)
    assert.match(r.warnings[0], /invalid answer key/)
  })

  it("turns plain notes into documents, splitting long files on headings", async () => {
    const long = `# Intro\n${"word ".repeat(1500)}\n\n# Details\n${"more ".repeat(1500)}`
    assert.deepEqual(splitMarkdown(long, "f").map((p) => p.title), ["Intro", "Details"])
    assert.equal(splitMarkdown("# Short\ntext", "f").length, 1)
    const f = join(dir, "notes.md")
    writeFileSync(f, "# Notes\nSome text")
    const r = await ADAPTERS.find((x) => x.id === "documents")!.parse([f])
    assert.equal(r.packages[0].documents[0].kind, "note")
  })
})

describe("OpenRouter OAuth (PKCE)", () => {
  it("makes an S256 challenge from the verifier", () => {
    const { verifier, challenge } = pkcePair()
    const expected = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    assert.equal(challenge, expected)
    assert.ok(verifier.length >= 43)
  })

  it("receives the code on the loopback callback and exchanges it for a key", async () => {
    let exchanged: Record<string, string> = {}
    const key = await connectOpenRouter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        exchanged = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ key: "sk-or-v1-new" }))
      }) as typeof fetch,
      open: async (authUrl) => {
        const u = new URL(authUrl)
        assert.equal(u.origin + u.pathname, "https://openrouter.ai/auth")
        assert.equal(u.searchParams.get("code_challenge_method"), "S256")
        const cb = new URL(u.searchParams.get("callback_url")!)
        assert.equal(cb.hostname, "localhost")
        cb.searchParams.set("code", "the-code")
        cb.searchParams.set("state", u.searchParams.get("state")!)
        // The browser lands on the callback after consent.
        setTimeout(() => void fetch(cb.toString().replace("localhost", "127.0.0.1")), 10)
      },
    })
    assert.equal(key, "sk-or-v1-new")
    assert.equal(exchanged.code, "the-code")
    assert.equal(exchanged.code_challenge_method, "S256")
    assert.ok(exchanged.code_verifier)
  })

  it("rejects a callback with the wrong state", async () => {
    await assert.rejects(
      connectOpenRouter({
        fetchImpl: (async () => new Response("{}")) as typeof fetch,
        open: async (authUrl) => {
          const cb = new URL(new URL(authUrl).searchParams.get("callback_url")!)
          cb.searchParams.set("code", "x")
          cb.searchParams.set("state", "forged")
          setTimeout(() => void fetch(cb.toString().replace("localhost", "127.0.0.1")), 10)
        },
      }),
      /cancelled/,
    )
  })
})
