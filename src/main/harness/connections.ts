import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { randomUUID } from "node:crypto"
import type { McpConnection } from "@shared/types"
import { getSetting, setSetting } from "../db"

/*
  External MCP servers the coach may use (docs, notes, calendars, another app's data). Each
  connection is either a local command (stdio) or an HTTP endpoint, and is enabled for every lab
  or for chosen labs. Tools are prefixed with the server name so they never clash with the lab's own.
*/

export function listConnections(): McpConnection[] {
  return getSetting<McpConnection[]>("mcp.connections", [])
}

export function saveConnection(c: Omit<McpConnection, "id"> & { id?: string }): McpConnection {
  const list = listConnections()
  const name = c.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)
  if (!name) throw new Error("Give the connection a short name (letters, digits, dashes).")
  if (c.transport === "http" && !/^https?:\/\//.test(c.url ?? "")) throw new Error("An HTTP connection needs a URL starting with http:// or https://.")
  if (c.transport === "stdio" && !c.command?.trim()) throw new Error("A local connection needs a command to run.")
  if (list.some((x) => x.name === name && x.id !== c.id)) throw new Error(`A connection named ${name} already exists.`)
  const next: McpConnection = { ...c, name, id: c.id ?? randomUUID() }
  setSetting("mcp.connections", [...list.filter((x) => x.id !== next.id), next])
  return next
}

export function deleteConnection(id: string) {
  setSetting(
    "mcp.connections",
    listConnections().filter((c) => c.id !== id),
  )
}

function toServerConfig(c: McpConnection) {
  return c.transport === "http"
    ? { transport: "http" as const, url: c.url!, headers: c.headers ?? {} }
    : { transport: "stdio" as const, command: c.command!, args: c.args ?? [], env: { ...(process.env as Record<string, string>), ...(c.env ?? {}) } }
}

export interface LoadedTools {
  tools: StructuredToolInterface[]
  close(): Promise<void>
  errors: string[]
}

/** Connect to the servers enabled for this lab and return their tools. Unreachable servers are skipped. */
export function loadConnectionTools(labId: string): Promise<LoadedTools> {
  return connect(listConnections().filter((c) => c.enabled && (c.labs === "all" || c.labs.includes(labId))))
}

async function connect(active: McpConnection[]): Promise<LoadedTools> {
  if (!active.length) return { tools: [], close: async () => undefined, errors: [] }
  const errors: string[] = []
  const client = new MultiServerMCPClient({
    mcpServers: Object.fromEntries(active.map((c) => [c.name, toServerConfig(c)])),
    prefixToolNameWithServerName: true,
    throwOnLoadError: false,
    onConnectionError: ({ serverName, error }: { serverName: string; error: unknown }) => {
      errors.push(`${serverName}: ${(error as Error)?.message ?? String(error)}`)
    },
  })
  try {
    const tools = await client.getTools()
    return { tools, close: () => client.close(), errors }
  } catch (e) {
    await client.close().catch(() => undefined)
    return { tools: [], close: async () => undefined, errors: [...errors, (e as Error).message] }
  }
}

/** Connect to one server (enabled or not) and list its tools. */
export async function testConnection(id: string): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const c = listConnections().find((x) => x.id === id)
  if (!c) return { ok: false, tools: [], error: "Unknown connection." }
  const loaded = await connect([c])
  await loaded.close().catch(() => undefined)
  return { ok: loaded.tools.length > 0, tools: loaded.tools.map((t) => t.name), error: loaded.errors[0] ?? (loaded.tools.length ? undefined : "The server exposes no tools.") }
}
