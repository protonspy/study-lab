import { useEffect, useState } from "react"
import { CheckCircle2, FileJson, FileText, FolderInput, Loader2, NotebookText, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { AdapterInfo, ImportPreview } from "@shared/api"
import { api } from "@/lib/lab"
import { flush } from "@/lib/store"
import type { ImportResult } from "@/lib/types"
import { cn } from "@/lib/utils"

const ICON: Record<string, typeof FileText> = {
  "udemy-study-export": FileText,
  "study-lab-bundle": FolderInput,
  "content-package": FileJson,
  documents: NotebookText,
}

export function importSummary(r: ImportResult) {
  const parts = [r.questions && `${r.questions} questions`, r.lectures && `${r.lectures} documents`, r.topics && `${r.topics} topics`, r.cards && `${r.cards} cards`].filter(Boolean)
  return parts.length ? `Imported ${parts.join(", ")}.` : "Nothing new was found."
}

/** Pick a source format, preview what was found, then import into the lab. */
export function ImportPanel({ labId, onImported, compact }: { labId: string; onImported?: (r: ImportResult) => void; compact?: boolean }) {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [done, setDone] = useState<ImportResult | null>(null)

  useEffect(() => {
    void api().contentAdapters().then(setAdapters)
  }, [])

  async function pick(a: AdapterInfo) {
    const paths = await api().pickFiles(a.pick === "directory" ? "dir" : "files", a.extensions)
    if (!paths.length) return
    setBusy("Reading the files…")
    setDone(null)
    try {
      const p = await api().previewImport(paths, a.id)
      setPreview(p)
      if (!p.packages.length) toast.error(p.warnings[0] ?? "Nothing to import in those files.")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function confirm() {
    if (!preview) return
    setBusy("Importing…")
    try {
      await flush()
      const r = await api().importPreview(labId, preview.token)
      setDone({ ...r, warnings: [...preview.warnings, ...r.warnings] })
      setPreview(null)
      toast.success(importSummary(r))
      onImported?.(r)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {!preview && (
        <div className={cn("grid gap-2", !compact && "sm:grid-cols-2")}>
          {adapters.map((a) => {
            const Icon = ICON[a.id] ?? FileText
            return (
              <Button key={a.id} variant="outline" className="h-auto justify-start whitespace-normal py-3 text-left" onClick={() => void pick(a)} disabled={!!busy}>
                <Icon className="size-5 shrink-0" />
                <span>
                  <span className="block font-medium">{a.name}</span>
                  <span className="block text-xs font-normal text-ink-3">{a.description}</span>
                </span>
              </Button>
            )
          })}
        </div>
      )}

      {busy && (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Loader2 className="size-4 animate-spin" /> {busy}
        </p>
      )}

      {preview && !busy && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="eyebrow">Found by {preview.adapter?.name}</p>
          <ul className="mt-2 flex flex-col gap-3">
            {preview.packages.map((p) => (
              <li key={p.source.id}>
                <p className="font-medium">{p.source.title}</p>
                <p className="text-sm text-ink-2">
                  {p.documents} documents{p.emptyDocuments ? ` (${p.emptyDocuments} empty)` : ""} · {p.items} questions in {p.assessments.length} sets
                  {p.topics ? ` · ${p.topics} topics · ${p.cards} cards` : ""}
                </p>
                {!!p.sections.length && (
                  <p className="mt-1 line-clamp-2 text-xs text-ink-3">
                    Sections: {p.sections.slice(0, 12).join(" · ")}
                    {p.sections.length > 12 ? " …" : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {preview.warnings.slice(0, 4).map((w, i) => (
            <p key={i} className="mt-2 flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
            </p>
          ))}
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void confirm()} disabled={!preview.packages.length}>
              Import
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Choose other files
            </Button>
          </div>
        </div>
      )}

      {done && (
        <div className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <p className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-good" /> {importSummary(done)}
          </p>
          {done.warnings.slice(0, 4).map((w, i) => (
            <p key={i} className="mt-1 text-xs text-warn">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
