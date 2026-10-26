import { useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

/*
  Pagination for every table and long list. `usePaged` slices the rows; when `reset` changes (pass
  the filters and search as a string) it goes back to the first page. The pager stays hidden while
  everything fits on the smallest page.
*/

const SIZES = [25, 50, 100]

export interface Paged<T> {
  rows: T[]
  page: number
  pages: number
  size: number
  total: number
  setPage: (page: number) => void
  setSize: (size: number) => void
}

export function usePaged<T>(all: T[], { size: initial = SIZES[0], reset }: { size?: number; reset?: string | number } = {}): Paged<T> {
  const [st, setSt] = useState({ page: 0, size: initial, reset })
  if (st.reset !== reset) setSt({ ...st, page: 0, reset })
  const pages = Math.max(1, Math.ceil(all.length / st.size))
  // Fewer rows than before (a delete, an archive) keeps the page in range.
  const page = Math.min(st.reset === reset ? st.page : 0, pages - 1)
  return {
    rows: all.slice(page * st.size, (page + 1) * st.size),
    page,
    pages,
    size: st.size,
    total: all.length,
    setPage: (p) => setSt((s) => ({ ...s, page: p })),
    setSize: (n) => setSt((s) => ({ ...s, size: n, page: 0 })),
  }
}

/** Page numbers around the current one, the first and the last, with gaps as null. */
function pageList(page: number, pages: number): (number | null)[] {
  const keep = [...new Set([0, page - 1, page, page + 1, pages - 1])].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b)
  return keep.flatMap((p, i) => (i && p - keep[i - 1] > 1 ? [null, p] : [p]))
}

export function Pager<T>({ p, className }: { p: Paged<T>; className?: string }) {
  const root = useRef<HTMLElement>(null)
  if (p.total <= SIZES[0]) return null
  const go = (page: number) => {
    p.setPage(page)
    // A list that starts above the screen comes back to its top.
    const list = root.current?.parentElement
    if (list && list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: "start" })
  }
  const first = p.page * p.size + 1
  const last = Math.min(p.total, first + p.size - 1)
  return (
    <nav ref={root} aria-label="Pages" className={cn("flex flex-wrap items-center gap-2 text-xs text-ink-3", className)}>
      <span className="font-mono tabular">
        {first.toLocaleString()}–{last.toLocaleString()} of {p.total.toLocaleString()}
      </span>
      <Select value={String(p.size)} onValueChange={(v) => p.setSize(Number(v))}>
        <SelectTrigger size="sm" className="w-28" aria-label="Rows per page">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIZES.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n} per page
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {p.pages > 1 && (
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" disabled={!p.page} onClick={() => go(p.page - 1)} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          {pageList(p.page, p.pages).map((n, i) =>
            n == null ? (
              <span key={`gap${i}`} className="px-1">
                …
              </span>
            ) : (
              <Button key={n} variant={n === p.page ? "secondary" : "ghost"} size="sm" className="min-w-7 px-1.5 font-mono tabular" aria-current={n === p.page ? "page" : undefined} onClick={() => go(n)}>
                {n + 1}
              </Button>
            ),
          )}
          <Button variant="ghost" size="icon-sm" disabled={p.page >= p.pages - 1} onClick={() => go(p.page + 1)} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
      )}
    </nav>
  )
}
