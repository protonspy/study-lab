import { useEffect, useMemo, useRef, useState } from "react"
import { GraphCanvas, Ring, Sphere, type GraphCanvasRef, type GraphEdge, type GraphNode, type InternalGraphPosition, type NodeRendererProps, type Theme } from "reagraph"
import dagre from "@dagrejs/dagre"
import { configureTextBuilder } from "troika-three-text"
// Labels are drawn in WebGL from a font file; a bundled one, since the app works offline.
import labelFont from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff?url"
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
import { Pager, usePaged } from "@/components/Pager"

// The labels' text engine (troika) typesets in a blob: worker, which the app's CSP refuses, and
// would fetch fallback fonts from a CDN; keep it on the main thread with the bundled font.
configureTextBuilder({ useWorker: false, defaultFontURL: labelFont })

// The label font's characters (fontsource's latin subset). For any other one troika would fetch a
// fallback font from a CDN, which the CSP blocks, and then the whole scene draws nothing.
const OUTSIDE_FONT = "[^\\u0020-\\u007E\\u00A0-\\u00FF\\u0131\\u0152\\u0153\\u02BB\\u02BC\\u02C6\\u02DA\\u02DC\\u2000-\\u206F\\u20AC\\u2122\\u2191\\u2193\\u2212\\u2215]"
const outside = new RegExp(OUTSIDE_FONT, "g")
const outsideAgain = new RegExp(OUTSIDE_FONT, "g")
/** A label the bundled font can draw: accents it lacks lose their mark, arrows become "->", the rest goes. */
const labelText = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(outside, (c) => (c === "→" ? "->" : c.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(outsideAgain, "")))

/*
  The knowledge graph as a map: "search, show context, expand on demand". It opens at topic level
  (domains as clusters); double-click a topic to see its concepts, which cluster under it, and a
  concept to close its topic again. Prerequisite mode lays the DAG out left to right; Confusions
  mode keeps only the pairs you mix up. Drawn in WebGL (reagraph), so courses with thousands of
  concepts stay fluid. A table shows the same data.
*/

type Mode = "overview" | "prereq" | "confusions"

const EXPAND_LIMIT = 800

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

function graphTheme(): Theme {
  const ink = css("--ink")
  const ink2 = css("--ink-2")
  const ink3 = css("--ink-3")
  const line = css("--line")
  const surface = css("--surface")
  return {
    canvas: { background: surface },
    node: { fill: css("--surface-2"), activeFill: ink, opacity: 1, selectedOpacity: 1, inactiveOpacity: 0.15, label: { color: ink, stroke: surface, activeColor: ink } },
    ring: { fill: ink3, activeFill: ink },
    edge: { fill: line, activeFill: ink2, opacity: 0.9, selectedOpacity: 1, inactiveOpacity: 0.08, label: { color: ink2, stroke: surface, activeColor: ink, fontSize: 6 } },
    arrow: { fill: ink2, activeFill: ink },
    lasso: { background: "transparent", border: `1px solid ${ink3}` },
    cluster: { stroke: line, fill: surface, opacity: 1, selectedOpacity: 1, inactiveOpacity: 0.3, label: { color: ink2, stroke: surface, fontSize: 11 } },
  }
}

/**
  The prerequisite DAG, left to right (reagraph's own tree layouts need a single parent per node).
  Nodes with no prerequisite either way would each take a row of their own, so they sit in a grid
  under it.
*/
function dagLayout(ids: string[], edges: { src: string; dst: string }[]) {
  const linked = new Set(edges.flatMap((e) => [e.src, e.dst]))
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const id of ids) if (linked.has(id)) g.setNode(id, { width: 30, height: 30 })
  for (const e of edges) g.setEdge(e.src, e.dst)
  dagre.layout(g)
  const pos = new Map<string, { x: number; y: number; z: number }>()
  let bottom = 0
  // dagre's y grows downwards, the canvas' upwards.
  for (const id of ids)
    if (linked.has(id)) {
      const n = g.node(id)
      pos.set(id, { x: n.x, y: -n.y, z: 0 })
      bottom = Math.max(bottom, n.y)
    }
  const rest = ids.filter((id) => !linked.has(id))
  const cols = Math.ceil(Math.sqrt(rest.length * 2))
  rest.forEach((id, i) => pos.set(id, { x: (i % cols) * 90, y: -(bottom + 90 + Math.floor(i / cols) * 45), z: 0 }))
  return pos
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
  // Every concept at once makes a WebGL scene of thousands of nodes (a few frames a second at ~2,300):
  // "Expand all" opens the current domain, and only up to EXPAND_LIMIT concepts.
  const inScope = data.topics.filter((t) => domain === "all" || String(t.d) === domain).map((t) => t.id)
  const scopeSet = new Set(inScope)
  const scopeConcepts = data.graph.kcs.filter((k) => k.topic && scopeSet.has(k.topic)).length
  const tooMany = !expanded.size && scopeConcepts > EXPAND_LIMIT

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
        How your material fits together and where you stand in it. Colour shows mastery, size shows exam weight; solid arrows are prerequisites, orange lines are concepts you mix up.
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
            <Button
              variant="ghost"
              size="sm"
              disabled={tooMany}
              title={tooMany ? `${scopeConcepts.toLocaleString()} concepts: pick a domain first, or double-click topics one by one` : undefined}
              onClick={() => setExpanded(expanded.size ? new Set() : scopeSet)}
            >
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

type GraphModel = { nodes: Map<string, NodeInfo>; edges: { src: string; dst: string; type: EdgeType; weight: number; n: number; evidence: string }[]; topicLevel: boolean }

const edgeId = (e: { type: EdgeType; src: string; dst: string }) => `${e.type}:${e.src}:${e.dst}`
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

function Graph({
  model,
  data,
  mode,
  selected,
  onSelect,
  onToggle,
}: {
  model: GraphModel
  data: GraphViewData
  mode: Mode
  selected: string | null
  onSelect: (id: string | null) => void
  onToggle: (topic: string) => void
}) {
  const ref = useRef<GraphCanvasRef>(null)
  const dark = useIsDark()
  const [hover, setHover] = useState<string | null>(null)

  const { nodes, edges, theme, colors, layoutOverrides } = useMemo(() => {
    const seq0 = css("--seq-0")
    const seq1 = css("--seq-1")
    const colors = { orange: css("--d2"), ink: css("--ink"), ink2: css("--ink-2"), line: css("--line") }
    const maxW = Math.max(0.0001, ...[...model.nodes.values()].map((n) => n.weight))
    // reagraph labels nodes above size 7 at any zoom ("auto"); on a large graph only the heavy ones
    // get there, the rest are labelled when zoomed in.
    const minSize = model.nodes.size > 500 ? 3 : 7
    const domainName = (d: number) => {
      const dom = data.domains.find((x) => x.n === d)
      return dom ? dom.short || dom.name : "Other"
    }
    const nodes: GraphNode[] = [...model.nodes.values()].map((n) => ({
      id: n.id,
      label: labelText(n.label),
      size: minSize + 14 * Math.sqrt(n.weight / maxW),
      // Spheres have no outline, so not-studied ones need a fill that shows on either theme.
      fill: n.mastery == null ? css("--ink-3") : mix(seq0, seq1, clamp01(n.mastery)),
      data: {
        // Concepts of an open topic cluster under the topic, everything else under its domain.
        group: labelText(n.kind === "kc" && n.topic && !model.topicLevel ? (data.topics.find((t) => t.id === n.topic)?.title ?? n.topic) : domainName(n.domain)),
        // Not studied is already grey; faint marks a shaky estimate among the studied ones.
        unsure: n.mastery != null && n.sd > 0.15,
        misconception: n.misconceptions > 0,
      },
    }))
    // Solid lines only: reagraph builds a tube per dash, which costs seconds on a large graph.
    const edges = model.edges.map((e): GraphEdge => {
      const base = { id: edgeId(e), source: e.src, target: e.dst }
      if (e.type === "prerequisite") return { ...base, fill: colors.ink2, size: Math.min(4, 1 + e.n / 2) }
      if (e.type === "confusable") return { ...base, fill: colors.orange, arrowPlacement: "none", size: Math.min(5, 1 + e.weight / 3) }
      return { ...base, fill: colors.line, arrowPlacement: "none" }
    })
    const positions = mode === "prereq" ? dagLayout(nodes.map((n) => n.id), model.edges) : null
    const layoutOverrides = positions ? { getNodePosition: (id: string) => positions.get(id) as InternalGraphPosition } : { linkDistance: 60, nodeStrength: -180 }
    return { nodes, edges, theme: graphTheme(), colors, layoutOverrides }
    // The colours come from the theme's CSS variables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, data, mode, dark])

  // Hovering or selecting a node keeps its neighbourhood (in Prerequisites mode, everything it
  // needs first) and fades the rest.
  const focus = hover ?? selected
  const { selections, actives } = useMemo(() => {
    if (!focus || !model.nodes.has(focus)) return { selections: [], actives: [] }
    const ids = new Set([focus])
    const links: string[] = []
    if (mode === "prereq") {
      const stack = [focus]
      while (stack.length) {
        const x = stack.pop()!
        for (const e of model.edges)
          if (e.dst === x && !ids.has(e.src)) {
            ids.add(e.src)
            stack.push(e.src)
          }
      }
      for (const e of model.edges) if (ids.has(e.src) && ids.has(e.dst)) links.push(edgeId(e))
    } else
      for (const e of model.edges)
        if (e.src === focus || e.dst === focus) {
          ids.add(e.src)
          ids.add(e.dst)
          links.push(edgeId(e))
        }
    // The selected node stays lit while another one is hovered.
    if (selected && model.nodes.has(selected)) ids.add(selected)
    return { selections: [...new Set([focus, selected ?? focus])], actives: [...ids, ...links] }
  }, [focus, selected, model, mode])

  // Selection follows the panel: once the layout has placed it, frame the node with its
  // neighbourhood ("show context"), or centre it when it has none.
  useEffect(() => {
    if (!selected || !model.nodes.has(selected)) return
    const near = actives.filter((id) => model.nodes.has(id))
    const t = setTimeout(() => (near.length > 1 ? ref.current?.fitNodesInView(near) : ref.current?.centerGraph([selected])), 300)
    return () => clearTimeout(t)
    // Hovering changes the highlighted set; only a new selection moves the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, model])

  // Mastery stays the fill even while highlighted (reagraph would paint active nodes one colour);
  // a faint node is an unsure estimate, an orange ring a misconception, an ink ring the selection.
  const renderNode = ({ id, node, size, opacity, animated }: NodeRendererProps) => (
    <>
      <Sphere id={id} node={node} size={size} color={node.fill ?? colors.line} opacity={opacity * (node.data.unsure ? 0.5 : 1)} animated={animated} active={false} selected={false} />
      {node.data.misconception && <Ring color={colors.orange} size={size} opacity={opacity} animated={animated} innerRadius={2.4} strokeWidth={4} />}
      {id === selected && <Ring color={colors.ink} size={size} opacity={1} animated={animated} innerRadius={3.2} strokeWidth={6} />}
    </>
  )

  return (
    <div className="relative h-[62dvh] min-h-[420px] w-full" role="img" aria-label={`Concept map with ${model.nodes.size} nodes and ${model.edges.length} links. Use the table view for a keyboard-accessible list.`}>
      <GraphCanvas
        // reagraph frames the nodes only when it mounts: remount when the set of nodes changes.
        key={`${mode}:${nodes.length}:${nodes[0]?.id}`}
        ref={ref}
        nodes={nodes}
        edges={edges}
        theme={theme}
        labelFontUrl={labelFont}
        // The discrete GPU on a machine with two.
        glOptions={{ powerPreference: "high-performance" }}
        layoutType={mode === "prereq" ? "custom" : "forceDirected2d"}
        layoutOverrides={layoutOverrides}
        clusterAttribute={mode === "prereq" ? undefined : "group"}
        labelType={nodes.length > 150 ? "auto" : "all"}
        selections={selections}
        actives={actives}
        renderNode={renderNode}
        onNodeClick={(n) => onSelect(n.id)}
        onNodeDoubleClick={(n) => {
          if (n.id.startsWith("t:")) return onToggle(n.id.slice(2))
          const topic = model.nodes.get(n.id)?.topic
          if (topic && !model.topicLevel) onToggle(topic)
        }}
        onNodePointerOver={(n) => setHover(n.id)}
        onNodePointerOut={() => setHover(null)}
        onCanvasClick={() => onSelect(null)}
      />
      <Button variant="outline" size="icon" className="absolute right-3 top-3 size-8" onClick={() => ref.current?.fitNodesInView()} aria-label="Fit to screen">
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
        <span className="size-2.5 rounded-full bg-ink-3" /> not studied yet
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full opacity-50" style={{ background: "var(--seq)" }} /> faint = unsure estimate
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded-full border-2" style={{ borderColor: "var(--d2)" }} /> misconception
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
          <line x1="0" y1="4" x2="26" y2="4" stroke="var(--d2)" strokeWidth="2" />
        </svg>
        often confused
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <line x1="0" y1="4" x2="26" y2="4" stroke="var(--line)" strokeWidth="1.5" />
        </svg>
        related (similar content, not causal)
      </span>
      <span className="text-ink-3">Size = exam weight · double-click a topic to open its concepts, a concept to close them</span>
    </div>
  )
}

function NodeTable({ model, onSelect }: { model: { nodes: Map<string, NodeInfo>; edges: { src: string; dst: string; type: EdgeType }[] }; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<"mastery" | "weight" | "label">("mastery")
  const rows = [...model.nodes.values()].sort((a, b) => (sort === "label" ? a.label.localeCompare(b.label) : sort === "weight" ? b.weight - a.weight : (a.mastery ?? -1) - (b.mastery ?? -1)))
  const page = usePaged(rows, { reset: sort })
  const name = (id: string) => model.nodes.get(id)?.label ?? id
  return (
    <Card className="overflow-x-auto">
      <CardContent className="flex flex-col gap-3">
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
            {page.rows.map((n) => (
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
        <Pager p={page} />
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
          <p>Click a topic or concept to see its mastery, what it depends on and what you confuse it with. Double-click a topic to open its concepts, and one of them to close it again.</p>
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
