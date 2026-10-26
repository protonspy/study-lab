import { execFile, spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"

/*
  The learner's Claude account, always through the app's own Claude Code (its CLAUDE_CONFIG_DIR).
  The app never reads or stores the credential: it asks `claude auth status`, runs
  `claude auth login --claudeai`, opens only the Anthropic page that login prints, and passes on
  the code the learner pastes back.
*/

export interface AccountState {
  loggedIn: boolean
  method: string
  /** "pro", "max"…, when Claude Code reports it */
  plan?: string
  email?: string
}

export interface ChildLike {
  stdout: Readable | null
  stderr: Readable | null
  stdin: Writable | null
  kill(): boolean
  on(event: "close", fn: (code: number | null) => void): unknown
  on(event: "error", fn: (err: Error) => void): unknown
}

export interface ClaudeProcOptions {
  env: Record<string, string>
  cwd: string
}

export type Start = (bin: string, args: string[], o: ClaudeProcOptions) => ChildLike
export type Exec = (bin: string, args: string[], o: ClaudeProcOptions) => Promise<string>

const realStart: Start = (bin, args, o) => spawn(bin, args, { ...o, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })

const realExec: Exec = (bin, args, o) => new Promise((resolve, reject) => execFile(bin, args, { ...o, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out))))

/** Strip terminal escapes (colour, OSC 8 links) and control characters. */
export function cleanText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  )
}

const ANTHROPIC_HOSTS = ["claude.com", "claude.ai", "anthropic.com"]

/** An https page of Anthropic's, the only kind of address the app opens for the login. */
export function isAnthropicUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && ANTHROPIC_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/** The sign-in address `claude auth login` printed, when it is Anthropic's. */
export function loginUrl(text: string): string | null {
  for (const m of cleanText(text).matchAll(/https:\/\/[^\s"'<>]+/g)) if (isAnthropicUrl(m[0])) return m[0]
  return null
}

/** The code Anthropic's page shows: one line, no spaces or control characters. */
export function validCode(code: string): boolean {
  return /^[A-Za-z0-9#_\-.~]{8,512}$/.test(code.trim())
}

export function parseStatus(out: string): AccountState {
  const d = JSON.parse(out) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; email?: unknown }
  return {
    loggedIn: d.loggedIn === true,
    method: typeof d.authMethod === "string" ? d.authMethod : "none",
    plan: typeof d.subscriptionType === "string" ? d.subscriptionType : undefined,
    email: typeof d.email === "string" ? d.email : undefined,
  }
}

/** Login lines that are instructions, not the outcome. */
const INSTRUCTIONS = [/^Opening browser/i, /didn't open, visit:/i, /^Paste code here/i, /^https:\/\//]

/** The last line Claude Code wrote that says what went wrong. */
export function failureReason(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !INSTRUCTIONS.some((r) => r.test(l)))
  return lines.pop() ?? "The sign-in did not finish."
}

export interface LoginInProgress {
  sendCode(code: string): void
  cancel(): void
  done: Promise<{ ok: boolean; text: string }>
}

export class ClaudeAccount {
  private readonly bin: () => string
  private readonly opts: () => ClaudeProcOptions
  private readonly start: Start
  private readonly exec: Exec

  constructor(bin: () => string, opts: () => ClaudeProcOptions, start: Start = realStart, exec: Exec = realExec) {
    this.bin = bin
    this.opts = opts
    this.start = start
    this.exec = exec
  }

  async state(): Promise<AccountState> {
    try {
      return parseStatus(await this.exec(this.bin(), ["auth", "status", "--json"], this.opts()))
    } catch {
      return { loggedIn: false, method: "none" }
    }
  }

  async logout(): Promise<void> {
    await this.exec(this.bin(), ["auth", "logout"], this.opts())
  }

  /** Start signing in with a Claude subscription. `onText` gets what Claude Code writes, cleaned. */
  login(onText: (text: string) => void): LoginInProgress {
    const child = this.start(this.bin(), ["auth", "login", "--claudeai"], this.opts())
    let text = ""
    const listen = (chunk: Buffer) => {
      const t = cleanText(chunk.toString("utf8"))
      text += t
      onText(t)
    }
    child.stdout?.on("data", listen)
    child.stderr?.on("data", listen)
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      child.on("error", (e) => resolve({ ok: false, text: `${text}${e.message}` }))
      child.on("close", (code) => resolve({ ok: code === 0, text }))
    })
    return {
      sendCode: (code) => {
        if (!validCode(code)) throw new Error("That code does not look right. Copy it again from the Anthropic page.")
        child.stdin?.write(`${code.trim()}\n`)
      },
      cancel: () => {
        child.kill()
      },
      done,
    }
  }
}
