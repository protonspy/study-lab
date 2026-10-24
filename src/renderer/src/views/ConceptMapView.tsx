import { useEffect, useMemo, useRef, useState } from "react"
import cytoscape, { type Core, type ElementDefinition } from "cytoscape"
import fcose from "cytoscape-fcose"
import dagre from "cytoscape-dagre"
import { Expand, Loader2, Maximize, Network, Play, Search, Table2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DomainDot } from "@/components/Domain"
import { MasteryMeter } from "@/components/viz"
import type { GraphViewData } from "@shared/viz"
import type { EdgeType } from "@/lib/types"
import { LAB, useDataVersion } from "@/lib/data"
import { api } from "@/lib/lab"
import { go, run, useNav } from "@/lib/nav"
import { questionSprint } from "@/lib/stats"
import { flush, getState, useAppState } from "@/lib/store"
import { useIsDark } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { PageHead } from "@/views/ReviewView"

cytoscape.use(fcose)
cytoscape.use(dagre)

/*
  The knowledge graph as a map: "search, show context, expand on demand". It opens at topic level
  (domains as groups); double-click a topic to see its concepts. Prerequisite mode lays the DAG out
  left to right; Confusions mode keeps only the pairs you mix up. A table shows the same data.
*/

type Mode = "overview" | "prereq" | "confusions"

interface NodeInfo {
  id: string
  label: string
  kind: "topic" | "kc"
  topic: string | null
  domain: number
  mastery: number | null
  sd: number
  readiness: number
  items: number
  attempts: number
  weight: number
  misconceptions: number
  errors: Record<string, number>
  kcs: string[]
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888"

function mix(a: string, b: string, t: number) {
  const pa = a.match(/\w\w/g)!.map((h) => parseInt(h, 16))
  const pb = b.match(/\w\w/g)!.map((h) => parseInt(h, 16))
  return `#${pa.map((x, i) => Math.round(x + (pb[i] - x) * t).toString(16).padStart(2, "0")).join("")}`
}

/** Deterministic PRNG, so the force layout lands the same way every time. */
function seeded(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function ConceptMapView() {
  const s = useAppState()
  const v = useDataVersion()
  const nav = useNav()
  const [data, setData] = useState<GraphViewData | null>(null)
  const [mode, setMode] = useState<Mode>("overview")
  const [view, setView] = useState<"graph" | "table">("graph")
  const [domain, setDomain] = useState("all")
  const [showRelated, setShowRelated] = useState(false)
  const [topN, setTopN] = useState(20)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [q, setQ] = useState("")

  useEffect(() => {
    let live = true
    void (async () => {
      await flush()
      const d = await api().graphView(LAB!.id)
      if (live) setData(d)
    })()
    return () => {
      live = false
    }
  }, [s.srsq, v])

  /* nodes visible at the current expansion level, with aggregated stats for collapsed topics */
  const model = useMemo(() => {
    if (!data) return null
    const g = data.graph
    const kcById = new Map(g.kcs.map((k) => [k.id, k]))
    const topicOf = (kc: string) => (g.topicLevel ? kc : (kcById.get(kc)?.topic ?? null))
    const domainOfTopic = new Map(data.topics.map((t) => [t.id, t.d]))
    const nodes = new Map<string, NodeInfo>()
    const visibleId = (kc: string) => {
      if (g.topicLevel) return kc
      const t = topicOf(kc)
      return t && !expanded.has(t) ? `t:${t}` : kc
    }
    for (const k of g.kcs) {
      const st = data.stats[k.id]
      const t = topicOf(k.id)
      const d = (t ? domainOfTopic.get(t) : undefined) ?? 0
      if (domain !== "all" && String(d) !== domain) continue
      const id = visibleId(k.id)
      const isTopic = id.startsWith("t:") || g.topicLevel
      const cur = nodes.get(id)
      if (!cur)
        nodes.set(id, {
          id,
          label: id.startsWith("t:") ? (data.topics.find((x) => x.id === t)?.title ?? t ?? id) : k.name,
          kind: isTopic ? "topic" : "kc",
          topic: t,
          domain: d,
          mastery: st?.attempts ? st.mastery : null,
          sd: st?.sd ?? 0.3,
          readiness: st?.readiness ?? 1,
          items: st?.items ?? 0,
          attempts: st?.attempts ?? 0,
          weight: st?.weight ?? 0,
          misconceptions: st?.misconceptions ?? 0,
          errors: { ...(st?.errors ?? {}) },
          kcs: [k.id],
        })
      else {
        // Aggregate concepts into their collapsed topic.
        const n = cur.kcs.length
        if (st?.attempts) cur.mastery = cur.mastery == null ? st.mastery : (cur.mastery * n + st.mastery) / (n + 1)
        cur.sd = Math.sqrt((cur.sd ** 2 * n + (st?.sd ?? 0.3) ** 2) / (n + 1))
        cur.readiness = Math.min(cur.readiness, st?.readiness ?? 1)
        cur.items += st?.items ?? 0
        cur.attempts += st?.attempts ?? 0
        cur.weight += st?.weight ?? 0
        cur.misconceptions += st?.misconceptions ?? 0
        for (const [e, c] of Object.entries(st?.errors ?? {})) cur.errors[e] = (cur.errors[e] ?? 0) + c
        cur.kcs.push(k.id)
      }
    }
    const types: EdgeType[] = mode === "prereq" ? ["prerequisite"] : mode === "confusions" ? ["confusable"] : ["prerequisite", "confusable", ...(showRelated ? (["related"] as EdgeType[]) : [])]
    const agg = new Map<string, { src: string; dst: string; type: EdgeType; weight: number; n: number; evidence: string }>()
    for (const e of g.edges) {
      if (!types.includes(e.type)) continue
      const a = visibleId(e.src)
      const b = visibleId(e.dst)
      if (a === b || !nodes.has(a) || !nodes.has(b)) continue
      const key = `${e.type}|${e.type === "prerequisite" ? `${a}>${b}` : [a, b].sort().join("|")}`
      const cur = agg.get(key) ?? { src: a, dst: b, type: e.type, weight: 0, n: 0, evidence: e.evidence }
      cur.weight += e.weight
      cur.n++
      agg.set(key, cur)
    }
    let edges = [...agg.values()]
    if (mode === "confusions") edges = edges.sort((x, y) => y.weight - x.weight).slice(0, topN)
    return { nodes, edges, topicLevel: g.topicLevel }
  }, [data, expanded, domain, mode, showRelated, topN])

  // Deep link from the Timeline: open the node's topic and select it.
  useEffect(() => {
    const target = nav.params.node
    if (!target || !data) return
    const kc = data.graph.kcs.find((k) => k.id === target)
    if (kc?.topic && !data.graph.topicLevel) setExpanded((s) => new Set(s).add(kc.topic!))
    setSelected(target)
  }, [nav.params.node, data])

  if (!data || !model) return <Loader2 className="size-5 animate-spin text-ink-3" />
  const sel = selected ? model.nodes.get(selected) ?? model.nodes.get(`t:${data.graph.kcs.find((k) => k.id === selected)?.topic}`) : null

  function locate(text: string) {
    const needle = text.trim().toLowerCase()
    if (!needle || !data || !model) return
    const hit =
      [...model.nodes.values()].find((n) => n.label.toLowerCase() === needle) ??
      [...model.nodes.values()].find((n) => n.label.toLowerCase().includes(needle)) ??
      null
    if (hit) return setSelected(hit.id)
    const kc = data.graph.kcs.find((k) => k.name.toLowerCase().includes(needle))
    if (kc) {
      if (kc.topic) setExpanded((s) => new Set(s).add(kc.topic!))
      setSelected(kc.id)
    }
  }

  return (
    <div>
      <PageHead eyebrow={LAB!.name} title="Concept map">
        How your material fits together and where you stand in it. Colour shows mastery, size shows exam weight; solid arrows are prerequisites, orange dashes are concepts you mix up.
        {model.topicLevel && " This lab has no concept graph yet, so topics are shown and their links come from shared questions and your misses. Build the knowledge base to see concepts and prerequisites."}
      </PageHead>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault()
            locate(q)
          }}
        >
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a concept" className="w-56 pl-8" list="concept-names" aria-label="Find a concept" />
          <datalist id="concept-names">
            {data.graph.kcs.slice(0, 400).map((k) => (
              <option key={k.id} value={k.name} />
            ))}
          </datalist>
        </form>
        <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(x) => x && setMode(x as Mode)}>
          <ToggleGroupItem value="overview">Overview</ToggleGroupItem>
          <ToggleGroupItem value="prereq" disabled={model.topicLevel}>
            Prerequisites
          </ToggleGroupItem>
          <ToggleGroupItem value="confusions">Confusions</ToggleGroupItem>
        </ToggleGroup>
        <Select value={domain} onValueChange={setDomain}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All domains</SelectItem>
            {data.domains.map((d) => (
              <SelectItem key={d.n} value={String(d.n)}>
                {d.short || d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode === "overview" && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={showRelated} onCheckedChange={setShowRelated} /> related links
          </label>
        )}
        {mode === "confusions" && (
          <label className="flex items-center gap-2 text-sm">
            top
            <Input type="number" value={topN} min={1} max={200} onChange={(e) => setTopN(Math.max(1, Number(e.target.value) || 1))} className="w-20 font-mono" />
            pairs
          </label>
        )}
        <div className="ml-auto flex gap-1">
          {!model.topicLevel && (
            <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded.size ? new Set() : new Set(data.topics.map((t) => t.id)))}>
              <Expand /> {expanded.size ? "Collapse all" : "Expand all"}
            </Button>
          )}
          <ToggleGroup type="single" variant="outline" value={view} onValueChange={(x) => x && setView(x as "graph" | "table")}>
            <ToggleGroupItem value="graph" aria-label="Graph">
              <Network />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="Table">
              <Table2 />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {view === "graph" ? (
          <Card className="relative overflow-hidden p-0">
            <Graph model={model} data={data} mode={mode} selected={selected} onSelect={setSelected} onToggle={(t) => setExpanded((s) => (s.has(t) ? (s.delete(t), new Set(s)) : new Set(s.add(t))))} />
            <GraphLegend />
          </Card>
        ) : (
          <NodeTable model={model} onSelect={setSelected} />
        )}
        <Panel node={sel ?? null} data={data} model={model} onClose={() => setSelected(null)} onSelect={setSelected} />
      </div>
    </div>
  )
}

function Graph({
  model,
  data,
  mode,
  selected,
  onSelect,
  onToggle,
}: {
  model: { nodes: Map<string, NodeInfo>; edges: { src: string; dst: string; type: EdgeType; weight: number; n: number; evidence: string }[]; topicLevel: boolean }
  data: GraphViewData
  mode: Mode
  selected: string | null
  onSelect: (id: string | null) => void
  onToggle: (topic: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const dark = useIsDark()
  const handlers = useRef({ onSelect, onToggle })
  handlers.current = { onSelect, onToggle }

  useEffect(() => {
    if (!box.current) return
    const seq0 = css("--seq-0")
    const seq1 = css("--seq-1")
    const maxW = Math.max(0.0001, ...[...model.nodes.values()].map((n) => n.weight))
    const els: ElementDefinition[] = []
    const domains = new Set([...model.nodes.values()].map((n) => n.domain))
    if (mode !== "prereq")
      for (const d of domains) {
        const dom = data.domains.find((x) => x.n === d)
        els.push({ data: { id: `dom:${d}`, label: dom ? dom.short || dom.name : "Other" }, classes: "domain" })
      }
    const expandedTopics = new Set([...model.nodes.values()].filter((n) => n.kind === "kc" && n.topic).map((n) => n.topic!))
    if (mode !== "prereq")
      for (const t of expandedTopics) {
        const topic = data.topics.find((x) => x.id === t)
        els.push({ data: { id: `grp:${t}`, label: topic?.title ?? t, parent: `dom:${topic?.d ?? 0}` }, classes: "group" })
      }
    for (const n of model.nodes.values()) {
      const size = 30 + 40 * Math.sqrt(n.weight / maxW)
      els.push({
        data: {
          id: n.id,
          label: n.label,
          parent: mode === "prereq" ? undefined : n.kind === "kc" && n.topic && !model.topicLevel ? `grp:${n.topic}` : `dom:${n.domain}`,
          color: n.mastery == null ? css("--surface-2") : mix(seq0, seq1, Math.max(0, Math.min(1, n.mastery))),
          border: n.mastery == null ? css("--ink-3") : mix(seq0, seq1, 1),
          size,
          dashed: n.sd > 0.15 ? 1 : 0,
        },
        classes: `${n.kind}${n.misconceptions ? " misconception" : ""}`,
      })
    }
    for (const e of model.edges) els.push({ data: { id: `${e.type}:${e.src}:${e.dst}`, source: e.src, target: e.dst, w: e.weight, n: e.n }, classes: e.type })

    const ink = css("--ink")
    const ink2 = css("--ink-2")
    const ink3 = css("--ink-3")
    const orange = css("--d2")
    const line = css("--line")
    const surface = css("--surface")
    const cy = cytoscape({
      container: box.current,
      elements: els,
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.3,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 13,
            "min-zoomed-font-size": 6,
            color: ink,
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "text-outline-color": surface,
            "text-outline-width": 2,
            "border-width": 2,
          },
        },
        {
          selector: "node[size]",
          style: { width: "data(size)", height: "data(size)", "background-color": "data(color)", "border-color": "data(border)" },
        },
        { selector: "node[dashed = 1]", style: { "border-style": "dashed" } },
        { selector: "node.misconception", style: { "border-color": orange, "border-width": 3 } },
        { selector: "node.topic", style: { shape: "round-rectangle" } },
        {
          selector: ":parent",
          style: {
            "background-opacity": 0.05,
            "background-color": ink3,
            "border-color": line,
            "border-style": "dashed",
            "border-width": 1,
            label: "data(label)",
            "text-valign": "top",
            "text-halign": "center",
            "font-size": 14,
            "font-weight": "bold",
            color: ink2,
            padding: "14px",
            shape: "round-rectangle",
          },
        },
        {
          selector: "edge",
          style: { width: 1.5, "curve-style": "bezier", "line-color": line, opacity: 0.9 },
        },
        { selector: "edge.prerequisite", style: { "line-color": ink2, "target-arrow-color": ink2, "target-arrow-shape": "triangle", "arrow-scale": 0.9 } },
        { selector: "edge.prerequisite[n]", style: { width: "mapData(n, 1, 6, 1.5, 4)" } },
        { selector: "edge.confusable", style: { "line-color": orange, "line-style": "dashed" } },
        { selector: "edge.confusable[w]", style: { width: "mapData(w, 1, 10, 1.5, 6)" } },
        { selector: "edge.related", style: { "line-color": line, "line-style": "dotted", width: 1.2 } },
        { selector: ".faded", style: { opacity: 0.15 } },
        { selector: "node:selected", style: { "border-color": ink, "border-width": 4 } },
      ],
      layout: { name: "preset" },
    })
    cyRef.current = cy

    const restore = Math.random
    Math.random = seeded(42)
    try {
      cy.layout(
        mode === "prereq"
          ? ({ name: "dagre", rankDir: "LR", nodeSep: 18, rankSep: 70, animate: false } as cytoscape.LayoutOptions)
          : ({
              name: "fcose",
              quality: "proof",
              randomize: true,
              animate: false,
              nodeRepulsion: 3500,
              idealEdgeLength: 55,
              nodeSeparation: 30,
              nestingFactor: 0.35,
              gravity: 0.6,
              gravityCompound: 1.4,
              tile: true,
              tilingPaddingVertical: 12,
              tilingPaddingHorizontal: 12,
              packComponents: true,
            } as cytoscape.LayoutOptions),
      ).run()
    } finally {
      Math.random = restore
    }
    // Fit, but never below a readable zoom: "show context", then let the learner pan and expand.
    cy.fit(undefined, 24)
    if (cy.zoom() < 0.75) {
      const c = cy.elements().boundingBox()
      cy.zoom(0.75)
      cy.center(cy.elements())
      void c
    }

    const focus = (id: string | null) => {
      cy.elements().removeClass("faded")
      if (!id) return
      const n = cy.getElementById(id)
      if (!n.length || n.isParent()) return
      const hood = mode === "prereq" ? n.predecessors().union(n) : n.closedNeighborhood()
      cy.elements().not(hood).not(hood.ancestors()).addClass("faded")
    }
    cy.on("mouseover", "node", (e) => focus(e.target.id()))
    cy.on("mouseout", "node", () => focus(cy.$("node:selected").id() || null))
    cy.on("tap", "node", (e) => {
      if (e.target.isParent()) return
      handlers.current.onSelect(e.target.id())
    })
    cy.on("tap", (e) => {
      if (e.target === cy) handlers.current.onSelect(null)
    })
    cy.on("dbltap", "node", (e) => {
      const id: string = e.target.id()
      if (id.startsWith("t:")) handlers.current.onToggle(id.slice(2))
      else if (id.startsWith("grp:")) handlers.current.onToggle(id.slice(4))
    })
    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [model, data, mode, dark])

  // Selection follows the panel; centre on it.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.$("node:selected").unselect()
    if (!selected) return
    const n = cy.getElementById(selected)
    if (n.length) {
      n.select()
      cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1) }, { duration: 250 })
      const hood = mode === "prereq" ? n.predecessors().union(n) : n.closedNeighborhood()
      cy.elements().removeClass("faded")
      cy.elements().not(hood).not(hood.ancestors()).addClass("faded")
    }
  }, [selected, model, mode])

  return (
    <div className="relative">
      <div
        ref={box}
        className="h-[62dvh] min-h-[420px] w-full"
        role="img"
        aria-label={`Concept map with ${model.nodes.size} nodes and ${model.edges.length} links. Use the table view for a keyboard-accessible list.`}
      />
      <Button variant="outline" size="icon" className="absolute right-3 top-3 size-8" onClick={() => cyRef.current?.fit(undefined, 30)} aria-label="Fit to screen">
        <Maximize className="size-4" />
      </Button>
    </div>
  )
}

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-ink-2">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-10 rounded-sm" style={{ background: "linear-gradient(90deg, var(--seq-0), var(--seq-1))" }} /> mastery low → high
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-ink-3 bg-surface-2" /> not studied yet
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-dashed border-ink-2" /> unsure estimate
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <line x1="0" y1="4" x2="20" y2="4" stroke="var(--ink-2)" strokeWidth="1.5" />
          <path d="M20 1 L26 4 L20 7 Z" fill="var(--ink-2)" />
        </svg>
        prerequisite
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <line x1="0" y1="4" x2="26" y2="4" stroke="var(--d2)" strokeWidth="2" strokeDasharray="4 3" />
        </svg>
        often confused
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <line x1="0" y1="4" x2="26" y2="4" stroke="var(--line)" strokeWidth="1.5" strokeDasharray="1 3" />
        </svg>
        related (similar content, not causal)
      </span>
      <span className="text-ink-3">Size = exam weight · double-click a topic to open its concepts</span>
    </div>
  )
}

function NodeTable({ model, onSelect }: { model: { nodes: Map<string, NodeInfo>; edges: { src: string; dst: string; type: EdgeType }[] }; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<"mastery" | "weight" | "label">("mastery")
  const rows = [...model.nodes.values()].sort((a, b) => (sort === "label" ? a.label.localeCompare(b.label) : sort === "weight" ? b.weight - a.weight : (a.mastery ?? -1) - (b.mastery ?? -1)))
  const name = (id: string) => model.nodes.get(id)?.label ?? id
  return (
    <Card className="overflow-x-auto">
      <CardContent>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs text-ink-3">
            <tr>
              {(
                [
                  ["label", "Concept"],
                  ["mastery", "Mastery"],
                  ["weight", "Exam weight"],
                ] as const
              ).map(([k, l]) => (
                <th key={k} className="pb-2 font-normal">
                  <button type="button" onClick={() => setSort(k)} className={cn("hover:text-ink", sort === k && "font-medium text-ink")}>
                    {l}
                  </button>
                </th>
              ))}
              <th className="pb-2 font-normal">Needs first</th>
              <th className="pb-2 font-normal">Confused with</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((n) => (
              <tr key={n.id}>
                <td className="py-1.5 pr-2">
                  <button type="button" className="flex items-center gap-2 text-left hover:underline" onClick={() => onSelect(n.id)}>
                    <DomainDot d={n.domain} /> {n.label}
                  </button>
                </td>
                <td className="w-40 py-1.5 pr-2">
                  <MasteryMeter mastery={n.mastery} sd={n.sd} attempts={n.attempts} />
                </td>
                <td className="py-1.5 font-mono text-xs tabular">{(n.weight * 100).toFixed(1)}%</td>
                <td className="py-1.5 text-xs text-ink-2">
                  {model.edges
                    .filter((e) => e.type === "prerequisite" && e.dst === n.id)
                    .map((e) => name(e.src))
                    .join(", ") || "—"}
                </td>
                <td className="py-1.5 text-xs text-ink-2">
                  {model.edges
                    .filter((e) => e.type === "confusable" && (e.src === n.id || e.dst === n.id))
                    .map((e) => name(e.src === n.id ? e.dst : e.src))
                    .join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

const ERROR_LABEL: Record<string, string> = { gap: "gaps", misconception: "misconceptions", confusion: "confusions", forgetting: "forgotten", slip: "slips" }

function Panel({
  node,
  data,
  model,
  onClose,
  onSelect,
}: {
  node: NodeInfo | null
  data: GraphViewData
  model: { nodes: Map<string, NodeInfo>; edges: { src: string; dst: string; type: EdgeType; weight: number }[] }
  onClose: () => void
  onSelect: (id: string) => void
}) {
  if (!node)
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 text-sm text-ink-2">
          <p className="font-medium text-ink">Select a node</p>
          <p>Click a topic or concept to see its mastery, what it depends on and what you confuse it with. Double-click a topic to open its concepts.</p>
        </CardContent>
      </Card>
    )
  const pre = model.edges.filter((e) => e.type === "prerequisite" && e.dst === node.id).map((e) => model.nodes.get(e.src)).filter((x): x is NodeInfo => !!x)
  const next = model.edges.filter((e) => e.type === "prerequisite" && e.src === node.id).map((e) => model.nodes.get(e.dst)).filter((x): x is NodeInfo => !!x)
  const conf = model.edges
    .filter((e) => e.type === "confusable" && (e.src === node.id || e.dst === node.id))
    .map((e) => ({ n: model.nodes.get(e.src === node.id ? e.dst : e.src), w: e.weight }))
    .filter((x): x is { n: NodeInfo; w: number } => !!x.n)
  const errs = Object.entries(node.errors).filter(([, c]) => c > 0)
  const practise = () => {
    const s = getState()
    const items = node.kind === "kc" ? questionSprint(s, 12, { kcs: node.kcs }) : node.topic ? questionSprint(s, 12, { topic: node.topic }) : questionSprint(s, 12, { kcs: node.kcs })
    run(`Practice · ${node.label}`, items, "graph")
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{node.kind === "kc" ? "Concept" : "Topic"}</p>
            <p className="font-heading text-lg font-semibold leading-tight">{node.label}</p>
            {node.kind === "kc" && <p className="mt-1 text-xs text-ink-2">{data.graph.kcs.find((k) => k.id === node.id)?.definition}</p>}
          </div>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-ink-3">
            <span>Mastery</span>
            <span className="font-mono">{node.mastery == null ? "not studied" : `${Math.round(node.mastery * 100)}% ± ${Math.round(node.sd * 128)}`}</span>
          </div>
          <MasteryMeter mastery={node.mastery} sd={node.sd} attempts={node.attempts} />
          <p className="text-xs text-ink-3">
            {node.items} questions · {node.attempts} answers · readiness {Math.round(node.readiness * 100)}%
          </p>
        </div>
        {!!errs.length && (
          <p className="text-xs text-ink-2">
            Errors: {errs.map(([k, c]) => `${c} ${ERROR_LABEL[k] ?? k}`).join(" · ")}
          </p>
        )}
        {!!pre.length && (
          <NodeList title="Needs first" items={pre} onSelect={onSelect} warn={(n) => (n.mastery ?? 0) < 0.6} />
        )}
        {!!next.length && <NodeList title="Unlocks" items={next} onSelect={onSelect} />}
        {!!conf.length && (
          <div>
            <p className="mb-1 text-xs font-medium">Confused with</p>
            {conf.map(({ n, w }) => (
              <button key={n.id} type="button" onClick={() => onSelect(n.id)} className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-sm hover:bg-surface-2">
                <span className="truncate">{n.label}</span>
                <span className="shrink-0 font-mono text-[0.7rem] text-warn">×{Math.round(w)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={practise} disabled={!node.items}>
            <Play /> Practise
          </Button>
          {node.topic && (
            <Button size="sm" variant="outline" onClick={() => go("notes", { topic: node.topic! })}>
              Notes
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function NodeList({ title, items, onSelect, warn }: { title: string; items: NodeInfo[]; onSelect: (id: string) => void; warn?: (n: NodeInfo) => boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium">{title}</p>
      {items.map((n) => (
        <button key={n.id} type="button" onClick={() => onSelect(n.id)} className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-sm hover:bg-surface-2">
          <span className="truncate">{n.label}</span>
          <span className={cn("shrink-0 font-mono text-[0.7rem]", warn?.(n) ? "text-warn" : "text-ink-3")}>{n.mastery == null ? "—" : `${Math.round(n.mastery * 100)}%`}</span>
        </button>
      ))}
    </div>
  )
}
