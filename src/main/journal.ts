import type { Card, LabConfig, Question, Settings, StudyPlan, Topic } from "@shared/types"
import { all, one, run, tx } from "./db"
import * as repo from "./repo"

/*
  Every write the coach makes goes through a Change. Before touching an item it snapshots the
  item as it was; commit() stores the snapshots, and undo() writes them back in reverse order.
  Items that did not exist are snapshotted as null, so undoing a creation deletes it.
*/

type Snap =
  | { t: "question"; id: string; before: Question | null; tags: string[] }
  | { t: "card"; id: string; before: Card | null }
  | { t: "topic"; id: string; before: Topic | null; tagged: { qid: string; ord: number }[] }
  | { t: "config"; before: LabConfig }
  | { t: "settings"; before: Settings }
  | { t: "plan"; id: string; before: StudyPlan | null }

export class Change {
  private snaps: Snap[] = []
  private seen = new Set<string>()
  readonly touched = new Set<"content" | "config" | "plans" | "state">()

  readonly labId: string
  readonly actor: string
  readonly tool: string

  constructor(labId: string, actor: string, tool: string) {
    this.labId = labId
    this.actor = actor
    this.tool = tool
  }

  private once(key: string) {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }

  question(id: string) {
    this.touched.add("content")
    if (!this.once(`q:${id}`)) return
    this.snaps.push({ t: "question", id, before: repo.getQuestion(this.labId, id), tags: repo.getTags(this.labId)[id] ?? [] })
  }

  card(id: string) {
    this.touched.add("content")
    if (this.once(`c:${id}`)) this.snaps.push({ t: "card", id, before: repo.getCard(this.labId, id) })
  }

  topic(id: string) {
    this.touched.add("content")
    if (!this.once(`t:${id}`)) return
    const tagged = all<{ qid: string; ord: number }>("SELECT qid, ord FROM question_topics WHERE lab_id = ? AND topic_id = ?", this.labId, id)
    this.snaps.push({ t: "topic", id, before: repo.getTopic(this.labId, id), tagged })
  }

  config() {
    this.touched.add("config")
    if (this.once("config")) this.snaps.push({ t: "config", before: repo.getConfig(this.labId) })
  }

  settings() {
    this.touched.add("state")
    if (this.once("settings")) this.snaps.push({ t: "settings", before: repo.readMeta(this.labId).settings })
  }

  plan(id: string) {
    this.touched.add("plans")
    if (this.once(`p:${id}`)) this.snaps.push({ t: "plan", id, before: repo.getPlan(this.labId, id) })
  }

  get empty() {
    return this.snaps.length === 0
  }

  commit(summary: string): number | null {
    if (!this.snaps.length) return null
    const r = run(
      "INSERT INTO changes(lab_id, at, actor, tool, summary, undo) VALUES(?, ?, ?, ?, ?, ?)",
      this.labId,
      Date.now(),
      this.actor,
      this.tool,
      summary.slice(0, 500),
      JSON.stringify(this.snaps),
    )
    return Number(r.lastInsertRowid)
  }
}

export function undo(labId: string, id: number): { ok: boolean; error?: string; touched: string[] } {
  const row = one<{ undo: string; undone: number }>("SELECT undo, undone FROM changes WHERE lab_id = ? AND id = ?", labId, id)
  if (!row) return { ok: false, error: "That change is gone.", touched: [] }
  if (row.undone) return { ok: false, error: "Already undone.", touched: [] }
  const snaps = JSON.parse(row.undo) as Snap[]
  const touched = new Set<string>()
  tx(() => {
    for (const s of [...snaps].reverse()) {
      switch (s.t) {
        case "question":
          touched.add("content")
          if (s.before) {
            repo.upsertQuestion(labId, s.before)
            repo.setTags(labId, s.id, s.tags)
          } else repo.deleteQuestion(labId, s.id)
          break
        case "card":
          touched.add("content")
          if (s.before) repo.upsertCard(labId, s.before)
          else repo.deleteCard(labId, s.id)
          break
        case "topic":
          touched.add("content")
          if (s.before) {
            repo.upsertTopic(labId, s.before)
            run("DELETE FROM question_topics WHERE lab_id = ? AND topic_id = ?", labId, s.id)
            for (const t of s.tagged) run("INSERT OR IGNORE INTO question_topics(lab_id, qid, topic_id, ord) VALUES(?, ?, ?, ?)", labId, t.qid, s.id, t.ord)
          } else repo.deleteTopic(labId, s.id)
          break
        case "config":
          touched.add("config")
          repo.updateLab(labId, { config: s.before })
          break
        case "settings": {
          touched.add("state")
          const meta = repo.readMeta(labId)
          repo.writeMeta(labId, { ...meta, settings: s.before })
          break
        }
        case "plan":
          touched.add("plans")
          if (s.before) repo.savePlan(labId, s.before)
          else repo.deletePlan(labId, s.id)
          break
      }
    }
    run("UPDATE changes SET undone = 1 WHERE id = ?", id)
  })
  return { ok: true, touched: [...touched] }
}
