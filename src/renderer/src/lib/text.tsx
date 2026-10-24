import type { ReactNode } from "react"

/*
  Exam questions hinge on the constraint ("LEAST operational overhead", "must stay in the EU").
  Marking those words trains the habit of reading for what the question optimizes.
*/
const CAPS = /\b(LEAST|MOST|NOT|FEWEST|ONLY|EXCEPT|BEST|TWO|THREE|FOUR|NO)\b/g
const PHRASES =
  /\b(operational(?: and maintenance)? overhead|most cost[- ]effective(?:ly)?|cost[- ]effective(?:ly)?|lowest (?:cost|latency|operational overhead)|least (?:latency|cost|effort|amount of [a-z]+(?: [a-z]+)?)|minimal (?:latency|changes|code changes|effort|development effort|operational effort|custom code)|minimi[sz]e[sd]? (?:latency|costs?|changes|effort|operational overhead|the [a-z]+ [a-z]+)|fewest (?:changes|steps)|without (?:retraining|managing|changing|custom code|additional|modifying|provisioning|writing)\b[a-z ]{0,18}|near[- ]real[- ]time|in real time|real[- ]time|least[- ]privilege|data residency|must (?:not )?(?:remain|stay|be|keep|use|not)|must|within the (?:EU|European Union|same Region|Region)|no custom code|fully managed|with minimal [a-z]+(?: [a-z]+)?)\b/gi

type Range = [number, number]

function ranges(text: string): Range[] {
  const out: Range[] = []
  for (const re of [CAPS, PHRASES]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      out.push([m.index, m.index + m[0].length])
      if (m[0].length === 0) re.lastIndex++
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: Range[] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

export function Highlighted({ text, on = true }: { text: string; on?: boolean }) {
  if (!on) return <>{text}</>
  const rs = ranges(text)
  if (!rs.length) return <>{text}</>
  const parts: ReactNode[] = []
  let pos = 0
  rs.forEach(([a, b], i) => {
    if (a > pos) parts.push(text.slice(pos, a))
    parts.push(
      <mark key={i} className="hl-strong">
        {text.slice(a, b)}
      </mark>,
    )
    pos = b
  })
  if (pos < text.length) parts.push(text.slice(pos))
  return <>{parts}</>
}

/** Mark every case-insensitive occurrence of `q` (search results). */
export function MarkQuery({ text, q }: { text: string; q: string }) {
  const needle = q.trim()
  if (needle.length < 2) return <>{text}</>
  const lower = text.toLowerCase()
  const n = needle.toLowerCase()
  const parts: ReactNode[] = []
  let pos = 0
  let i = lower.indexOf(n)
  let k = 0
  while (i !== -1) {
    if (i > pos) parts.push(text.slice(pos, i))
    parts.push(
      <mark key={k++} className="hl">
        {text.slice(i, i + n.length)}
      </mark>,
    )
    pos = i + n.length
    i = lower.indexOf(n, pos)
  }
  if (pos < text.length) parts.push(text.slice(pos))
  return <>{parts}</>
}

/** Paragraphs and "- " bullet lists from the question bank's explanation text. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`l${blocks.length}`} className="ml-5 list-disc space-y-1 text-ink-2">
          {list.map((li, i) => (
            <li key={i}>{li}</li>
          ))}
        </ul>,
      )
      list = []
    }
  }
  for (const l of lines) {
    if (l.startsWith("- ")) {
      list.push(l.slice(2))
      continue
    }
    flush()
    if (/^Further reading/i.test(l)) {
      blocks.push(
        <p key={`h${blocks.length}`} className="eyebrow pt-1">
          {l.replace(/:$/, "")}
        </p>,
      )
    } else {
      blocks.push(<p key={`p${blocks.length}`}>{l}</p>)
    }
  }
  flush()
  return <div className={className ?? "space-y-2"}>{blocks}</div>
}

export function excerpt(text: string, n = 160) {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t
}

export const LETTERS = "ABCDEF"

export function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m) return `${m}m`
  return `${Math.round(sec)}s`
}

export function fmtClock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

export function plural(n: number, one: string, many = one + "s") {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}
