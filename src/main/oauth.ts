import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { shell } from "electron"

/*
  "Connect with OpenRouter": OAuth PKCE with a loopback callback. OpenRouter accepts any
  http://localhost:<port> callback, so the app listens on a random local port, opens the
  browser on the consent page and swaps the returned code for an API key. No client secret,
  and the key never passes through anything but this machine and openrouter.ai.
  https://openrouter.ai/docs/guides/overview/auth/oauth
*/

const AUTH_URL = "https://openrouter.ai/auth"
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys"
const TIMEOUT_MS = 5 * 60_000

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export function pkcePair() {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;background:#10151c;color:#e8edf3;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:28rem;text-align:center}h1{font-size:1.4rem}p{color:#9aa7b6}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`

let pending: { server: Server; cancel: () => void } | null = null

export function cancelOAuth() {
  pending?.cancel()
}

/** Open the browser on OpenRouter's consent page and resolve with a new API key. */
export async function connectOpenRouter(opts: { keyLabel?: string; fetchImpl?: typeof fetch; open?: (url: string) => Promise<void> } = {}): Promise<string> {
  cancelOAuth()
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(16))
  const doFetch = opts.fetchImpl ?? fetch
  const open = opts.open ?? ((url: string) => shell.openExternal(url))

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, key?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      pending = null
      if (err) reject(err)
      else resolve(key!)
    }

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (url.pathname !== "/callback") {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get("code")
      if (!code || url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Not connected", "The sign-in was cancelled or did not come from Study Lab. You can close this tab."))
        finish(new Error("OpenRouter sign-in was cancelled."))
        return
      }
      try {
        const r = await doFetch(KEYS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
        })
        const body = (await r.json().catch(() => ({}))) as { key?: string; error?: { message?: string } }
        if (!r.ok || !body.key) throw new Error(body.error?.message ?? `OpenRouter returned HTTP ${r.status}`)
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Connected to OpenRouter", "Study Lab has its key. You can close this tab and go back to the app."))
        finish(null, body.key)
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end(page("Not connected", "The key exchange failed. Go back to Study Lab and try again."))
        finish(e as Error)
      }
    })

    const timer = setTimeout(() => finish(new Error("OpenRouter sign-in timed out.")), TIMEOUT_MS)
    pending = { server, cancel: () => finish(new Error("OpenRouter sign-in was cancelled.")) }

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      const auth = new URL(AUTH_URL)
      auth.searchParams.set("callback_url", `http://localhost:${port}/callback`)
      auth.searchParams.set("code_challenge", challenge)
      auth.searchParams.set("code_challenge_method", "S256")
      auth.searchParams.set("state", state)
      auth.searchParams.set("key_label", opts.keyLabel ?? "Study Lab")
      open(auth.toString()).catch((e: Error) => finish(e))
    })
    server.on("error", (e) => finish(e))
  })
}
