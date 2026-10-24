import { useSyncExternalStore } from "react"
import type { QueueItem } from "./stats"

export type View = "today" | "review" | "cards" | "drill" | "practice" | "exam" | "notes" | "mistakes" | "library" | "coach" | "analytics" | "content" | "settings"

export const VIEWS: View[] = ["today", "review", "cards", "drill", "practice", "exam", "notes", "mistakes", "library", "coach", "analytics", "content", "settings"]

export interface RunSpec {
  title: string
  items: QueueItem[]
  back: View
  /** a fresh object per start, so the runner restarts even with the same items */
  key: number
}

interface NavState {
  view: View
  params: Record<string, string | undefined>
  run: RunSpec | null
}

function initialView(): View {
  const h = typeof location !== "undefined" ? location.hash.replace(/^#/, "") : ""
  return (VIEWS as string[]).includes(h) ? (h as View) : "today"
}

let nav: NavState = { view: initialView(), params: {}, run: null }
const ls = new Set<() => void>()

function set(next: NavState) {
  nav = next
  for (const fn of ls) fn()
  try {
    history.replaceState(null, "", `#${next.view}`)
  } catch {
    /* the viewer frame may refuse URL changes */
  }
  document.getElementById("main")?.scrollTo({ top: 0 })
  window.scrollTo({ top: 0 })
}

export function go(view: View, params: Record<string, string | undefined> = {}) {
  set({ view, params, run: view === "review" ? nav.run : null })
}

export function run(title: string, items: QueueItem[], back: View) {
  set({ view: "review", params: {}, run: { title, items, back, key: Date.now() } })
}

export function endRun() {
  set({ view: nav.run?.back ?? "today", params: {}, run: null })
}

export function currentView(): View {
  return nav.view
}

export function useNav() {
  return useSyncExternalStore(
    (fn) => {
      ls.add(fn)
      return () => ls.delete(fn)
    },
    () => nav,
    () => nav,
  )
}
