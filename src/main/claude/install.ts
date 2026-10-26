import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

/*
  The Claude Code binary the app runs: one pinned release (pinned.ts, from the gpg-signed release
  manifest), downloaded into the app's data folder, accepted only with the pinned SHA-256 and
  Anthropic's code signature. A binary that stops matching is deleted and never runs.
*/

export interface Pinned {
  version: string
  repository: string
  platforms: Record<string, { binary: string; sha256: string; size: number }>
}

export type Progress = (done: number, total: number) => void
export type CheckSignature = (file: string) => Promise<boolean>

export class InstallError extends Error {
  readonly reason: "download" | "hash" | "signature" | "platform"

  constructor(reason: InstallError["reason"], message: string) {
    super(message)
    this.name = "InstallError"
    this.reason = reason
  }
}

export const PLATFORM = `${process.platform}-${process.arch}`

function entry(pinned: Pinned, platform: string) {
  const item = pinned.platforms[platform]
  if (!item) throw new InstallError("platform", `Study Lab has no Claude Code build for ${platform}.`)
  return item
}

/** One folder per version, inside the app's own Claude folder. */
export function binaryPath(root: string, pinned: Pinned, platform = PLATFORM): string {
  return join(root, "bin", pinned.version, entry(pinned, platform).binary)
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

/** Whether the installed binary is the pinned one. One that does not match is deleted. */
export async function verify(root: string, pinned: Pinned, platform = PLATFORM): Promise<"ok" | "missing" | "changed"> {
  const file = binaryPath(root, pinned, platform)
  try {
    await stat(file)
  } catch {
    return "missing"
  }
  if ((await sha256File(file)) === entry(pinned, platform).sha256) return "ok"
  await rm(file, { force: true })
  return "changed"
}

/** Download `url` to `target`, hashing on the way; stops once it grows past the pinned size. */
export async function download(url: string, target: string, onProgress: Progress, total: number): Promise<{ sha256: string; size: number }> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new InstallError("download", `The download failed: HTTP ${res.status}.`)
  const hash = createHash("sha256")
  let size = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      size += chunk.length
      if (total > 0 && size > total) return done(new InstallError("hash", "The download is larger than the pinned Claude Code."))
      onProgress(size, total)
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), count, createWriteStream(target))
  return { sha256: hash.digest("hex"), size }
}

/**
  Install the pinned Claude Code. The download goes to a `.partial` file and becomes the binary only
  with the right hash and signature; anything else is deleted.
*/
export async function install(o: { root: string; pinned: Pinned; platform?: string; onProgress: Progress; checkSignature: CheckSignature }): Promise<string> {
  const platform = o.platform ?? PLATFORM
  const item = entry(o.pinned, platform)
  const final = binaryPath(o.root, o.pinned, platform)
  if ((await verify(o.root, o.pinned, platform)) === "ok") return final
  await mkdir(dirname(final), { recursive: true })
  const partial = `${final}.partial`
  try {
    const { sha256 } = await download(`${o.pinned.repository}/${o.pinned.version}/${platform}/${item.binary}`, partial, o.onProgress, item.size)
    if (sha256 !== item.sha256) throw new InstallError("hash", "The downloaded Claude Code does not match the pinned release.")
    // macOS downloads are not executable, and codesign checks the file that will run.
    if (platform.startsWith("darwin")) await chmod(partial, 0o755)
    if (!(await o.checkSignature(partial))) throw new InstallError("signature", "The downloaded Claude Code is not signed by Anthropic.")
    await rename(partial, final)
    return final
  } catch (e) {
    await rm(partial, { force: true })
    if (e instanceof InstallError) throw e
    throw new InstallError("download", `The download failed: ${(e as Error).message}`)
  }
}

/* ---------- code signatures ---------- */

/** What Get-AuthenticodeSignature says about a file. */
export interface Authenticode {
  Status: number | string
  Subject: string | null
}

/** The attributes of an X.500 subject (`CN="Anthropic, PBC", O=…`), honouring quotes. */
export function subjectAttributes(subject: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const pair of subject.match(/[^,"]+=(?:"[^"]*"|[^,]*)/g) ?? []) {
    const i = pair.indexOf("=")
    const name = pair.slice(0, i).trim()
    const value = pair
      .slice(i + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
    if (!out.has(name)) out.set(name, value)
  }
  return out
}

/** A valid signature whose signer is Anthropic, PBC, the subject Claude Code's setup page publishes. */
export function signedByAnthropic(a: Authenticode): boolean {
  // Status comes as a number when the enum is serialised: 0 is Valid.
  const valid = a.Status === 0 || a.Status === "Valid"
  const attrs = subjectAttributes(a.Subject ?? "")
  return valid && attrs.get("CN") === "Anthropic, PBC" && attrs.get("O") === "Anthropic, PBC"
}

export const authenticodeByAnthropic: CheckSignature = (file) =>
  new Promise((resolve) => {
    // The path goes in an environment variable, never into the command text.
    const command = "$a = Get-AuthenticodeSignature -LiteralPath $env:STUDY_LAB_FILE; @{ Status = $a.Status; Subject = $a.SignerCertificate.Subject } | ConvertTo-Json -Compress"
    // An absolute path: Windows would search the current folder before the system one.
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      // A minimal environment: no PSModulePath, so no outside module can replace the cmdlet.
      { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", STUDY_LAB_FILE: file }, windowsHide: true },
      (err, out) => {
        if (err) return resolve(false)
        try {
          resolve(signedByAnthropic(JSON.parse(out) as Authenticode))
        } catch {
          resolve(false)
        }
      },
    )
  })

/** `codesign -dv` names Anthropic's Developer ID as the authority. */
export function anthropicOnMac(details: string): boolean {
  return /^Authority=Developer ID Application: Anthropic,? PBC \([A-Z0-9]{10}\)$/m.test(details)
}

function runCmd(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` })))
}

export const codesignByAnthropic: CheckSignature = async (file) => {
  if (!(await runCmd("codesign", ["--verify", "--strict", file])).ok) return false
  // codesign -dv writes the details to stderr.
  const d = await runCmd("codesign", ["-dv", "--verbose=2", file])
  return d.ok && anthropicOnMac(d.out)
}

/** The check for this system; any other system has none and refuses. */
export function systemSignature(platform = PLATFORM): CheckSignature {
  if (platform.startsWith("win32")) return authenticodeByAnthropic
  if (platform.startsWith("darwin")) return codesignByAnthropic
  return async () => false
}
