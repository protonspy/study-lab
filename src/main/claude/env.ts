import { mkdirSync } from "node:fs"
import { join } from "node:path"

/*
  How the app runs Claude Code: inside its own folder (the pinned binary, its own CLAUDE_CONFIG_DIR
  with the login and transcripts, an empty working folder), with a scrubbed environment and a fixed
  set of arguments that never load the machine's settings, hooks, MCP servers or host tools.
*/

export interface ClaudeDirs {
  /** the pinned binary, one folder per version */
  root: string
  /** CLAUDE_CONFIG_DIR: the login, transcripts and settings of the app's Claude Code */
  config: string
  /** the working folder of every run, with no file of the learner's */
  work: string
  /** per-run inputs: MCP config, agents, system prompt */
  runs: string
}

export function claudeDirs(dataDir: string): ClaudeDirs {
  const root = join(dataDir, "claude")
  return { root, config: join(root, "config"), work: join(root, "work"), runs: join(root, "runs") }
}

export function prepareDirs(d: ClaudeDirs) {
  for (const dir of [d.config, d.work, d.runs]) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
  What passes from the machine's environment: only what a process needs to find the system, the
  user, temp folders, locale and the network (proxy and corporate CA). Everything else stays out,
  credentials, base URLs, providers and models for Claude Code, another config dir, the OpenRouter
  key, NODE_OPTIONS.
*/
const ALLOWED = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "COMPUTERNAME",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "USER",
    "LOGNAME",
    "SHELL",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "__CF_USER_TEXT_ENCODING",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ].map((n) => n.toUpperCase()),
)

export function claudeEnv(base: Record<string, string | undefined>, d: ClaudeDirs, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    // Windows variable names are case-insensitive.
    const upper = name.toUpperCase()
    if (ALLOWED.has(upper) || upper.startsWith("LC_")) env[name] = value
  }
  env.CLAUDE_CONFIG_DIR = d.config
  // No background updates and no `claude update`: the binary stays the pinned one.
  env.DISABLE_UPDATES = "1"
  env.DISABLE_AUTOUPDATER = "1"
  return { ...env, ...extra }
}

/** Arguments that would reopen a host tool, a setting source, a folder or the permission prompt. */
const FORBIDDEN = [
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--add-dir",
  "--settings",
  "--setting-sources",
  "--plugin-dir",
  "--mcp-config",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
]

/** Claude Code's own sub-agents; the coach brings its own. */
export const BUILTIN_AGENTS = ["general-purpose", "Explore", "Plan", "claude", "statusline-setup"]

export interface SessionInput {
  /** the run's mcp.json, or none for a tool-less call */
  mcpConfig?: string
  /** whole MCP servers (`mcp__name`) the run may call */
  servers?: string[]
  /** whether the Agent tool (the coach's sub-agents) is available */
  agents?: boolean
}

/**
  The arguments of every run: print mode, no setting source, only the run's MCP servers, and no
  built-in tool but Agent. `extra` carries the model, formats and prompts and cannot reopen any of that.
*/
export function sessionArgs(input: SessionInput, extra: string[] = []): string[] {
  for (const arg of extra) {
    const name = arg.split("=")[0]
    if (FORBIDDEN.includes(name)) throw new Error(`${name} is not allowed in a Study Lab run.`)
  }
  const servers = input.servers ?? []
  for (const s of servers) if (!/^mcp__[A-Za-z0-9_-]+$/.test(s)) throw new Error(`${s} is not an MCP server name.`)
  const allowed = [...(input.agents ? ["Agent"] : []), ...servers]
  return [
    "-p",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    input.agents ? "Agent" : "",
    ...(input.mcpConfig ? ["--mcp-config", input.mcpConfig] : []),
    ...(allowed.length ? ["--allowedTools", ...allowed] : []),
    ...(input.agents ? ["--disallowedTools", ...BUILTIN_AGENTS.map((a) => `Agent(${a})`)] : []),
    ...extra,
  ]
}
