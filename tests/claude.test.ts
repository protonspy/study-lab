import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeDb, openDb, setSetting } from "../src/main/db"
import * as repo from "../src/main/repo"
import { importUdemy } from "../src/main/importers"
import { runAnalyze, runChat } from "../src/main/agent"
import type { JobHandle } from "../src/main/jobs"
import { askJson } from "../src/main/llm"
import { toStored } from "../src/main/harness/agent"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { failureReason, isAnthropicUrl, loginUrl, parseStatus, validCode } from "../src/main/claude/account"
import { claudeDirs, claudeEnv, sessionArgs } from "../src/main/claude/env"
import { binaryPath, install, signedByAnthropic, verify, type Pinned } from "../src/main/claude/install"
import { harnessName, StreamReader } from "../src/main/claude/stream"
import { claudeFailure, refreshClaude, runClaude, useClaudeBinary } from "../src/main/claude/service"

/*
  Claude Code as the coach's runtime: the scrubbed environment and locked-down arguments, the pinned
  install, the stream reader, and whole coach runs against a fake `claude` that calls the run's MCP
  endpoint like the real one.
*/

const fixtures = join(import.meta.dirname, "fixtures")
const dir = mkdtempSync(join(tmpdir(), "study-lab-claude-"))
const dirs = claudeDirs(dir)
let labId = ""

function job(): JobHandle {
  return { id: "j", signal: new AbortController().signal, step: () => undefined, addUsage: () => undefined }
}

const calls = () =>
  existsSync(join(dirs.config, "calls.jsonl"))
    ? readFileSync(join(dirs.config, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { args: string[]; prompt?: string; system?: string; mcp?: { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> }; agents?: Record<string, { tools: string[] }>; env: string[] })
    : []
const runs = () => calls().filter((c) => c.args[0] === "-p")
const steer = (o: Record<string, unknown>) => writeFileSync(join(dirs.config, "fake.json"), JSON.stringify(o))

before(async () => {
  process.env.STUDY_LAB_USER_SKILLS = join(dir, "skills")
  openDb(join(dir, "claude.db"))
  setSetting("ai.provider", "claude-code")
  setSetting("ai.embeddings", "openrouter")
  useClaudeBinary({ bin: process.execPath, prefix: [join(fixtures, "fake-claude.mjs")], dataDir: dir })
  labId = repo.createLab({ name: "Cloud", preset: "certification" }).id
  await importUdemy(labId, [join(fixtures, "sample-simulados.md"), join(fixtures, "sample-transcricoes.md")])
})

beforeEach(() => {
  rmSync(join(dirs.config, "calls.jsonl"), { force: true })
  steer({})
})

after(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe("Claude Code environment and arguments", () => {
  it("passes only the system basics and points Claude Code at the app's own config", () => {
    const env = claudeEnv({ Path: "C:\\bin", TEMP: "t", ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "o", CLAUDE_CONFIG_DIR: "elsewhere", NODE_OPTIONS: "--require x", ANTHROPIC_BASE_URL: "http://evil", LC_ALL: "C" }, dirs)
    assert.equal(env.Path, "C:\\bin")
    assert.equal(env.LC_ALL, "C")
    for (const k of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "NODE_OPTIONS", "ANTHROPIC_BASE_URL"]) assert.equal(env[k], undefined, k)
    assert.equal(env.CLAUDE_CONFIG_DIR, dirs.config)
    assert.equal(env.DISABLE_AUTOUPDATER, "1")
  })

  it("never loads host settings or tools, and refuses arguments that would reopen them", () => {
    const a = sessionArgs({ mcpConfig: "m.json", servers: ["mcp__studylab"], agents: true }, ["--model", "sonnet"])
    assert.deepEqual(a.slice(0, 6), ["-p", "--setting-sources", "", "--strict-mcp-config", "--tools", "Agent"])
    assert.ok(a.includes("Agent(Explore)"))
    assert.equal(sessionArgs({})[5], "")
    assert.throws(() => sessionArgs({}, ["--dangerously-skip-permissions"]), /not allowed/)
    assert.throws(() => sessionArgs({}, ["--settings=x.json"]), /not allowed/)
    assert.throws(() => sessionArgs({ servers: ["Bash"] }), /not an MCP server/)
  })
})

describe("Claude Code install", () => {
  const bytes = Buffer.from("pretend binary")
  const pinned: Pinned = { version: "9.9.9", repository: "https://downloads.example", platforms: { "win32-x64": { binary: "claude.exe", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } } }
  const realFetch = globalThis.fetch
  after(() => {
    globalThis.fetch = realFetch
  })

  it("installs only a download with the pinned hash and Anthropic's signature, and deletes a changed binary", async () => {
    const root = join(dir, "inst")
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch
    await assert.rejects(install({ root, pinned, platform: "win32-x64", onProgress: () => undefined, checkSignature: async () => false }), /not signed by Anthropic/)
    assert.equal(await verify(root, pinned, "win32-x64"), "missing")
    const bin = await install({ root, pinned, platform: "win32-x64", onProgress: () => undefined, checkSignature: async () => true })
    assert.equal(bin, binaryPath(root, pinned, "win32-x64"))
    assert.equal(await verify(root, pinned, "win32-x64"), "ok")
    writeFileSync(bin, "tampered")
    assert.equal(await verify(root, pinned, "win32-x64"), "changed")
    assert.ok(!existsSync(bin))
    globalThis.fetch = (async () => new Response(Buffer.from("something else!"))) as typeof fetch
    await assert.rejects(install({ root, pinned, platform: "win32-x64", onProgress: () => undefined, checkSignature: async () => true }), /does not match|larger/)
  })

  it("accepts only Anthropic, PBC as the Authenticode signer", () => {
    assert.ok(signedByAnthropic({ Status: 0, Subject: 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US' }))
    assert.ok(!signedByAnthropic({ Status: 1, Subject: 'CN="Anthropic, PBC", O="Anthropic, PBC"' }))
    assert.ok(!signedByAnthropic({ Status: 0, Subject: 'CN="Anthropic, PBC Fake", O="Anthropic, PBC"' }))
  })
})

describe("Claude account sign-in", () => {
  it("opens only Anthropic pages and accepts only a one-line code", () => {
    const text = "Opening browser…\n\x1b]8;;https://evil.example/x\x07link\x1b]8;;\x07 If it didn't open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc\nPaste code here:"
    assert.equal(loginUrl(text), "https://claude.ai/oauth/authorize?code=true&client_id=abc")
    assert.ok(!isAnthropicUrl("https://claude.ai.evil.example/"))
    assert.ok(!isAnthropicUrl("http://claude.ai/"))
    assert.ok(validCode("abcDEF123#state_456"))
    assert.ok(!validCode("abc def 123 456"))
    assert.equal(failureReason("Opening browser\nPaste code here\nOAuth error: invalid code\n"), "OAuth error: invalid code")
    assert.deepEqual(parseStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'), { loggedIn: true, method: "claude.ai", plan: "max", email: undefined })
  })

  it("reads the account from the app's Claude Code", async () => {
    let s = await refreshClaude()
    assert.equal(s.binary, "ok")
    assert.ok(s.account.loggedIn && s.ready)
    steer({ loggedOut: true })
    s = await refreshClaude()
    assert.ok(!s.ready)
    const status = calls().find((c) => c.args[0] === "auth")!
    assert.ok(!status.env.includes("OPENROUTER_API_KEY") && status.env.includes("CLAUDE_CONFIG_DIR"))
  })
})

describe("the stream reader", () => {
  it("turns stream-json into tool calls, results and the answer", () => {
    const r = new StreamReader()
    r.line(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet", tools: ["Agent"] }))
    const a = r.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__studylab__list_topics", input: {} }, { type: "tool_use", id: "t2", name: "Agent", input: { subagent_type: "learning-analyst", description: "Diagnose", prompt: "…" } }] } }))
    assert.deepEqual(
      a.calls.map((c) => c.name),
      ["list_topics", "task"],
    )
    const u = r.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[1,2]", is_error: false }] } }))
    assert.deepEqual(u.results, [{ id: "t1", ok: true, text: "[1,2]" }])
    r.line("not json")
    r.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 5, cache_read_input_tokens: 5, output_tokens: 2 } }))
    assert.deepEqual(r.end, { text: "Done.", error: false, session: "s1", structured: undefined, usage: { tokensIn: 10, tokensOut: 2, model: "claude-sonnet" }, reason: undefined })
    assert.equal(harnessName("mcp__notes__search"), "notes_search")
  })

  it("explains a plan limit and a lost sign-in", () => {
    assert.equal(claudeFailure("You've hit your limit · resets 3pm").kind, "limit")
    assert.match(claudeFailure("You've hit your limit · resets 3pm").message, /resets 3pm/)
    assert.equal(claudeFailure("Invalid API key · Please run /login").kind, "auth")
  })
})

describe("the coach on Claude Code", () => {
  it("chats through the run's MCP endpoint, then resumes the same session", async () => {
    const thread = repo.createThread(labId, "c").id
    await runChat(labId, thread, "How am I doing?", job())
    const [first] = runs()
    const lab = first.mcp!.mcpServers.studylab
    assert.match(lab.url!, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//)
    // The run's token lives only in the environment, never in the file on disk.
    assert.equal(lab.headers!.Authorization, "Bearer ${STUDYLAB_RUN_TOKEN}")
    assert.ok(first.env.includes("STUDYLAB_RUN_TOKEN") && !first.env.includes("OPENROUTER_API_KEY"))
    assert.ok(first.args.includes("--allowedTools") && first.args.includes("mcp__studylab"))
    assert.ok(!first.args.includes("--no-session-persistence"))
    assert.match(first.system!, /read_skill/)
    assert.ok(first.agents!["learning-analyst"].tools.includes("mcp__studylab__get_overview"))
    const msgs = repo.listMessages(thread)
    assert.equal(msgs.at(-1)!.content, "Answer to: How am I doing?")
    assert.deepEqual(
      msgs.at(-1)!.tools!.map((t) => [t.name, t.ok]),
      [["get_overview", true]],
    )
    assert.deepEqual(repo.threadSession(thread), { id: "sess-1", upto: msgs.at(-1)!.id })

    rmSync(join(dirs.config, "calls.jsonl"))
    await runChat(labId, thread, "And now?", job())
    const [second] = runs()
    assert.equal(second.args[second.args.indexOf("--resume") + 1], "sess-1")
    assert.equal(second.prompt, "And now?")
  })

  it("writes the earlier turns into the prompt when there is no session to resume", async () => {
    const thread = repo.createThread(labId, "d").id
    // As an earlier turn on OpenRouter would have stored them.
    repo.addMessage(thread, { role: "user", content: "First question", at: Date.now() }, toStored([new HumanMessage("First question")]))
    repo.addMessage(thread, { role: "assistant", content: "First answer", at: Date.now() }, toStored([new AIMessage("First answer")]))
    await runChat(labId, thread, "Follow-up", job())
    const [r] = runs()
    assert.ok(!r.args.includes("--resume"))
    assert.match(r.prompt!, /Earlier in this conversation/)
    assert.match(r.prompt!, /Coach: First answer[\s\S]*Follow-up$/)
  })

  it("serves job-specific tools to the run, so the analysis saves its report", async () => {
    steer({ tool: "save_insight_report", args: { headline: "Focus on storage", summary: "S", insights: [], next: ["Drill S3"] } })
    const before = repo.listInsights(labId).length
    await runAnalyze(labId, job())
    const [r] = runs()
    assert.ok(r.args.includes("--no-session-persistence"))
    assert.ok(!r.agents!["content-author"], "analysis is read-only")
    const reports = repo.listInsights(labId)
    assert.equal(reports.length, before + 1)
    assert.equal(reports[0].headline, "Focus on storage")
    assert.equal(reports[0].model, "claude-code:sonnet")
  })

  it("answers JSON for the knowledge-base builder with --json-schema and no tools", async () => {
    const r = await askJson<{ word: string; n: number }>({ task: "t", schema: { name: "x", schema: { type: "object" } }, messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }] })
    assert.deepEqual(r.data, { word: "ready", n: 7 })
    const [c] = runs()
    assert.equal(c.args[c.args.indexOf("--tools") + 1], "")
    assert.ok(!c.args.includes("--mcp-config"))
  })

  it("reports the plan's limit clearly", async () => {
    steer({ limit: true })
    await assert.rejects(runClaude({ system: "s", prompt: "p" }), /limit is reached for now \(resets 3pm\)/)
  })

  it("stops the run when the job is cancelled", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(runClaude({ system: "s", prompt: "p", signal: ctrl.signal }), /Cancelled/)
    mkdirSync(dirs.runs, { recursive: true })
  })
})

describe("choosing the provider", () => {
  it("keeps OpenRouter for an install that already stored a key, and starts new installs on Claude", async () => {
    const { getSetting } = await import("../src/main/db")
    const { initProvider } = await import("../src/main/llm")
    const before = getSetting("ai.provider", null)
    setSetting("ai.provider", null)
    setSetting("openrouter.key", { enc: true, v: "c2VjcmV0" })
    initProvider()
    assert.equal(getSetting("ai.provider", null), "openrouter")
    setSetting("ai.provider", null)
    setSetting("openrouter.key", null)
    initProvider()
    assert.equal(getSetting("ai.provider", null), "claude-code")
    setSetting("ai.provider", before)
  })
})
