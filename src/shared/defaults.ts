import type { AppState, Domain, LabConfig, LabKind, Meta, Settings } from "./types"

export const DEFAULT_SETTINGS: Settings = {
  examDate: null,
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

export const PRESETS: LabPreset[] = [
  {
    id: "blank",
    name: "Blank lab",
    kind: "other",
    description: "Start empty. Import content, or let the coach build topics from it.",
    config: {},
  },
  {
    id: "certification",
    name: "Certification exam",
    kind: "certification",
    description: "A timed multiple-choice exam with a pass mark. Edit the numbers in Lab settings.",
    config: { exam: { code: "EXAM", questions: 65, scored: 65, minutes: 90, pass: 700, min: 100, max: 1000 } },
  },
  {
    id: "aif-c01",
    name: "AWS Certified AI Practitioner (AIF-C01)",
    kind: "certification",
    description: "65 questions, 90 minutes, pass at 700 on a 100–1000 scale.",
    config: {
      domains: [
        { n: 1, name: "Fundamentals of AI and ML", short: "AI & ML fundamentals", w: 20 },
        { n: 2, name: "Fundamentals of Generative AI", short: "GenAI fundamentals", w: 24 },
        { n: 3, name: "Applications of Foundation Models", short: "FM applications", w: 28 },
        { n: 4, name: "Guidelines for Responsible AI", short: "Responsible AI", w: 14 },
        { n: 5, name: "Security, Compliance & Governance for AI Solutions", short: "Security & governance", w: 14 },
      ],
      exam: { code: "AIF-C01", questions: 65, scored: 50, minutes: 90, pass: 700, min: 100, max: 1000, extraMinutes: 30, extraLabel: "ESL +30" },
      sources: { ...DEFAULT_SOURCES, course: "Ultimate course" },
    },
  },
  {
    id: "aip-c01",
    name: "AWS Certified Generative AI Developer – Professional (AIP-C01)",
    kind: "certification",
    description: "75 questions, 180 minutes, pass at 750 on a 100–1000 scale.",
    config: {
      domains: [
        { n: 1, name: "Foundation Model Integration, Data Management & Compliance", short: "FM integration & data", w: 31 },
        { n: 2, name: "Implementation & Integration", short: "Implementation", w: 26 },
        { n: 3, name: "AI Safety, Security & Governance", short: "Safety & security", w: 20 },
        { n: 4, name: "Operational Efficiency & Optimization", short: "Optimization", w: 12 },
        { n: 5, name: "Testing, Validation & Troubleshooting", short: "Testing & troubleshooting", w: 11 },
      ],
      exam: { code: "AIP-C01", questions: 75, scored: 65, minutes: 180, pass: 750, min: 100, max: 1000, extraMinutes: 30, extraLabel: "ESL +30" },
      sources: { ...DEFAULT_SOURCES, pack: "Practice pack", ult: "Ultimate course" },
    },
  },
  {
    id: "language",
    name: "Language",
    kind: "language",
    description: "Vocabulary, grammar and listening. Domains: vocabulary, grammar, reading, listening.",
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
    id: "course",
    name: "Online course",
    kind: "course",
    description: "Lectures and quizzes from a course, such as a Udemy export.",
    config: {},
  },
]

export function presetConfig(id: string | undefined): { kind: LabKind; config: LabConfig } {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0]
  return { kind: p.kind, config: { ...emptyConfig(), ...structuredClone(p.config) } }
}

export const LANGUAGES = ["Português (Brasil)", "English", "Español"]
