// A stand-in for the claude binary: answers `auth status`, and for `-p` runs reads the prompt from
// stdin, calls the run's Study Lab MCP endpoint like Claude Code would, and prints stream-json.
// Every call is logged to $CLAUDE_CONFIG_DIR/calls.jsonl for the tests to inspect, and the test steers
// it through $CLAUDE_CONFIG_DIR/fake.json (the app scrubs the environment, so not through variables).
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const control = join(process.env.CLAUDE_CONFIG_DIR, "fake.json")
const fake = existsSync(control) ? JSON.parse(readFileSync(control, "utf8")) : {}

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const log = (o) => appendFileSync(join(process.env.CLAUDE_CONFIG_DIR, "calls.jsonl"), `${JSON.stringify(o)}\n`)

if (args[0] === "auth") {
  log({ args, env: Object.keys(process.env) })
  if (args[1] === "status") out({ loggedIn: !fake.loggedOut, authMethod: "claude.ai", subscriptionType: "pro" })
  process.exit(0)
}

let prompt = ""
for await (const c of process.stdin) prompt += c
const system = flag("--system-prompt-file") ? readFileSync(flag("--system-prompt-file"), "utf8") : ""
const mcp = flag("--mcp-config") ? JSON.parse(readFileSync(flag("--mcp-config"), "utf8")) : null
const agents = flag("--agents") ? JSON.parse(readFileSync(flag("--agents"), "utf8")) : null
log({ args, prompt, system, mcp, agents, env: Object.keys(process.env) })

const session = flag("--resume") ?? "sess-1"
out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-test", tools: ["Agent", "mcp__studylab__get_overview"] })

if (flag("--json-schema")) {
  out({ type: "result", subtype: "success", is_error: false, result: "{}", structured_output: { word: "ready", n: 7 }, session_id: session, usage: { input_tokens: 10, output_tokens: 3 } })
  process.exit(0)
}

if (fake.limit) {
  out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", session_id: session, usage: {} })
  process.exit(1)
}

// Call a lab tool through the run's MCP endpoint, header expanded from the environment.
const lab = mcp?.mcpServers?.studylab
let toolText = ""
if (lab) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  for (const [k, v] of Object.entries(lab.headers)) headers[k] = v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "")
  const rpc = async (id, method, params) => {
    const res = await fetch(lab.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
    const text = await res.text()
    const data = text.split("\n").find((l) => l.startsWith("data:"))
    return JSON.parse(data ? data.slice(5) : text)
  }
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } })
  const tool = fake.tool ?? "get_overview"
  const toolArgs = fake.args ?? {}
  out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu_1", name: `mcp__studylab__${tool}`, input: toolArgs }] } })
  const r = await rpc(2, "tools/call", { name: tool, arguments: toolArgs })
  toolText = r.result?.content?.[0]?.text ?? JSON.stringify(r.error)
  out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: toolText }], is_error: r.result?.isError === true }] } })
}
const answer = `Answer to: ${prompt.slice(-40)}`
out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: answer }] } })
out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: session, usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 15 } })
