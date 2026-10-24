import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import type { SkillInfo } from "@shared/types"

/*
  Skills are folders with a SKILL.md (YAML front matter: name, description). The agent sees only
  names and descriptions, and reads a skill's body when a task calls for it (DeepAgents' progressive
  disclosure). Built-in skills ship with the app; your own live in the user data folder.
*/


export function builtinSkillsDir(): string {
  if (process.env.STUDY_LAB_BUILTIN_SKILLS) return process.env.STUDY_LAB_BUILTIN_SKILLS
  return app.isPackaged ? join(process.resourcesPath, "skills") : join(app.getAppPath(), "resources", "skills")
}

export function userSkillsDir(): string {
  const dir = process.env.STUDY_LAB_USER_SKILLS ?? join(app.getPath("userData"), "skills")
  mkdirSync(dir, { recursive: true })
  return dir
}

export function parseSkill(text: string): { name: string; description: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const field = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? ""
  const name = field("name")
  return name ? { name, description: field("description"), body: m[2].trim() } : null
}

function readDir(dir: string, builtin: boolean): SkillInfo[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => {
      const s = parseSkill(readFileSync(join(dir, d.name, "SKILL.md"), "utf8"))
      return s ? { ...s, builtin } : null
    })
    .filter((x): x is SkillInfo => !!x)
}

export function listSkills(): SkillInfo[] {
  const user = readDir(userSkillsDir(), false)
  const builtin = readDir(builtinSkillsDir(), true).filter((b) => !user.some((u) => u.name === b.name))
  return [...builtin, ...user].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name))
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)

/** Create or replace one of your skills. A user skill with a built-in's name overrides it. */
export function saveSkill(input: { name: string; description: string; body: string }): SkillInfo {
  const name = slug(input.name)
  if (!name) throw new Error("A skill needs a name (letters, digits and dashes).")
  if (!input.description.trim()) throw new Error("Describe when the coach should use this skill.")
  const dir = join(userSkillsDir(), name)
  mkdirSync(dir, { recursive: true })
  const description = input.description.replace(/\s+/g, " ").trim().slice(0, 1000)
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${input.body.trim()}\n`, "utf8")
  return { name, description, body: input.body.trim(), builtin: false }
}

export function deleteSkill(name: string) {
  const dir = join(userSkillsDir(), slug(name))
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
