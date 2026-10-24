import { PACKAGE_FORMAT, PACKAGE_VERSION, type Assessment, type ContentPackage } from "./content-package"
import type { Lecture, Question } from "./types"

/*
  Parsers for the Markdown files written by the "Udemy Study Export" browser extension:
  - "<course> — Simulados": quizzes and practice tests (### Questão N, options, <details> answer key);
  - "<course> — Transcrições (EN)": lecture transcripts (## section, ### N. lecture title, paragraphs).
  Pure functions, so they run in the main process and in tests alike.
*/

export type UdemyFileKind = "questions" | "lectures" | "unknown"

export function detectUdemyFile(text: string): UdemyFileKind {
  if (/^### Questão \d+/m.test(text) && /\*\*Correta:\*\*/.test(text)) return "questions"
  if (/^### \d+\. /m.test(text)) return "lectures"
  return "unknown"
}

export function courseTitle(text: string): string {
  const m = text.match(/^# (?:Course: )?(.+?)(?: — (?:Simulados|Transcrições.*))?\s*$/m)
  return m ? m[1].trim() : "Imported course"
}

/** Short stable hash, so re-importing the same course updates questions instead of duplicating them. */
export function shortHash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).slice(0, 5)
}

const OPT = /^- \*\*([A-H])\)\*\* ?(.*)$/
const RAT = /^- ([A-H]): ?(.*)$/
const QHEAD = /^### Questão (\d+)(?: — (.+))?\s*$/

export function parseQuestionsMd(text: string, opts: { domain?: number; src?: string } = {}): { course: string; questions: Question[]; warnings: string[] } {
  const course = courseTitle(text)
  const key = `u${shortHash(course)}`
  const lines = text.split(/\r?\n/)
  const out: Question[] = []
  const warnings: string[] = []
  let setName = ""
  let setKind: "exam" | "quiz" = "quiz"
  let setIdx = 0
  let state: "stem" | "opts" | "ans" | "exp" | null = null
  let cur: (Question & { _stem: string[]; _exp: string[]; _why: Record<number, string> }) | null = null

  const flush = () => {
    if (!cur) return
    const { _stem, _exp, _why, ...q } = cur
    q.stem = _stem.join("\n").trim()
    q.explanation = _exp.join("\n").trim()
    q.why = q.opts.map((_, i) => (_why[i] ?? "").replace(/^(In)?[Cc]orrect\.\s*/, ""))
    q.multi = q.ans.length > 1
    if (!q.stem || q.opts.length < 2 || !q.ans.length || Math.max(...q.ans) >= q.opts.length) warnings.push(`Skipped ${setName} · Q${q.n}: incomplete question`)
    else out.push(q)
    cur = null
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush()
      const m = line.match(/^## (.*?) \((practice-test|simple-quiz|[\w-]+)\)\s*$/)
      setName = (m ? m[1] : line.slice(3)).trim()
      setKind = m?.[2] === "practice-test" ? "exam" : "quiz"
      setIdx++
      state = null
      continue
    }
    const h = line.match(QHEAD)
    if (h) {
      flush()
      const n = Number(h[1])
      cur = {
        id: `${key}-${setIdx}-${n}`,
        src: opts.src ?? "course",
        src_name: course,
        set: setName || "Questions",
        kind: setKind,
        n,
        d: opts.domain ?? 1,
        stem: "",
        opts: [],
        ans: [],
        why: [],
        explanation: "",
        multi: false,
        _stem: [],
        _exp: [],
        _why: {},
      }
      state = "stem"
      continue
    }
    if (!cur) continue
    if (state === "stem") {
      const o = line.match(OPT)
      if (o) {
        state = "opts"
        cur.opts.push(o[2].trim())
      } else cur._stem.push(line)
      continue
    }
    if (state === "opts") {
      const o = line.match(OPT)
      if (o) cur.opts.push(o[2].trim())
      else if (line.startsWith("<details>")) state = "ans"
      continue
    }
    if (state === "ans") {
      if (line.startsWith("**Correta:**")) {
        cur.ans = [...line.split("**Correta:**")[1].matchAll(/[A-H]/g)].map((m) => m[0].charCodeAt(0) - 65)
        continue
      }
      const r = line.match(RAT)
      if (r) {
        cur._why[r[1].charCodeAt(0) - 65] = r[2].trim()
        continue
      }
      if (line.startsWith("**Explicação:**")) {
        state = "exp"
        cur._exp.push(line.split("**Explicação:**")[1].trim())
        continue
      }
      if (line.startsWith("</details>")) state = null
      continue
    }
    if (state === "exp") {
      if (line.startsWith("</details>")) state = null
      else cur._exp.push(line)
    }
  }
  flush()
  return { course, questions: out, warnings }
}

export function parseLecturesMd(text: string): { course: string; lectures: Lecture[] } {
  const lectures: Lecture[] = []
  let sec = ""
  let cur: Lecture | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (raw.startsWith("## ")) {
      sec = raw.slice(3).trim()
      continue
    }
    const m = raw.match(/^### (\d+)\. (.*)$/)
    if (m) {
      cur = { n: Number(m[1]), title: m[2].trim(), sec, p: [] }
      lectures.push(cur)
      continue
    }
    if (cur && line && !/^_\(sem legenda.*\)_$/.test(line) && !/^_\(erro ao baixar.*\)_$/.test(line)) cur.p.push(line)
  }
  return { course: courseTitle(text), lectures }
}

/**
 * Turn one course's Udemy Study Export files (questions and/or transcripts) into a content package.
 * Ids reproduce the earlier importer's (u<hash>-<set>-<n>), so progress survives re-imports.
 */
export function udemyToPackage(files: { questions?: string; lectures?: string }): ContentPackage {
  const q = files.questions ? parseQuestionsMd(files.questions) : null
  const l = files.lectures ? parseLecturesMd(files.lectures) : null
  const course = q?.course ?? l?.course ?? "Imported course"
  const sets = new Map<string, Assessment>()
  for (const x of q?.questions ?? []) {
    const setIdx = x.id.split("-")[1]
    let a = sets.get(setIdx)
    if (!a) {
      a = { id: setIdx, title: x.set, kind: x.kind === "exam" ? "exam" : "quiz", items: [] }
      sets.set(setIdx, a)
    }
    a.items.push({ id: String(x.n), n: x.n, stem: x.stem, options: x.opts, answer: x.ans, rationales: x.why, explanation: x.explanation || undefined })
  }
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    source: { adapter: "udemy-study-export", provider: "udemy", id: `u${shortHash(course)}`, title: course, language: l ? "en" : undefined },
    documents: (l?.lectures ?? []).map((x) => ({ id: String(x.n), order: x.n, title: x.title, section: x.sec || undefined, kind: "transcript" as const, text: x.p.join("\n\n") })),
    assessments: [...sets.values()],
  }
}
