import type { Card, Domain, ExamConfig, LabKind, Topic } from "./types"

/*
  Study Lab Content Package, v1: the one shape every importer produces and the app ingests.
  A source adapter (Udemy Study Export, a Study Lab data folder, plain documents, later Coursera…)
  only has to turn its input into this; ingestion, the knowledge-base builder and the coach never
  see source-specific formats. The JSON Schema lives in schemas/content-package.schema.json.
*/

export const PACKAGE_FORMAT = "study-lab/content-package"
export const PACKAGE_VERSION = 1

export interface PackageSource {
  /** adapter that produced the package, e.g. "udemy-study-export" */
  adapter: string
  /** platform or origin, e.g. "udemy", "coursera", "local" */
  provider: string
  /** stable id of the course/collection; re-importing the same id updates instead of duplicating */
  id: string
  title: string
  url?: string
  /** BCP 47 language of the material, e.g. "en", "pt-BR" */
  language?: string
  exportedAt?: string
}

export type DocumentKind = "lecture" | "reading" | "article" | "chapter" | "note" | "transcript"

/** Readable material: a lecture transcript, a reading, a chapter. */
export interface ContentDocument {
  /** stable within the source */
  id: string
  /** position in the course; drives lecture order (a weak prerequisite signal) */
  order: number
  title: string
  /** section or module the document belongs to */
  section?: string
  kind: DocumentKind
  /** plain text or Markdown; paragraphs separated by blank lines */
  text: string
  durationSec?: number
  url?: string
}

export interface AssessmentItem {
  /** stable within the assessment */
  id: string
  /** display number */
  n: number
  stem: string
  options: string[]
  /** 0-based indexes of the correct options */
  answer: number[]
  /** one rationale per option (why it is right or wrong) */
  rationales?: string[]
  explanation?: string
  /** optional hints the source already knows */
  domain?: number
  topics?: string[]
  /** a label from the source, e.g. the practice-exam area */
  label?: string
}

export interface Assessment {
  id: string
  title: string
  kind: "quiz" | "exam" | "practice"
  items: AssessmentItem[]
}

export interface ContentPackage {
  format: typeof PACKAGE_FORMAT
  version: typeof PACKAGE_VERSION
  source: PackageSource
  /** optional setup hints for a lab built from this package */
  lab?: { kind?: LabKind; domains?: Domain[]; exam?: ExamConfig | null }
  documents: ContentDocument[]
  assessments: Assessment[]
  /** an already-built knowledge base (e.g. from another Study Lab); topic and card ids are kept */
  knowledge?: { topics: Topic[]; cards: Card[]; tags: Record<string, string[]>; conflicts?: string[]; builtAt?: string }
}

export interface PackageSummary {
  source: PackageSource
  documents: number
  emptyDocuments: number
  sections: string[]
  assessments: { title: string; kind: string; items: number }[]
  items: number
  topics: number
  cards: number
}

export function summarize(p: ContentPackage): PackageSummary {
  return {
    source: p.source,
    documents: p.documents.length,
    emptyDocuments: p.documents.filter((d) => !d.text.trim()).length,
    sections: [...new Set(p.documents.map((d) => d.section).filter((x): x is string => !!x))],
    assessments: p.assessments.map((a) => ({ title: a.title, kind: a.kind, items: a.items.length })),
    items: p.assessments.reduce((n, a) => n + a.items.length, 0),
    topics: p.knowledge?.topics.length ?? 0,
    cards: p.knowledge?.cards.length ?? 0,
  }
}

/** Structural check; returns human-readable problems (empty when the package is valid). */
export function validatePackage(p: unknown): string[] {
  const errs: string[] = []
  const pkg = p as Partial<ContentPackage>
  if (!pkg || typeof pkg !== "object") return ["not an object"]
  if (pkg.format !== PACKAGE_FORMAT) errs.push(`format must be "${PACKAGE_FORMAT}"`)
  if (pkg.version !== PACKAGE_VERSION) errs.push(`version must be ${PACKAGE_VERSION}`)
  if (!pkg.source?.id || !pkg.source?.title || !pkg.source?.adapter) errs.push("source needs id, title and adapter")
  if (!Array.isArray(pkg.documents)) errs.push("documents must be an array")
  if (!Array.isArray(pkg.assessments)) errs.push("assessments must be an array")
  const docIds = new Set<string>()
  for (const d of pkg.documents ?? []) {
    if (!d.id || typeof d.text !== "string" || !d.title) errs.push(`document ${d.id ?? "?"} needs id, title and text`)
    if (docIds.has(d.id)) errs.push(`duplicate document id ${d.id}`)
    docIds.add(d.id)
  }
  for (const a of pkg.assessments ?? []) {
    for (const it of a.items ?? []) {
      const where = `${a.id}/${it.id}`
      if (!it.stem || !Array.isArray(it.options) || it.options.length < 2) errs.push(`item ${where} needs a stem and 2+ options`)
      else if (!Array.isArray(it.answer) || !it.answer.length || it.answer.some((i) => i < 0 || i >= it.options.length)) errs.push(`item ${where} has an invalid answer key`)
    }
  }
  return errs.slice(0, 20)
}
