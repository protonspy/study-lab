import { readFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { PACKAGE_FORMAT, PACKAGE_VERSION, validatePackage, type ContentDocument, type ContentPackage } from "@shared/content-package"
import { courseTitle, detectUdemyFile, shortHash, udemyToPackage } from "@shared/udemy"
import type { KB, Lecture, Question } from "@shared/types"

/*
  Source adapters. Each one recognises its own input and turns it into content packages.
  To support a new platform (Coursera, Khan Academy, a PDF folder…), add an adapter here: the rest
  of the app only ever sees ContentPackage.
*/

export interface ContentAdapter {
  id: string
  name: string
  description: string
  /** what the file dialog should ask for */
  pick: "files" | "directory"
  extensions?: string[]
  /** 0 = not mine, 1 = certainly mine */
  detect(paths: string[]): Promise<number>
  parse(paths: string[]): Promise<{ packages: ContentPackage[]; warnings: string[] }>
}

const read = (p: string) => readFile(p, "utf8")
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false

/* ---------- Udemy Study Export (Markdown) ---------- */

const udemy: ContentAdapter = {
  id: "udemy-study-export",
  name: "Udemy Study Export",
  description: "The Markdown files from the Udemy Study Export browser extension: “— Simulados” (quizzes and practice tests) and “— Transcrições (EN)” (lectures).",
  pick: "files",
  extensions: ["md", "markdown"],
  async detect(paths) {
    const kinds = await Promise.all(paths.filter((p) => /\.(md|markdown)$/i.test(p)).map(async (p) => detectUdemyFile(await read(p))))
    return kinds.length && kinds.every((k) => k !== "unknown") ? 1 : 0
  },
  async parse(paths) {
    // Group the two files of each course by course title, so questions and transcripts land in one package.
    const byCourse = new Map<string, { questions?: string; lectures?: string }>()
    const warnings: string[] = []
    for (const p of paths) {
      const text = await read(p)
      const kind = detectUdemyFile(text)
      if (kind === "unknown") {
        warnings.push(`${basename(p)} is not a Udemy Study Export file.`)
        continue
      }
      const title = courseTitle(text)
      const entry = byCourse.get(title) ?? {}
      entry[kind] = text
      byCourse.set(title, entry)
    }
    return { packages: [...byCourse.values()].map(udemyToPackage), warnings }
  },
}

/* ---------- Study Lab data folder (questions.json, kb.json, lectures.json) ---------- */

async function bundleBase(dir: string) {
  return ["", "public/data", "dist/data", "data"].map((s) => join(dir, s)).find((d) => existsSync(join(d, "questions.json")))
}

const bundle: ContentAdapter = {
  id: "study-lab-bundle",
  name: "Study Lab data folder",
  description: "A folder with questions.json, kb.json and lectures.json, as built for the browser Study Labs. Keeps its topics, notes and flashcards.",
  pick: "directory",
  async detect(paths) {
    return paths.length === 1 && (await isDir(paths[0])) && (await bundleBase(paths[0])) ? 1 : 0
  },
  async parse(paths) {
    const base = await bundleBase(paths[0])
    if (!base) throw new Error("No questions.json found in that folder (looked in ./, public/data, dist/data and data).")
    const json = async <T>(name: string): Promise<T | null> => (existsSync(join(base, name)) ? (JSON.parse(await read(join(base, name))) as T) : null)
    const questions = (await json<Question[]>("questions.json")) ?? []
    const kb = await json<KB>("kb.json")
    const lectures = (await json<Lecture[]>("lectures.json")) ?? []
    const title = basename(paths[0]).replace(/[-_]+/g, " ")
    const sets = new Map<string, ContentPackage["assessments"][number]>()
    for (const q of questions) {
      let a = sets.get(q.set)
      if (!a) {
        a = { id: q.set, title: q.set, kind: q.kind === "exam" ? "exam" : "quiz", items: [] }
        sets.set(q.set, a)
      }
      // Bundle question ids are global already; ingestion keeps them because the package carries knowledge.
      a.items.push({ id: q.id, n: q.n, stem: q.stem, options: q.opts, answer: q.ans, rationales: q.why, explanation: q.explanation || undefined, domain: q.d, label: q.src_name })
    }
    const pkg: ContentPackage = {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      source: { adapter: "study-lab-bundle", provider: "study-lab", id: `b${shortHash(title)}`, title },
      documents: lectures.map((l) => ({ id: String(l.n), order: l.n, title: l.title, section: l.sec || undefined, kind: "transcript", text: l.p.join("\n\n") })),
      assessments: [...sets.values()],
      knowledge: kb ? { topics: kb.topics, cards: kb.cards, tags: kb.tags, conflicts: kb.conflicts, builtAt: kb.builtAt } : undefined,
    }
    return { packages: [pkg], warnings: [] }
  },
}

/* ---------- Content package JSON (the native format) ---------- */

const native: ContentAdapter = {
  id: "content-package",
  name: "Content package (.json)",
  description: "Study Lab's standard format. Any exporter (a Coursera extension, a script, another app) can produce it.",
  pick: "files",
  extensions: ["json"],
  async detect(paths) {
    if (!paths.length || !paths.every((p) => /\.json$/i.test(p))) return 0
    const ok = await Promise.all(paths.map(async (p) => (await read(p)).includes(PACKAGE_FORMAT)))
    return ok.every(Boolean) ? 1 : 0
  },
  async parse(paths) {
    const packages: ContentPackage[] = []
    const warnings: string[] = []
    for (const p of paths) {
      const raw = JSON.parse(await read(p)) as unknown
      const list = Array.isArray(raw) ? raw : [raw]
      for (const pkg of list) {
        const errs = validatePackage(pkg)
        if (errs.length) warnings.push(`${basename(p)}: ${errs.join("; ")}`)
        else packages.push(pkg as ContentPackage)
      }
    }
    return { packages, warnings }
  },
}

/* ---------- Plain documents (Markdown / text) ---------- */

/** Split long Markdown on top-level headings so each document stays a readable unit. */
export function splitMarkdown(text: string, title: string): { title: string; text: string }[] {
  const parts = text.split(/^(?=#{1,2} )/m).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2 || text.length < 12_000) return [{ title, text: text.trim() }]
  return parts.map((p) => {
    const m = p.match(/^#{1,2} (.+)$/m)
    return { title: m ? m[1].trim() : title, text: p.replace(/^#{1,2} .+\n?/, "").trim() }
  })
}

const documents: ContentAdapter = {
  id: "documents",
  name: "Notes and documents",
  description: "Markdown or plain-text files (notes, book chapters, articles). Each file, or each top-level heading of a long file, becomes a document.",
  pick: "files",
  extensions: ["md", "markdown", "txt"],
  async detect(paths) {
    return paths.length && paths.every((p) => /\.(md|markdown|txt)$/i.test(p)) ? 0.3 : 0
  },
  async parse(paths) {
    const docs: ContentDocument[] = []
    for (const p of [...paths].sort()) {
      const name = basename(p, extname(p))
      for (const part of splitMarkdown(await read(p), name)) {
        docs.push({ id: `${shortHash(p)}-${docs.length + 1}`, order: docs.length + 1, title: part.title, section: name, kind: "note", text: part.text })
      }
    }
    const title = paths.length === 1 ? basename(paths[0], extname(paths[0])) : `${paths.length} documents`
    return {
      packages: [
        {
          format: PACKAGE_FORMAT,
          version: PACKAGE_VERSION,
          source: { adapter: "documents", provider: "local", id: `d${shortHash(paths.map((p) => basename(p)).sort().join("|"))}`, title },
          documents: docs,
          assessments: [],
        },
      ],
      warnings: [],
    }
  },
}

export const ADAPTERS: ContentAdapter[] = [udemy, bundle, native, documents]

export async function detectAdapter(paths: string[]): Promise<ContentAdapter | null> {
  let best: { a: ContentAdapter; score: number } | null = null
  for (const a of ADAPTERS) {
    const score = await a.detect(paths).catch(() => 0)
    if (score > (best?.score ?? 0)) best = { a, score }
  }
  return best?.a ?? null
}
