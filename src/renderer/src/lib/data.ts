import { useSyncExternalStore } from "react"
import type { Card, Domain, ExamConfig, KB, KnowledgeGraph, LabContent, LabInfo, Lecture, Question, Topic } from "./types"

/*
  The open lab's content. Domain list, exam format and source labels come from the lab's config,
  so they are live bindings that change when you switch labs: read them at render time, never
  copy them into module-level constants.
*/

export let LAB: LabInfo | null = null

export let DOMAINS: Domain[] = []

const FALLBACK_EXAM: ExamConfig = { code: "Mock test", questions: 40, scored: 40, minutes: 60, pass: 70, min: 0, max: 100 }

/** The lab's exam, or a plain percentage test when the lab has none. */
export let EXAM_FACTS: ExamConfig = FALLBACK_EXAM
export let HAS_EXAM = false

/** Questions per domain in a full mock, from the domain weights. */
export let EXAM_MIX: Record<number, number> = {}

/** First-attempt accuracy that maps to the pass mark on the linear score estimate. */
export let PASS_ACC = 70

export let SOURCE_NAMES: Record<string, string> = {}

export interface Data {
  /** questions in rotation (suspended and archived ones are left out) */
  questions: Question[]
  /** every question, including suspended and archived */
  allQuestions: Question[]
  qById: Map<string, Question>
  kb: KB
  cards: Card[]
  allCards: Card[]
  cardById: Map<string, Card>
  topics: Topic[]
  topicById: Map<string, Topic>
  qByTopic: Map<string, Question[]>
  cardsByTopic: Map<string, Card[]>
  sets: { name: string; src: string; kind: string; count: number }[]
  graph: KnowledgeGraph
  kcById: Map<string, KnowledgeGraph["kcs"][number]>
}

let DATA: Data | null = null
let version = 0
const listeners = new Set<() => void>()

export function data(): Data {
  if (!DATA) throw new Error("No lab is open")
  return DATA
}

/** Re-renders when the lab's content or config changes. */
export function useDataVersion() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => version,
    () => version,
  )
}

export function setLabInfo(lab: LabInfo) {
  LAB = lab
  const cfg = lab.config
  DOMAINS = cfg.domains
  HAS_EXAM = !!cfg.exam
  EXAM_FACTS = cfg.exam ?? { ...FALLBACK_EXAM, code: lab.name }
  const total = DOMAINS.reduce((a, d) => a + d.w, 0) || 1
  EXAM_MIX = Object.fromEntries(DOMAINS.map((d) => [d.n, Math.round((EXAM_FACTS.questions * d.w) / total)]))
  PASS_ACC = Math.round(((EXAM_FACTS.pass - EXAM_FACTS.min) / Math.max(1, EXAM_FACTS.max - EXAM_FACTS.min)) * 100)
  SOURCE_NAMES = { ...cfg.sources }
  bump()
}

export function setContent(content: LabContent) {
  const active = <T extends { status?: string }>(x: T) => !x.status || x.status === "active"
  const allQuestions = content.questions
  const questions = allQuestions.filter(active)
  const kb = content.kb
  const allCards = kb.cards
  const cards = allCards.filter(active)
  const qById = new Map(allQuestions.map((q) => [q.id, q]))
  const cardById = new Map(allCards.map((c) => [c.id, c]))
  const topicById = new Map(kb.topics.map((t) => [t.id, t]))
  const qByTopic = new Map<string, Question[]>()
  for (const q of questions) {
    for (const t of kb.tags[q.id] ?? []) {
      if (!qByTopic.has(t)) qByTopic.set(t, [])
      qByTopic.get(t)!.push(q)
    }
  }
  const cardsByTopic = new Map<string, Card[]>()
  for (const c of cards) {
    if (!cardsByTopic.has(c.t)) cardsByTopic.set(c.t, [])
    cardsByTopic.get(c.t)!.push(c)
  }
  const setMap = new Map<string, { name: string; src: string; kind: string; count: number }>()
  for (const q of questions) {
    const s = setMap.get(q.set) ?? { name: q.set, src: q.src, kind: q.kind, count: 0 }
    s.count++
    setMap.set(q.set, s)
  }
  const graph = content.graph
  DATA = {
    questions,
    allQuestions,
    qById,
    kb: { ...kb, cards },
    cards,
    allCards,
    cardById,
    topics: kb.topics,
    topicById,
    qByTopic,
    cardsByTopic,
    sets: [...setMap.values()],
    graph,
    kcById: new Map(graph.kcs.map((k) => [k.id, k])),
  }
  LECTURES = null
  bump()
}

export function clearLab() {
  LAB = null
  DATA = null
  LECTURES = null
  bump()
}

function bump() {
  version++
  for (const fn of listeners) fn()
}

let LECTURES: Promise<Lecture[]> | null = null
export function loadLectures(): Promise<Lecture[]> {
  if (!LAB) return Promise.resolve([])
  if (!LECTURES)
    LECTURES = window.studyLab.api.getLectures(LAB.id).catch((e) => {
      LECTURES = null
      throw e
    })
  return LECTURES
}

export function topicsOf(qid: string): string[] {
  return data().kb.tags[qid] ?? []
}

export function sourceName(src: string, fallback?: string): string {
  return SOURCE_NAMES[src] ?? fallback ?? src
}

export function domainOf(n: number): Domain | undefined {
  return DOMAINS.find((d) => d.n === n)
}

export function shortSetName(name: string): string {
  return name
    .replace(/ - AWS Certified [^-]+$/, "")
    .replace(/: AWS Certified .+$/, "")
    .replace(/^(.*) - Quiz$/, "Quiz · $1")
    .replace(/^Quiz: /, "Quiz · ")
    .replace(/^Lab · /, "")
}
