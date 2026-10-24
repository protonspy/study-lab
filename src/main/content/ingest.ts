import { summarize, type ContentPackage, type PackageSummary } from "@shared/content-package"
import { GENERAL_DOMAIN } from "@shared/defaults"
import type { ImportResult, Question } from "@shared/types"
import { all, one, run, tx } from "../db"
import * as repo from "../repo"
import { ADAPTERS, detectAdapter } from "./adapters"

/* Content packages in, lab rows out. Re-importing a source updates it in place and keeps progress. */

export interface SourceInfo {
  id: string
  adapter: string
  provider: string
  title: string
  importedAt: number
  stats: { documents: number; items: number }
}

export function listSources(labId: string): SourceInfo[] {
  return all<{ id: string; adapter: string; provider: string; title: string; imported_at: number; stats: string }>(
    "SELECT id, adapter, provider, title, imported_at, stats FROM sources WHERE lab_id = ? ORDER BY imported_at",
    labId,
  ).map((r) => ({ id: r.id, adapter: r.adapter, provider: r.provider, title: r.title, importedAt: r.imported_at, stats: JSON.parse(r.stats) }))
}

function lectureBase(labId: string, sourceId: string): number {
  const prev = one<{ lecture_base: number }>("SELECT lecture_base FROM sources WHERE lab_id = ? AND id = ?", labId, sourceId)
  if (prev) return prev.lecture_base
  // Lectures already imported before sources were tracked keep their numbers.
  const others = one<{ m: number | null }>("SELECT MAX(n) m FROM lectures WHERE lab_id = ? AND (source_id IS NULL OR source_id != ?)", labId, sourceId)?.m
  return others == null ? 0 : Math.ceil((others + 1) / 1000) * 1000
}

export function ingestPackage(labId: string, pkg: ContentPackage): ImportResult {
  const src = pkg.source
  const result: ImportResult = { questions: 0, lectures: 0, topics: 0, cards: 0, sets: [], warnings: [] }
  tx(() => {
    const base = lectureBase(labId, src.id)
    // Legacy lectures with the same numbers but no source belong to this source when titles match.
    // A package without documents (e.g. only the quiz file of a course) leaves the source's documents alone.
    if (pkg.documents.length) {
      run("DELETE FROM lectures_fts WHERE lab_id = ? AND n IN (SELECT n FROM lectures WHERE lab_id = ? AND source_id = ?)", labId, labId, src.id)
      run("DELETE FROM lectures WHERE lab_id = ? AND source_id = ?", labId, src.id)
    }
    for (const d of pkg.documents) {
      const n = base + d.order
      const legacy = one<{ title: string }>("SELECT title FROM lectures WHERE lab_id = ? AND n = ?", labId, n)
      if (legacy) {
        run("DELETE FROM lectures WHERE lab_id = ? AND n = ?", labId, n)
        run("DELETE FROM lectures_fts WHERE lab_id = ? AND n = ?", labId, n)
      }
      run("INSERT INTO lectures(lab_id, n, title, sec, body, source_id, kind) VALUES(?, ?, ?, ?, ?, ?, ?)", labId, n, d.title, d.section ?? "", d.text, src.id, d.kind)
      run("INSERT INTO lectures_fts(lab_id, n, title, body) VALUES(?, ?, ?, ?)", labId, n, d.title, d.text)
      result.lectures++
    }
    const empty = pkg.documents.filter((d) => !d.text.trim()).length
    if (empty) result.warnings.push(`${empty} documents in ${src.title} have no text.`)

    const cfg = repo.getConfig(labId)
    const defaultD = cfg.domains[0]?.n ?? 1
    const keepIds = !!pkg.knowledge
    const knownTopics = new Set([...(pkg.knowledge?.topics.map((t) => t.id) ?? []), ...all<{ id: string }>("SELECT id FROM topics WHERE lab_id = ?", labId).map((r) => r.id)])
    let ord = (one<{ m: number | null }>("SELECT MAX(ord) m FROM questions WHERE lab_id = ?", labId)?.m ?? 0) + 1
    for (const a of pkg.assessments) {
      result.sets.push(a.title)
      for (const it of a.items) {
        const id = keepIds ? it.id : `${src.id}-${a.id}-${it.id}`
        const prev = repo.getQuestion(labId, id)
        const q: Question = {
          id,
          src: src.id,
          src_name: src.title,
          set: a.title,
          kind: a.kind === "exam" ? "exam" : "quiz",
          n: it.n,
          d: prev?.d ?? it.domain ?? defaultD,
          stem: it.stem,
          opts: it.options,
          ans: it.answer,
          why: it.options.map((_, i) => it.rationales?.[i] ?? ""),
          explanation: it.explanation ?? "",
          multi: it.answer.length > 1,
          status: prev?.status ?? "active",
        }
        repo.upsertQuestion(labId, q, prev ? undefined : ord++)
        run("UPDATE questions SET source_id = ? WHERE lab_id = ? AND id = ?", src.id, labId, id)
        const hinted = (it.topics ?? []).filter((t) => knownTopics.has(t))
        if (hinted.length && !(repo.getTags(labId)[id] ?? []).length) repo.setTags(labId, id, hinted)
        result.questions++
      }
    }

    if (pkg.knowledge) {
      pkg.knowledge.topics.forEach((t, i) => repo.upsertTopic(labId, t, i))
      pkg.knowledge.cards.forEach((c, i) => repo.upsertCard(labId, c, i))
      for (const [qid, ts] of Object.entries(pkg.knowledge.tags)) repo.setTags(labId, qid, ts)
      repo.setBuilt(labId, pkg.knowledge.conflicts)
      result.topics = pkg.knowledge.topics.length
      result.cards = pkg.knowledge.cards.length
    }

    // Setup hints and the source's display name.
    const generalOnly = cfg.domains.length === 1 && cfg.domains[0].name === GENERAL_DOMAIN.name
    const patch: Parameters<typeof repo.updateLab>[1]["config"] = { sources: { ...cfg.sources, [src.id]: src.title } }
    if (pkg.lab?.domains?.length && generalOnly) patch.domains = pkg.lab.domains
    if (pkg.lab?.exam && !cfg.exam) patch.exam = pkg.lab.exam
    repo.updateLab(labId, { config: patch })
    ensureDomains(labId, result)

    run(
      `INSERT INTO sources(lab_id, id, adapter, provider, title, url, language, lecture_base, imported_at, stats) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lab_id, id) DO UPDATE SET adapter = excluded.adapter, provider = excluded.provider, title = excluded.title, url = excluded.url,
         language = excluded.language, imported_at = excluded.imported_at, stats = excluded.stats`,
      labId,
      src.id,
      src.adapter,
      src.provider,
      src.title,
      src.url ?? null,
      src.language ?? null,
      base,
      Date.now(),
      JSON.stringify({
        documents: one<{ n: number }>("SELECT COUNT(*) n FROM lectures WHERE lab_id = ? AND source_id = ?", labId, src.id)!.n,
        items: one<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE lab_id = ? AND source_id = ?", labId, src.id)!.n,
      }),
    )
  })
  return result
}

/** Every domain number used by the content must exist in the lab; add named placeholders for the rest. */
function ensureDomains(labId: string, result: ImportResult) {
  const cfg = repo.getConfig(labId)
  const used = new Set(
    [
      ...all<{ d: number }>("SELECT DISTINCT d FROM questions WHERE lab_id = ?", labId).map((r) => r.d),
      ...all<{ d: number }>("SELECT DISTINCT d FROM topics WHERE lab_id = ?", labId).map((r) => r.d),
    ].filter((d) => d > 0),
  )
  const missing = [...used].filter((d) => !cfg.domains.some((x) => x.n === d)).sort((a, b) => a - b)
  if (!missing.length) return
  const general = cfg.domains.length === 1 && cfg.domains[0].name === GENERAL_DOMAIN.name && !used.has(cfg.domains[0].n)
  const domains = [...(general ? [] : cfg.domains), ...missing.map((n) => ({ n, name: `Domain ${n}`, short: `Domain ${n}`, w: 0 }))].sort((a, b) => a.n - b.n)
  const even = Math.round(100 / domains.length)
  repo.updateLab(labId, { config: { domains: domains.map((d) => ({ ...d, w: d.w || even })) } })
  result.warnings.push(`Added placeholder domains ${missing.join(", ")}. Name and weight them in Settings → Lab setup, or let the coach build the knowledge base.`)
}

/* ---------- preview → import, so the setup can show what it found before writing anything ---------- */

const previews = new Map<string, { packages: ContentPackage[]; at: number }>()

export async function previewImport(paths: string[], adapterId?: string): Promise<{ token: string; adapter: { id: string; name: string } | null; packages: PackageSummary[]; warnings: string[] }> {
  const adapter = adapterId ? ADAPTERS.find((a) => a.id === adapterId) ?? null : await detectAdapter(paths)
  if (!adapter) return { token: "", adapter: null, packages: [], warnings: ["No importer recognised these files. Pick the format by hand, or convert them to a content package."] }
  const { packages, warnings } = await adapter.parse(paths)
  const token = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  previews.set(token, { packages, at: Date.now() })
  for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60_000) previews.delete(k)
  return { token, adapter: { id: adapter.id, name: adapter.name }, packages: packages.map(summarize), warnings }
}

export function importPreview(labId: string, token: string): ImportResult {
  const p = previews.get(token)
  if (!p) throw new Error("That preview expired. Pick the files again.")
  previews.delete(token)
  const total: ImportResult = { questions: 0, lectures: 0, topics: 0, cards: 0, sets: [], warnings: [] }
  for (const pkg of p.packages) {
    const r = ingestPackage(labId, pkg)
    total.questions += r.questions
    total.lectures += r.lectures
    total.topics += r.topics
    total.cards += r.cards
    total.sets.push(...r.sets)
    total.warnings.push(...r.warnings)
  }
  return total
}

export function adapterList() {
  return ADAPTERS.map((a) => ({ id: a.id, name: a.name, description: a.description, pick: a.pick, extensions: a.extensions ?? [] }))
}
