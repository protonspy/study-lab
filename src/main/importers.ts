import { readFile, writeFile } from "node:fs/promises"
import { defaultState } from "@shared/defaults"
import type { AppState, ImportResult, KB, LabConfig, LabInfo, LabKind, Lecture, Question, StudyEvent, StudyPlan, InsightReport } from "@shared/types"
import { importPreview, previewImport } from "./content/ingest"
import { all, tx } from "./db"
import * as repo from "./repo"

/** Import files with a given adapter (or the one that recognises them) in one step. */
export async function importWith(labId: string, paths: string[], adapterId?: string): Promise<ImportResult> {
  const p = await previewImport(paths, adapterId)
  if (!p.adapter) throw new Error(p.warnings[0] ?? "No importer recognised these files.")
  const r = importPreview(labId, p.token)
  return { ...r, warnings: [...p.warnings, ...r.warnings] }
}

export const importUdemy = (labId: string, paths: string[]) => importWith(labId, paths, "udemy-study-export")
export const importBundle = (labId: string, dir: string) => importWith(labId, [dir], "study-lab-bundle")

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
