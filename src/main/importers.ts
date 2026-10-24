import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { defaultState } from "@shared/defaults"
import { detectUdemyFile, parseLecturesMd, parseQuestionsMd } from "@shared/udemy"
import type { AppState, ImportResult, KB, LabConfig, LabInfo, LabKind, Lecture, Question, StudyEvent, StudyPlan, InsightReport } from "@shared/types"
import { all, run, tx } from "./db"
import * as repo from "./repo"

function addLectures(labId: string, incoming: Lecture[]): Lecture[] {
  const existing = repo.getLectures(labId)
  if (!existing.length) {
    repo.replaceLectures(labId, incoming)
    return incoming
  }
  const byN = new Map(existing.map((l) => [l.n, l]))
  // Same course re-imported: lecture numbers line up with the same titles, so replace in place.
  const sameCourse = incoming.slice(0, 5).every((l) => byN.get(l.n)?.title === l.title)
  let lectures = incoming
  if (!sameCourse) {
    const offset = Math.ceil((Math.max(...existing.map((l) => l.n)) + 1) / 1000) * 1000
    lectures = incoming.map((l) => ({ ...l, n: l.n + offset }))
  }
  const keep = existing.filter((l) => !lectures.some((x) => x.n === l.n))
  repo.replaceLectures(labId, [...keep, ...lectures].sort((a, b) => a.n - b.n))
  return lectures
}

export async function importUdemy(labId: string, paths: string[]): Promise<ImportResult> {
  const cfg = repo.getConfig(labId)
  const result: ImportResult = { questions: 0, lectures: 0, topics: 0, cards: 0, sets: [], warnings: [] }
  for (const p of paths) {
    const text = await readFile(p, "utf8")
    const kind = detectUdemyFile(text)
    if (kind === "questions") {
      const parsed = parseQuestionsMd(text, { domain: cfg.domains[0]?.n ?? 1 })
      tx(() => {
        for (const q of parsed.questions) {
          // Keep the domain and status of questions that were already imported and organised.
          const prev = repo.getQuestion(labId, q.id)
          repo.upsertQuestion(labId, prev ? { ...q, d: prev.d, status: prev.status } : q)
        }
      })
      result.questions += parsed.questions.length
      result.sets.push(...new Set(parsed.questions.map((q) => q.set)))
      result.warnings.push(...parsed.warnings)
      if (!cfg.sources.course || cfg.sources.course === "Course") repo.updateLab(labId, { config: { sources: { ...cfg.sources, course: parsed.course } } })
    } else if (kind === "lectures") {
      const parsed = parseLecturesMd(text)
      const added = addLectures(labId, parsed.lectures)
      result.lectures += added.length
      const empty = added.filter((l) => !l.p.length).length
      if (empty) result.warnings.push(`${empty} lectures in ${parsed.course} have no transcript.`)
    } else {
      result.warnings.push(`${p.split(/[\\/]/).pop()} is not a Udemy Study Export file (expected the "Simulados" or "Transcrições" Markdown).`)
    }
  }
  return result
}

/** Import a Study Lab data folder (questions.json, kb.json, lectures.json), as built for AIF-C01 and AIP-C01. */
export async function importBundle(labId: string, dir: string): Promise<ImportResult> {
  const base = ["", "public/data", "dist/data", "data"].map((s) => join(dir, s)).find((d) => existsSync(join(d, "questions.json")))
  if (!base) throw new Error("No questions.json found in that folder (looked in ./, public/data, dist/data and data).")
  const read = async <T>(name: string): Promise<T | null> => (existsSync(join(base, name)) ? (JSON.parse(await readFile(join(base, name), "utf8")) as T) : null)
  const questions = (await read<Question[]>("questions.json")) ?? []
  const kb = await read<KB>("kb.json")
  const lectures = await read<Lecture[]>("lectures.json")
  const result: ImportResult = { questions: questions.length, lectures: lectures?.length ?? 0, topics: kb?.topics.length ?? 0, cards: kb?.cards.length ?? 0, sets: [], warnings: [] }
  tx(() => {
    questions.forEach((q, i) => repo.upsertQuestion(labId, { ...q, src: q.src ?? "course" }, i))
    if (kb) {
      kb.topics.forEach((t, i) => repo.upsertTopic(labId, t, i))
      kb.cards.forEach((c, i) => repo.upsertCard(labId, c, i))
      for (const [qid, ts] of Object.entries(kb.tags)) repo.setTags(labId, qid, ts)
      run("UPDATE labs SET built_at = ?, conflicts = ? WHERE id = ?", kb.builtAt ?? new Date().toISOString(), JSON.stringify(kb.conflicts ?? []), labId)
    }
  })
  if (lectures) repo.replaceLectures(labId, lectures)
  result.sets = [...new Set(questions.map((q) => q.set))]
  // Make sure every domain number used by the content exists in the lab.
  const cfg = repo.getConfig(labId)
  const used = new Set([...questions.map((q) => q.d), ...(kb?.topics.map((t) => t.d) ?? [])].filter((d) => d > 0))
  const missing = [...used].filter((d) => !cfg.domains.some((x) => x.n === d)).sort()
  if (missing.length) {
    const general = cfg.domains.length === 1 && cfg.domains[0].name === "General"
    const domains = [...(general ? [] : cfg.domains), ...[...used].filter((d) => general || missing.includes(d)).sort().map((n) => ({ n, name: `Domain ${n}`, short: `Domain ${n}`, w: 0 }))]
    const even = Math.round(100 / domains.length)
    repo.updateLab(labId, { config: { domains: domains.map((d) => ({ ...d, w: d.w || even })) } })
    result.warnings.push(`Added placeholder domains ${missing.join(", ")}. Name and weight them in Lab settings.`)
  }
  for (const src of new Set(questions.map((q) => q.src))) {
    if (!cfg.sources[src]) repo.updateLab(labId, { config: { sources: { ...repo.getConfig(labId).sources, [src]: questions.find((q) => q.src === src)?.src_name ?? src } } })
  }
  return result
}

/** Bring in progress exported from the original browser Study Lab (aifc01/aipc01-study-lab). */
export async function importProgress(labId: string, path: string): Promise<{ ok: boolean; error?: string }> {
  let parsed: { app?: string; state?: Partial<AppState> }
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return { ok: false, error: "The file could not be read as JSON." }
  }
  if (!parsed.state || !/study-lab$/.test(parsed.app ?? "")) return { ok: false, error: "This is not a Study Lab progress export." }
  const st = { ...defaultState(), ...parsed.state }
  const cur = repo.readState(labId)
  tx(() => {
    const newer = <T extends { t: number }>(a: T | undefined, b: T) => !a || (b.t ?? 0) > (a.t ?? 0)
    const q: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(st.srsq ?? {})) if (newer(cur.srsq[k], v)) q[k] = v
    const c: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(st.srsc ?? {})) if (newer(cur.srsc[k], v)) c[k] = v
    repo.saveState(labId, "srsq", { set: q })
    repo.saveState(labId, "srsc", { set: c })
    const notes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(st.notes ?? {})) if (!cur.notes[k] || v.at > cur.notes[k].at) notes[k] = v
    repo.saveState(labId, "notes", { set: notes })
    const m = st.meta
    if (m) {
      const log = { ...cur.meta.log }
      for (const [day, v] of Object.entries(m.log ?? {})) log[day] = log[day] ? { n: Math.max(log[day].n, v.n), r: Math.max(log[day].r, v.r), ok: Math.max(log[day].ok, v.ok), bad: Math.max(log[day].bad, v.bad), sec: Math.max(log[day].sec, v.sec) } : v
      const exams = new Map([...cur.meta.exams, ...(m.exams ?? [])].map((e) => [e.at, e]))
      repo.writeMeta(labId, {
        ...cur.meta,
        settings: { ...cur.meta.settings, ...(m.settings ?? {}) },
        log,
        exams: [...exams.values()].sort((a, b) => a.at - b.at).slice(-30),
        mistakes: { ...(m.mistakes ?? {}), ...cur.meta.mistakes },
        flags: { ...(m.flags ?? {}), ...cur.meta.flags },
      })
    }
  })
  return { ok: true }
}

interface LabFile {
  app: "study-lab"
  version: 1
  exportedAt: string
  lab: { name: string; kind: LabKind; description: string; config: LabConfig }
  content: { questions: Question[]; kb: KB }
  lectures: Lecture[]
  state: AppState
  events: StudyEvent[]
  plans: StudyPlan[]
  insights: InsightReport[]
}

export async function exportLab(labId: string, path: string) {
  const lab = repo.getLab(labId)
  const file: LabFile = {
    app: "study-lab",
    version: 1,
    exportedAt: new Date().toISOString(),
    lab: { name: lab.name, kind: lab.kind, description: lab.description, config: lab.config },
    content: repo.readContent(labId),
    lectures: repo.getLectures(labId),
    state: repo.readState(labId),
    events: repo.readEvents(labId),
    plans: repo.listPlans(labId),
    insights: repo.listInsights(labId),
  }
  await writeFile(path, JSON.stringify(file), "utf8")
}

export async function importLabFile(path: string): Promise<LabInfo> {
  const f = JSON.parse(await readFile(path, "utf8")) as LabFile
  if (f.app !== "study-lab" || !f.lab) throw new Error("This is not a Study Lab export (.studylab.json).")
  const taken = new Set(all<{ name: string }>("SELECT name FROM labs").map((r) => r.name))
  const name = taken.has(f.lab.name) ? `${f.lab.name} (imported)` : f.lab.name
  const lab = repo.createLab({ name, kind: f.lab.kind, description: f.lab.description })
  tx(() => {
    repo.updateLab(lab.id, { config: f.lab.config })
    f.content.questions.forEach((q, i) => repo.upsertQuestion(lab.id, q, i))
    f.content.kb.topics.forEach((t, i) => repo.upsertTopic(lab.id, t, i))
    f.content.kb.cards.forEach((c, i) => repo.upsertCard(lab.id, c, i))
    for (const [qid, ts] of Object.entries(f.content.kb.tags)) repo.setTags(lab.id, qid, ts)
    repo.saveState(lab.id, "srsq", { whole: f.state.srsq })
    repo.saveState(lab.id, "srsc", { whole: f.state.srsc })
    repo.saveState(lab.id, "notes", { whole: f.state.notes })
    repo.writeMeta(lab.id, f.state.meta)
    repo.addEvents(lab.id, f.events ?? [])
    for (const p of f.plans ?? []) repo.savePlan(lab.id, { ...p, id: repo.newId("plan-") })
    for (const r of f.insights ?? []) repo.saveInsight(lab.id, { ...r, id: repo.newId("ins_") })
  })
  repo.replaceLectures(lab.id, f.lectures ?? [])
  repo.setBuilt(lab.id, f.content.kb.conflicts)
  return repo.getLab(lab.id)
}
