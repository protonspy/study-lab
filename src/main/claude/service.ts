import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { app } from "electron"
import type { ClaudeStatus } from "@shared/types"
import { getSetting } from "../db"
import { ClaudeAccount, failureReason, loginUrl, type AccountState, type LoginInProgress } from "./account"
import { claudeDirs, claudeEnv, prepareDirs, sessionArgs, type ClaudeDirs } from "./env"
import { binaryPath, install, InstallError, PLATFORM, systemSignature, verify } from "./install"
import { PINNED } from "./pinned"
import { StreamReader, type StreamCall, type StreamEnd, type StreamResult } from "./stream"

/*
  The app's Claude Code: install (pinned, verified), the learner's sign-in, and one `claude -p` per
  coach run, so the coach spends the learner's own Claude plan instead of an API key. Every run gets
  a scrubbed environment, its own MCP config and nothing from the machine's Claude Code setup.
*/

export const CLAUDE_MODELS = ["sonnet", "opus", "haiku"] as const
export const DEFAULT_CLAUDE_MODEL = "sonnet"

export function claudeModel(): string {
  const m = getSetting("claude.model", DEFAULT_CLAUDE_MODEL)
  return (CLAUDE_MODELS as readonly string[]).includes(m) ? m : DEFAULT_CLAUDE_MODEL
}

/* ---------- where it lives (tests point it at a fake binary) ---------- */

interface Setup {
  dirs: ClaudeDirs
  bin: string
  /** arguments before the session's, e.g. a script for a fake binary */
  prefix: string[]
  verified: boolean
}

let setup: Setup | null = null

function current(): Setup {
  if (!setup) {
    const dirs = claudeDirs(app.getPath("userData"))
    setup = { dirs, bin: binaryPath(dirs.root, PINNED), prefix: [], verified: false }
  }
  return setup
}

export function useClaudeBinary(o: { bin: string; prefix?: string[]; dataDir: string }) {
  setup = { dirs: claudeDirs(o.dataDir), bin: o.bin, prefix: o.prefix ?? [], verified: true }
  prepareDirs(setup.dirs)
}

function procOptions() {
  const s = current()
  prepareDirs(s.dirs)
  return { env: claudeEnv(process.env, s.dirs), cwd: s.dirs.work }
}

const account = new ClaudeAccount(
  () => current().bin,
  procOptions,
  (bin, args, o) => spawn(bin, [...current().prefix, ...args], { ...o, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }),
  (bin, args, o) => new Promise((resolve, reject) => execFile(bin, [...current().prefix, ...args], { ...o, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out)))),
)

/* ---------- status, install and sign-in ---------- */

let binary: ClaudeStatus["binary"] = "missing"
let progress: number | undefined
let error: string | undefined
let acct: AccountState = { loggedIn: false, method: "none" }
let login: LoginInProgress | null = null
let loginText = ""
let onChange: (s: ClaudeStatus) => void = () => undefined

export function onClaudeChange(fn: (s: ClaudeStatus) => void) {
  onChange = fn
}

export function claudeStatus(): ClaudeStatus {
  return {
    version: PINNED.version,
    binary,
    progress,
    error,
    account: acct,
    login: login ? { url: loginUrl(loginText), text: loginText.slice(-2000) } : null,
    model: claudeModel(),
    ready: binary === "ok" && acct.loggedIn,
  }
}

function changed() {
  onChange(claudeStatus())
}

/** Check the installed binary (hashing it once per app session) and the account. */
export async function refreshClaude(): Promise<ClaudeStatus> {
  const s = current()
  if (!PINNED.platforms[PLATFORM]) binary = "unsupported"
  else if (binary !== "installing") {
    if (!s.verified) {
      // Hash only until it matches once per app session; a missing file still counts as missing.
      const v = await verify(s.dirs.root, PINNED).catch(() => "missing" as const)
      binary = v === "ok" ? "ok" : v
      s.verified = v === "ok"
    } else binary = existsFile(s.bin) ? "ok" : "missing"
  }
  if (binary === "ok" && !login) acct = await account.state()
  changed()
  return claudeStatus()
}

function existsFile(f: string) {
  try {
    return statSync(f).isFile()
  } catch {
    return false
  }
}

export async function installClaude(): Promise<ClaudeStatus> {
  if (binary === "installing" || binary === "unsupported") return claudeStatus()
  const s = current()
  binary = "installing"
  progress = 0
  error = undefined
  changed()
  try {
    let last = -1
    await install({
      root: s.dirs.root,
      pinned: PINNED,
      checkSignature: systemSignature(),
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0
        if (pct === last) return
        last = pct
        progress = pct / 100
        changed()
      },
    })
    binary = "ok"
    s.verified = true
  } catch (e) {
    binary = "failed"
    error = e instanceof InstallError ? e.message : `The install failed: ${(e as Error).message}`
  } finally {
    progress = undefined
  }
  return refreshClaude()
}

export function startClaudeLogin(): ClaudeStatus {
  if (binary !== "ok" || login) return claudeStatus()
  loginText = ""
  error = undefined
  const l = account.login((t) => {
    loginText += t
    changed()
  })
  login = l
  changed()
  void l.done.then(async ({ ok, text }) => {
    login = null
    loginText = ""
    acct = await account.state()
    if (!ok || !acct.loggedIn) error = failureReason(text)
    changed()
  })
  return claudeStatus()
}

export function sendClaudeCode(code: string) {
  if (!login) throw new Error("No sign-in is in progress.")
  login.sendCode(code)
}

export function cancelClaudeLogin() {
  login?.cancel()
}

/** The address the login printed, only when it is Anthropic's. */
export function claudeLoginUrl(): string | null {
  return login ? loginUrl(loginText) : null
}

export async function logoutClaude(): Promise<ClaudeStatus> {
  await account.logout().catch(() => undefined)
  return refreshClaude()
}

/* ---------- runs ---------- */

export interface ClaudeRun {
  prompt: string
  system: string
  model?: string
  /** the run's MCP servers, written to its mcp.json; secrets go in `env` and are referenced as ${VAR} */
  mcpServers?: Record<string, unknown>
  env?: Record<string, string>
  /** the coach's sub-agents (`--agents`) */
  agents?: Record<string, { description: string; prompt: string; tools: string[] }>
  jsonSchema?: Record<string, unknown>
  resume?: string
  /** keep the transcript so a chat thread can resume it (default: off) */
  persist?: boolean
  signal?: AbortSignal
  onCall?(c: StreamCall): void
  onResult?(r: StreamResult): void
}

export class ClaudeError extends Error {
  readonly kind: "auth" | "limit" | "failed" | "cancelled"

  constructor(kind: ClaudeError["kind"], message: string) {
    super(message)
    this.name = "ClaudeError"
    this.kind = kind
  }
}

/** Turn what Claude Code reported into something the learner can act on. */
export function claudeFailure(text: string): ClaudeError {
  if (/invalid api key|please run \/login|not logged in|oauth token|authentication/i.test(text)) return new ClaudeError("auth", "Claude Code is not signed in. Sign in again in Settings → AI coach.")
  if (/usage limit|hit your limit|rate.?limit|limit reached|overloaded/i.test(text)) return new ClaudeError("limit", `Your Claude plan's limit is reached for now${/resets?\s+(.+)/i.exec(text)?.[1] ? ` (resets ${/resets?\s+(.+)/i.exec(text)![1].trim()})` : ""}. Try again later or switch to OpenRouter.`)
  return new ClaudeError("failed", `Claude Code: ${text.slice(0, 400) || "the run failed."}`)
}

const running = new Set<ChildProcess>()

/** Stop every run, e.g. when the app quits. */
export function stopAllClaude() {
  for (const c of running) kill(c)
}

function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true })
  else child.kill("SIGKILL")
}

export async function ensureClaudeReady() {
  const s = await refreshClaude()
  if (s.binary !== "ok") throw new ClaudeError("failed", "Install Claude Code in Settings → AI coach first.")
  if (!s.account.loggedIn) throw new ClaudeError("auth", "Sign in to your Claude account in Settings → AI coach first.")
}

/** One `claude -p`: the prompt in, stream-json out, until the result line. */
export async function runClaude(r: ClaudeRun): Promise<StreamEnd> {
  const s = current()
  if (r.signal?.aborted) throw new ClaudeError("cancelled", "Cancelled.")
  prepareDirs(s.dirs)
  const dir = join(s.dirs.runs, randomUUID())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = (name: string, text: string) => {
    const f = join(dir, name)
    writeFileSync(f, text, { encoding: "utf8", mode: 0o600 })
    return f
  }
  try {
    const servers = Object.keys(r.mcpServers ?? {})
    const args = sessionArgs(
      { mcpConfig: servers.length ? file("mcp.json", JSON.stringify({ mcpServers: r.mcpServers })) : undefined, servers: servers.map((n) => `mcp__${n}`), agents: !!r.agents && Object.keys(r.agents).length > 0 },
      [
        "--model",
        r.model ?? claudeModel(),
        "--output-format",
        "stream-json",
        "--verbose",
        "--system-prompt-file",
        file("system.md", r.system),
        ...(r.agents && Object.keys(r.agents).length ? ["--agents", file("agents.json", JSON.stringify(r.agents))] : []),
        ...(r.jsonSchema ? ["--json-schema", JSON.stringify(r.jsonSchema)] : []),
        ...(r.resume ? ["--resume", r.resume] : []),
        ...(r.persist ? [] : ["--no-session-persistence"]),
      ],
    )
    const child = spawn(s.bin, [...s.prefix, ...args], {
      cwd: s.dirs.work,
      env: claudeEnv(process.env, s.dirs, { ...(r.env ?? {}), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    running.add(child)
    const reader = new StreamReader()
    let stderr = ""
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000)
    })
    const abort = () => kill(child)
    r.signal?.addEventListener("abort", abort, { once: true })
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(r.prompt)
    return await new Promise<StreamEnd>((resolve, reject) => {
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const { calls, results } = reader.line(line)
        for (const c of calls) r.onCall?.(c)
        for (const x of results) r.onResult?.(x)
      })
      child.on("error", (e) => reject(new ClaudeError("failed", `Claude Code did not start: ${e.message}`)))
      child.on("close", (code) => {
        running.delete(child)
        r.signal?.removeEventListener("abort", abort)
        if (r.signal?.aborted) return reject(new ClaudeError("cancelled", "Cancelled."))
        const end = reader.end
        if (!end) return reject(claudeFailure(stderr.trim().split("\n").pop() || `Claude Code stopped without an answer (exit ${code}).`))
        if (end.error) return reject(claudeFailure(end.text || end.reason || stderr))
        resolve(end)
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
