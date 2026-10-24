import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http"
import { randomBytes } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { getSetting, one, setSetting } from "./db"
import { emit } from "./jobs"
import { runTool, TOOLS, type Touched } from "./tools"

/*
  Optional local MCP server: one Streamable HTTP endpoint per lab at
  http://127.0.0.1:<port>/mcp/<labId>, guarded by a bearer token. It exposes the same tools as
  the in-app coach, so Claude Desktop, Claude Code or any MCP client can analyse and manage a
  lab. Stateless: every request gets a fresh server bound to that lab.
*/

export interface McpConfig {
  enabled: boolean
  port: number
  token: string
}

let http: HttpServer | null = null
let status: { running: boolean; error?: string } = { running: false }

export function mcpConfig(): McpConfig {
  const c = getSetting<Partial<McpConfig>>("mcp", {})
  const cfg = { enabled: !!c.enabled, port: c.port ?? 8765, token: c.token ?? "" }
  if (!cfg.token) {
    cfg.token = randomBytes(18).toString("base64url")
    setSetting("mcp", cfg)
  }
  return cfg
}

export function saveMcpConfig(patch: Partial<McpConfig> & { rotateToken?: boolean }) {
  const cur = mcpConfig()
  const next: McpConfig = {
    enabled: patch.enabled ?? cur.enabled,
    port: patch.port && patch.port > 1023 && patch.port < 65536 ? Math.round(patch.port) : cur.port,
    token: patch.rotateToken ? randomBytes(18).toString("base64url") : cur.token,
  }
  setSetting("mcp", next)
  return next
}

export function mcpStatus() {
  return status
}

function serverFor(labId: string, client: string) {
  const server = new Server({ name: "study-lab", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schema as { type: "object"; properties?: Record<string, unknown> },
      annotations: { readOnlyHint: !t.write, destructiveHint: false },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const touched = new Set<Touched>()
    const out = runTool({ labId, actor: `mcp:${client}`, notify: (w) => w.forEach((x) => touched.add(x)) }, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
    if (touched.size) emit({ type: "lab-changed", labId, what: [...touched] as ("content" | "config" | "plans" | "insights" | "state")[] })
    return { content: [{ type: "text", text: JSON.stringify(out.result, null, 1) }], isError: !out.ok }
  })
  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 4_000_000) throw new Error("Request too large")
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : undefined
}

export async function stopMcp() {
  if (!http) return
  await new Promise<void>((r) => http!.close(() => r()))
  http = null
  status = { running: false }
}

export async function applyMcp() {
  await stopMcp()
  const cfg = mcpConfig()
  if (!cfg.enabled) return
  http = createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    try {
      // Browsers send an Origin header; refuse them so web pages cannot drive the lab (DNS rebinding).
      if (req.headers.origin) return json(403, { error: "Browser requests are not allowed." })
      if (req.headers.authorization !== `Bearer ${cfg.token}`) return json(401, { error: "Missing or wrong bearer token." })
      const m = req.url?.match(/^\/mcp\/([\w-]+)\/?(?:\?.*)?$/)
      if (!m) return json(404, { error: "Use /mcp/<labId>. Lab ids are listed in Study Lab → Settings → MCP server." })
      const labId = m[1]
      if (!one("SELECT id FROM labs WHERE id = ?", labId)) return json(404, { error: `No lab ${labId}` })
      if (req.method !== "POST") return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
      const body = await readBody(req)
      const client = String(req.headers["user-agent"] ?? "client").split(/[\s/]/)[0].slice(0, 30)
      const server = serverFor(labId, client)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on("close", () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      if (!res.headersSent) json(500, { jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null })
    }
  })
  await new Promise<void>((resolve) => {
    http!.once("error", (e: NodeJS.ErrnoException) => {
      status = { running: false, error: e.code === "EADDRINUSE" ? `Port ${cfg.port} is in use. Pick another one.` : e.message }
      http = null
      resolve()
    })
    http!.listen(cfg.port, "127.0.0.1", () => {
      status = { running: true }
      resolve()
    })
  })
}
