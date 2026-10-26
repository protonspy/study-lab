/* How a tool call reads in the coach's progress line and in the chat, whichever harness ran it. */

const STEP_LABEL: Record<string, string> = {
  get_overview: "Reading your analytics",
  list_topics: "Reviewing topics",
  get_topic_report: "Studying a topic",
  get_graph: "Reading the knowledge graph",
  list_mistakes: "Looking at your mistakes",
  get_question: "Reading a question",
  search_content: "Searching the course",
  read_lecture: "Reading a lecture",
  list_items: "Checking items",
  get_plan: "Checking the plan",
  compute_plan: "Computing the schedule",
  get_lab: "Reading the lab setup",
  create_flashcards: "Writing flashcards",
  create_questions: "Writing questions",
  write_study_guide: "Writing a study guide",
  save_study_plan: "Saving the plan",
  save_insight_report: "Saving the report",
  set_focus: "Pinning focus topics",
  create_collection: "Building a practice set",
  upsert_topic: "Organising topics",
  tag_questions: "Tagging questions",
  set_item_status: "Managing material",
  remember: "Saving a note",
  read_file: "Reading a skill",
  read_skill: "Reading a skill",
  task: "Delegating to a sub-agent",
  write_todos: "Planning the work",
}

export function stepLabel(name: string, servers: string[] = []) {
  const server = servers.find((s) => name.startsWith(`${s}_`))
  return STEP_LABEL[name] ?? (server ? `Using ${server}` : name.replace(/_/g, " "))
}

export function summarize(text: string): string {
  if (text.startsWith("ERROR:")) return text.slice(6, 206).trim()
  try {
    const r = JSON.parse(text) as Record<string, unknown> | unknown[]
    if (Array.isArray(r)) return `${r.length} rows`
    if (typeof r.created === "number") return `created ${r.created}`
    if (typeof r.updated === "number") return `updated ${r.updated}`
    if (typeof r.tagged === "number") return `tagged ${r.tagged}`
  } catch {
    /* not JSON */
  }
  return ""
}
