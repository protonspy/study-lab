import type { AppState, Domain, LabConfig, LabKind, Meta, Settings } from "./types"

export const DEFAULT_SETTINGS: Settings = {
  examDate: null,
  minutesPerDay: 45,
  newCards: 30,
  newQs: 15,
  sessionMax: 120,
  shuffle: true,
  highlight: true,
  confidence: true,
  typeAnswer: false,
  esl: false,
  theme: "system",
}

export function defaultMeta(): Meta {
  return { settings: { ...DEFAULT_SETTINGS }, log: {}, exams: [], active: null, mistakes: {}, flags: {}, au: 0 }
}

export function defaultState(): AppState {
  return { srsq: {}, srsc: {}, meta: defaultMeta(), notes: {} }
}

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017"

export const DEFAULT_SOURCES: Record<string, string> = {
  course: "Course",
  lab: "Lab questions",
  agent: "Coach",
}

export const GENERAL_DOMAIN: Domain = { n: 1, name: "General", short: "General", w: 100 }

export function emptyConfig(): LabConfig {
  return { domains: [{ ...GENERAL_DOMAIN }], exam: null, sources: { ...DEFAULT_SOURCES }, memory: "", focus: [], collections: [] }
}

export interface LabPreset {
  id: string
  name: string
  kind: LabKind
  description: string
  config: Partial<LabConfig>
}

/** Starting points for a lab. They are deliberately subject-agnostic: content and the coach fill in the rest. */
export const PRESETS: LabPreset[] = [
  {
    id: "certification",
    name: "Certification exam",
    kind: "certification",
    description: "A timed multiple-choice exam with a pass mark. Set the exam format; domains come from your content or the exam guide.",
    config: { exam: { code: "EXAM", questions: 65, scored: 65, minutes: 90, pass: 700, min: 100, max: 1000 } },
  },
  {
    id: "course",
    name: "Course",
    kind: "course",
    description: "Lectures, readings and quizzes from an online course (Udemy, Coursera…). Topics come from the material.",
    config: {},
  },
  {
    id: "language",
    name: "Language",
    kind: "language",
    description: "Vocabulary, grammar, reading and listening.",
    config: {
      domains: [
        { n: 1, name: "Vocabulary", short: "Vocabulary", w: 35 },
        { n: 2, name: "Grammar", short: "Grammar", w: 30 },
        { n: 3, name: "Reading", short: "Reading", w: 20 },
        { n: 4, name: "Listening & speaking", short: "Listening", w: 15 },
      ],
    },
  },
  {
    id: "subject",
    name: "Subject or skill",
    kind: "other",
    description: "A school subject, a book or a skill you are learning on your own.",
    config: {},
  },
  {
    id: "blank",
    name: "Blank",
    kind: "other",
    description: "Start empty and set everything up yourself.",
    config: {},
  },
]

export function presetConfig(id: string | undefined): { kind: LabKind; config: LabConfig } {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[PRESETS.length - 1]
  return { kind: p.kind, config: { ...emptyConfig(), ...structuredClone(p.config) } }
}

export const LANGUAGES = ["Português (Brasil)", "English", "Español"]
