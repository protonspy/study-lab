import { useEffect, useState } from "react"

function computeDark() {
  const attr = document.documentElement.getAttribute("data-theme")
  if (attr === "dark") return true
  if (attr === "light") return false
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
}

/** True when the page renders dark: the viewer's data-theme wins, otherwise the OS setting. */
export function useIsDark() {
  const [dark, setDark] = useState(() => (typeof document === "undefined" ? false : computeDark()))
  useEffect(() => {
    const update = () => setDark(computeDark())
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)")
    mq?.addEventListener?.("change", update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => {
      mq?.removeEventListener?.("change", update)
      mo.disconnect()
    }
  }, [])
  return dark
}

let appliedByApp = false

/** Apply the in-app theme choice without overriding a theme the host set itself. */
export function applyThemeChoice(choice: "system" | "light" | "dark") {
  const root = document.documentElement
  if (choice === "system") {
    if (appliedByApp) root.removeAttribute("data-theme")
    appliedByApp = false
    return
  }
  root.setAttribute("data-theme", choice)
  appliedByApp = true
}
