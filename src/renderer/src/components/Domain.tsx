import { data, domainOf } from "@/lib/data"
import { go } from "@/lib/nav"
import { cn } from "@/lib/utils"

/** Eight fixed domain hues (validated for colour-vision deficiency); they always travel with a text label. */
export function domainColor(d: number): string {
  if (!d) return "var(--ink-3)"
  return `var(--d${((d - 1) % 8) + 1})`
}

export function DomainDot({ d, className }: { d: number; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: domainColor(d) }} />
}

export function DomainLabel({ d, full, className }: { d: number; full?: boolean; className?: string }) {
  const dom = domainOf(d)
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-2", className)}>
      <DomainDot d={d} />
      <span className="font-mono text-[0.7rem] tracking-wide text-ink-3">D{d}</span>
      <span className="truncate">{dom ? (full ? dom.name : dom.short) : d ? `Domain ${d}` : "General"}</span>
    </span>
  )
}

export function TopicChip({ id, onClick, className }: { id: string; onClick?: () => void; className?: string }) {
  const t = data().topicById.get(id)
  if (!t) return null
  return (
    <button
      type="button"
      onClick={onClick ?? (() => go("notes", { topic: id }))}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-ink-2 transition-colors hover:border-ink-3 hover:text-ink",
        className,
      )}
    >
      <DomainDot d={t.d} className="size-2" />
      {t.title}
    </button>
  )
}
