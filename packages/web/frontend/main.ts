import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { filterGraph, neighborhood } from "./graph-data.js";
import {
  cullEdge,
  defaultEnabledTypes,
  focusRevealSet,
  isDimmed,
  isEdgeDimmed,
  isInViewport,
  radiusForTypeDegree,
  typeClusterCenter,
  viewportRect,
  type ViewportRect,
} from "./graph-view.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import type {
  ApiEdge,
  ApiNode,
  ConceptDetail,
  GraphPayload,
  SearchHitPayload,
  StatsPayload,
} from "./types.js";

// ---------------------------------------------------------------- constants

const TYPE_COLORS: Record<string, string> = {
  concept: "#4f9cf9",
  domain: "#f472b6",
  feature: "#34d399",
  story: "#a3e635",
  spec: "#2dd4bf",
  workflow: "#fb923c",
  task: "#f59e0b",
  decision: "#fbbf24",
  constraint: "#f87171",
  pattern: "#a78bfa",
  glossary: "#22d3ee",
  pending: "#6b7280",
};
const ALL_TYPES = Object.keys(TYPE_COLORS);
const SVG_NS = "http://www.w3.org/2000/svg";

// Extra graph-space padding (~1 viewport-ish) so nodes just off the edge stay
// in the DOM and pans don't visibly pop elements in and out.
const CULL_PAD = 120;

interface SimNode extends SimulationNodeDatum {
  id: string;
  data: ApiNode;
  r: number;
}
type SimLink = SimulationLinkDatum<SimNode> & { relation: string };


// ---------------------------------------------------------------- dom refs

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const svg = document.getElementById("graph") as unknown as SVGSVGElement;
const tooltip = $("tooltip");
const panel = $("panel");
const focusChip = $<HTMLButtonElement>("focus-chip");
const searchInput = $<HTMLInputElement>("search");
const searchResults = $("search-results");
const emptyHint = $("empty-hint");

// ---------------------------------------------------------------- state

let graph: GraphPayload = { nodes: [], edges: [] };
const enabledTypes = defaultEnabledTypes();
let focusId: string | null = null;
let selectedId: string | null = null;
let hoverId: string | null = null;
let hoverNbrs: Set<string> = new Set();
// Sticky click-focus (distinct from `focusId`, the 2-hop panel focus filter, and
// from hover): clicking a node dims non-neighbors and reveals its 1-hop
// neighbors across the type filter. Cleared by empty-canvas click / Escape /
// clicking the focused node again.
let stickyFocusId: string | null = null;
let stickyReveal: Set<string> = new Set();

const simNodes = new Map<string, SimNode>(); // persists positions across re-renders
let sim: Simulation<SimNode, SimLink> | null = null;
let viewport: SVGGElement;
let edgesG: SVGGElement;
let nodesG: SVGGElement;

// The force sim runs on the full (type-filtered) set; the DOM only holds the
// culled viewport subset. `nodeEls`/`lineEls` map ids to *currently mounted*
// elements; `simNodeList`/`simLinks` are the full layout inputs.
let simNodeList: SimNode[] = [];
let simLinks: SimLink[] = [];
const layoutIds = new Set<string>(); // ids currently in the type/focus-filtered layout
const nodeEls = new Map<string, SVGGElement>();
const lineEls = new Map<SimLink, SVGLineElement>();

const view = { x: 0, y: 0, k: 1 };

// ---------------------------------------------------------------- svg setup

function setupSvg(): void {
  svg.innerHTML = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9 Z" fill="#3a4557"></path>
      </marker>
      <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9 Z" fill="#7fb4fb"></path>
      </marker>
    </defs>`;
  viewport = document.createElementNS(SVG_NS, "g");
  edgesG = document.createElementNS(SVG_NS, "g");
  nodesG = document.createElementNS(SVG_NS, "g");
  viewport.append(edgesG, nodesG);
  svg.append(viewport);
  applyView();
}

function applyView(): void {
  viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  svg.classList.toggle("labels-hidden", view.k < 0.45);
  // Pan/zoom changes the visible viewport — re-cull the DOM (rAF-throttled).
  scheduleCull();
}

const toGraphCoords = (cx: number, cy: number): [number, number] => {
  const rect = svg.getBoundingClientRect();
  return [(cx - rect.left - view.x) / view.k, (cy - rect.top - view.y) / view.k];
};

// ---------------------------------------------------------------- rendering

function visibleGraph(): GraphPayload {
  const focus = focusId ? neighborhood(graph.edges, focusId, 2) : null;
  const filtered = filterGraph(graph, { types: enabledTypes, focus });
  // Sticky click-focus reveals the focused node's 1-hop neighbors even if their
  // type is off — union them back in so the sim + DOM can show (dimly) them.
  if (stickyReveal.size === 0) return filtered;
  const kept = new Set(filtered.nodes.map((n) => n.id));
  const extra = graph.nodes.filter((n) => stickyReveal.has(n.id) && !kept.has(n.id));
  if (extra.length === 0) return filtered;
  const nodes = [...filtered.nodes, ...extra];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

function renderGraph(): void {
  const { nodes, edges } = visibleGraph();
  emptyHint.hidden = nodes.length > 0;

  const width = svg.clientWidth || 900;
  const height = svg.clientHeight || 600;

  // Reuse sim nodes so positions survive filter changes.
  simNodeList = nodes.map((n) => {
    const r = radiusForTypeDegree(n.type, n.degree);
    let sn = simNodes.get(n.id);
    if (!sn) {
      sn = { id: n.id, data: n, r };
      simNodes.set(n.id, sn);
    }
    sn.data = n;
    sn.r = r;
    return sn;
  });
  simLinks = edges.map((e) => ({ source: e.from, target: e.to, relation: e.relation }));
  layoutIds.clear();
  for (const sn of simNodeList) layoutIds.add(sn.id);

  // Drop sticky focus if its node vanished from the data.
  if (stickyFocusId && !graph.nodes.some((n) => n.id === stickyFocusId)) {
    stickyFocusId = null;
    stickyReveal = new Set();
    svg.classList.remove("focusing");
  }

  // The force sim runs on the *full* type-filtered set (layout is correct even
  // for nodes the viewport culls out of the DOM).
  sim?.stop();
  // Layout tuning (mirrors apps/cloud Graph.svelte): wider link distance,
  // stronger charge, and a hard collide constraint so nodes visibly separate.
  sim = forceSimulation<SimNode, SimLink>(simNodeList)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(130)
        .strength(0.4),
    )
    .force("charge", forceManyBody().strength(-520).distanceMax(900))
    .force("center", forceCenter(width / 2, height / 2).strength(0.02))
    // Type clustering: pull each node toward its concept type's cluster center
    // so same-type nodes form discrete clouds; cross-type edges pull clouds to
    // overlap Venn-style (mirrors apps/cloud Graph.svelte).
    .force("x", forceX<SimNode>((d) => typeClusterCenter(d.data.type, ALL_TYPES, width, height).x).strength(0.09))
    .force("y", forceY<SimNode>((d) => typeClusterCenter(d.data.type, ALL_TYPES, width, height).y).strength(0.09))
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => d.r + 14)
        .strength(0.9)
        .iterations(2),
    )
    .alpha(0.9)
    .alphaDecay(0.035)
    .on("tick", tick);

  // Drop every mounted element; the cull pass re-mounts only the viewport subset.
  edgesG.innerHTML = "";
  nodesG.innerHTML = "";
  nodeEls.clear();
  lineEls.clear();
  cullRender();
}

const linkId = (end: SimLink["source"]): string =>
  typeof end === "object" ? end.id : String(end);

// -------- element factories (mounted lazily by the viewport cull) --------

function createNodeEl(sn: SimNode): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.classList.add("node");
  if (sn.data.pending) g.classList.add("pending");
  if (sn.id === selectedId) g.classList.add("selected");
  g.dataset["id"] = sn.id;

  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("r", String(sn.r));
  circle.setAttribute("fill", TYPE_COLORS[sn.data.type] ?? TYPE_COLORS["pending"]!);

  const label = document.createElementNS(SVG_NS, "text");
  label.textContent = sn.data.title;
  label.setAttribute("dy", String(sn.r + 13));

  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = `${sn.data.title} (${sn.data.type}${sn.data.pending ? ", pending" : ""})`;

  g.append(circle, label, title);
  attachNodeEvents(g, sn);
  return g;
}

function createLineEl(link: SimLink): SVGLineElement {
  const line = document.createElementNS(SVG_NS, "line");
  if (link.relation !== "references") line.classList.add("typed");
  line.addEventListener("pointerenter", (ev) => showTooltip(ev, link.relation));
  line.addEventListener("pointermove", (ev) => showTooltip(ev, link.relation));
  line.addEventListener("pointerleave", hideTooltip);
  return line;
}

// -------- viewport culling: only in-viewport elements live in the DOM --------

let cullScheduled = false;

/** rAF-throttled re-cull, used on pan/zoom where positions don't change but the viewport does. */
function scheduleCull(): void {
  if (cullScheduled) return;
  cullScheduled = true;
  requestAnimationFrame(() => {
    cullScheduled = false;
    cullRender();
  });
}

function currentViewport(): ViewportRect {
  const width = svg.clientWidth || 900;
  const height = svg.clientHeight || 600;
  return viewportRect(width, height, view, CULL_PAD);
}

/**
 * Reconcile the DOM against the current viewport: mount visible-type nodes that
 * fall inside the viewport, unmount those that leave it, and draw each edge in
 * full / as a stub / not at all per `cullEdge`. The force sim keeps running on
 * the full set, so unmounting a node never disturbs layout.
 */
function cullRender(): void {
  const vp = currentViewport();

  // Nodes: mount/unmount by viewport membership, keeping element identity.
  // While focused, the reveal set (focused node + 1-hop neighbors) is forced
  // into the mounted set so off-screen neighbors aren't culled away.
  const visible = new Set<string>();
  for (const sn of simNodeList) {
    const x = sn.x ?? 0;
    const y = sn.y ?? 0;
    const inView = isInViewport(x, y, sn.r, vp) || stickyReveal.has(sn.id);
    let g = nodeEls.get(sn.id);
    if (inView) {
      visible.add(sn.id);
      if (!g) {
        g = createNodeEl(sn);
        nodeEls.set(sn.id, g);
        nodesG.append(g);
        if (hoverId !== null) applyHoverClass(sn.id, g);
      }
      if (stickyFocusId !== null) applyFocusClass(sn.id, g);
      g.setAttribute("transform", `translate(${x},${y})`);
    } else if (g) {
      g.remove();
      nodeEls.delete(sn.id);
    }
  }

  // Edges: draw only those with at least one visible endpoint; stub the ones
  // that run off to an unmounted node.
  for (const link of simLinks) {
    const s = link.source as SimNode;
    const t = link.target as SimNode;
    let line = lineEls.get(link);
    if (typeof s !== "object" || typeof t !== "object") {
      if (line) {
        line.remove();
        lineEls.delete(link);
      }
      continue;
    }
    const sx = s.x ?? 0;
    const sy = s.y ?? 0;
    const tx = t.x ?? 0;
    const ty = t.y ?? 0;
    const res = cullEdge(
      { x: sx, y: sy },
      { x: tx, y: ty },
      visible.has(s.id),
      visible.has(t.id),
      vp,
    );
    if (res.kind === "drop") {
      if (line) {
        line.remove();
        lineEls.delete(link);
      }
      continue;
    }
    if (!line) {
      line = createLineEl(link);
      lineEls.set(link, line);
      edgesG.append(line);
      if (hoverId !== null && (s.id === hoverId || t.id === hoverId)) line.classList.add("hl");
    }
    if (stickyFocusId !== null) line.classList.toggle("dim", isEdgeDimmed(s.id, t.id, stickyFocusId));
    // Trim ends so full lines meet circle borders and arrowheads stay visible;
    // stub ends terminate at the viewport edge and are left untrimmed.
    const { x1, y1, x2, y2 } = res.ends;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const trimS = res.kind === "full" || res.ends.x1 === sx && res.ends.y1 === sy ? s.r + 1 : 0;
    const trimT = res.kind === "full" || res.ends.x2 === tx && res.ends.y2 === ty ? t.r + 3 : 0;
    line.setAttribute("x1", String(x1 + ux * trimS));
    line.setAttribute("y1", String(y1 + uy * trimS));
    line.setAttribute("x2", String(x2 - ux * trimT));
    line.setAttribute("y2", String(y2 - uy * trimT));
  }
}

function tick(): void {
  // Positions moved; re-evaluate which elements belong in the DOM.
  cullRender();
}

// ---------------------------------------------------------------- hover / tooltip

function showTooltip(ev: PointerEvent, text: string): void {
  tooltip.textContent = text;
  tooltip.hidden = false;
  tooltip.style.left = `${ev.clientX + 12}px`;
  tooltip.style.top = `${ev.clientY + 12}px`;
}
function hideTooltip(): void {
  tooltip.hidden = true;
}

/** Apply the current hover highlight to a single (freshly mounted) node element. */
function applyHoverClass(id: string, g: SVGGElement): void {
  g.classList.toggle("active", id === hoverId);
  g.classList.toggle("nbr", id !== hoverId && hoverNbrs.has(id));
}

function setHover(id: string | null): void {
  hoverId = id;
  if (id === null) {
    hoverNbrs = new Set();
    svg.classList.remove("hovering");
    for (const g of nodeEls.values()) g.classList.remove("active", "nbr");
    for (const el of lineEls.values()) el.classList.remove("hl");
    return;
  }
  svg.classList.add("hovering");
  hoverNbrs = neighborhood(graph.edges, id, 1);
  for (const [nid, g] of nodeEls) applyHoverClass(nid, g);
  for (const [link, el] of lineEls) {
    el.classList.toggle("hl", linkId(link.source) === id || linkId(link.target) === id);
  }
}

// ---------------------------------------------------------------- sticky click focus

/** Apply the sticky-focus classes to a single (freshly mounted) node element. */
function applyFocusClass(id: string, g: SVGGElement): void {
  g.classList.toggle("dim", isDimmed(id, stickyReveal));
  g.classList.toggle("focused", id === stickyFocusId);
}

/**
 * Set (or clear) the sticky click-focus. Clicking the already-focused node
 * clears it. Recomputes the reveal set and re-renders so newly-revealed
 * off-type neighbors enter the sim/DOM; the cull pass paints the dim.
 */
function setStickyFocus(id: string | null): void {
  const next = id !== null && id === stickyFocusId ? null : id;
  if (next === stickyFocusId) return;
  stickyFocusId = next;
  stickyReveal = focusRevealSet(next, graph.edges);
  svg.classList.toggle("focusing", next !== null);
  if (next === null) {
    for (const g of nodeEls.values()) g.classList.remove("dim", "focused");
    for (const el of lineEls.values()) el.classList.remove("dim");
  }
  renderGraph();
}

// ---------------------------------------------------------------- node drag + click

function attachNodeEvents(g: SVGGElement, sn: SimNode): void {
  g.addEventListener("pointerenter", () => setHover(sn.id));
  g.addEventListener("pointerleave", () => setHover(null));

  g.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    g.setPointerCapture(ev.pointerId);
    const start = [ev.clientX, ev.clientY];
    let moved = false;

    const onMove = (mv: PointerEvent): void => {
      if (!moved && Math.hypot(mv.clientX - start[0]!, mv.clientY - start[1]!) < 4) return;
      if (!moved) {
        moved = true;
        sim?.alphaTarget(0.3).restart();
      }
      const [gx, gy] = toGraphCoords(mv.clientX, mv.clientY);
      sn.fx = gx;
      sn.fy = gy;
    };
    const onUp = (): void => {
      g.removeEventListener("pointermove", onMove);
      g.removeEventListener("pointerup", onUp);
      g.removeEventListener("pointercancel", onUp);
      if (moved) {
        sim?.alphaTarget(0);
        // ANCHOR: keep fx/fy set so the dropped node stays pinned (mirrors the
        // cloud graph's drag-to-anchor). No per-vault localStorage persistence
        // here — the static web viewer has no vault-id/toolbar to key or reset.
      } else {
        // A click (no drag): open the panel AND toggle sticky focus on this node.
        setStickyFocus(sn.id);
        void selectNode(sn.id);
      }
    };
    g.addEventListener("pointermove", onMove);
    g.addEventListener("pointerup", onUp);
    g.addEventListener("pointercancel", onUp);
  });
}

// ---------------------------------------------------------------- pan + zoom

function setupPanZoom(): void {
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    svg.classList.add("panning");
    svg.setPointerCapture(ev.pointerId);
    const [sx, sy] = [ev.clientX, ev.clientY];
    let [px, py] = [ev.clientX, ev.clientY];
    let moved = false;
    const onMove = (mv: PointerEvent): void => {
      if (!moved && Math.hypot(mv.clientX - sx, mv.clientY - sy) >= 4) moved = true;
      view.x += mv.clientX - px;
      view.y += mv.clientY - py;
      [px, py] = [mv.clientX, mv.clientY];
      applyView();
    };
    const onUp = (): void => {
      svg.classList.remove("panning");
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
      // A click on empty canvas (no pan) clears any sticky focus. Node clicks
      // stopPropagation on pointerdown, so this only fires for the background.
      if (!moved && stickyFocusId !== null) setStickyFocus(null);
    };
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
  });

  svg.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const k = Math.min(8, Math.max(0.12, view.k * Math.exp(-ev.deltaY * 0.0022)));
      // Keep the point under the cursor fixed.
      view.x = cx - ((cx - view.x) / view.k) * k;
      view.y = cy - ((cy - view.y) / view.k) * k;
      view.k = k;
      applyView();
    },
    { passive: false },
  );
}

function panToNode(id: string): void {
  const sn = simNodes.get(id);
  if (!sn) return;
  const rect = svg.getBoundingClientRect();
  const targetK = Math.max(view.k, 1);
  const tx = rect.width / 2 - (sn.x ?? 0) * targetK;
  const ty = rect.height / 2 - (sn.y ?? 0) * targetK;
  animateView(tx, ty, targetK);
}

function animateView(tx: number, ty: number, tk: number): void {
  const from = { ...view };
  const t0 = performance.now();
  const dur = 380;
  const step = (t: number): void => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - (1 - p) ** 3; // ease-out cubic
    view.x = from.x + (tx - from.x) * e;
    view.y = from.y + (ty - from.y) * e;
    view.k = from.k + (tk - from.k) * e;
    applyView();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- side panel

function badge(text: string, cls = "", dotColor?: string): string {
  const dot = dotColor ? `<span class="dot" style="background:${dotColor}"></span>` : "";
  return `<span class="badge ${cls}">${dot}${escapeHtml(text)}</span>`;
}

const nodeById = (id: string): ApiNode | undefined => graph.nodes.find((n) => n.id === id);

function edgeRow(e: ApiEdge, otherId: string, dir: "→" | "←"): string {
  const other = nodeById(otherId);
  const pending = !other || other.pending;
  const label = other ? other.title : otherId;
  return `<div class="edge-row">
    <span class="edge-rel">${dir} ${escapeHtml(e.relation)}</span>
    <a class="edge-target${pending ? " pending" : ""}" data-nav="${escapeHtml(otherId)}" href="#concept:${escapeHtml(otherId)}">${escapeHtml(label)}${pending ? " (pending)" : ""}</a>
  </div>`;
}

async function selectNode(id: string): Promise<void> {
  selectedId = id;
  for (const [nid, g] of nodeEls) g.classList.toggle("selected", nid === id);

  const node = nodeById(id);
  $("panel-title").textContent = node?.title ?? id;
  panel.hidden = false;

  const focusBtn = $<HTMLButtonElement>("panel-focus");
  focusBtn.classList.toggle("on", focusId === id);

  if (node?.pending) {
    $("panel-badges").innerHTML = badge("pending", "type", TYPE_COLORS["pending"]);
    $("panel-body").innerHTML =
      `<p><em>This concept doesn't exist yet — it's referenced by other notes but has no file in the vault.</em></p>`;
    renderPanelEdges(
      graph.edges.filter((e) => e.from === id),
      graph.edges.filter((e) => e.to === id),
    );
    return;
  }

  try {
    const res = await fetch(`/api/concept/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = (await res.json()) as ConceptDetail;
    $("panel-title").textContent = detail.title;
    const badges = [
      badge(detail.type, "type", TYPE_COLORS[detail.type]),
      detail.product ? badge(detail.product) : "",
      detail.status !== "active" ? badge(detail.status) : "",
      ...detail.tags.map((t) => badge(`#${t}`)),
      ...(detail.codeAreas ?? []).map((a) => badge(a, "code-area")),
    ];
    $("panel-badges").innerHTML = badges.join("");
    $("panel-body").innerHTML = renderMarkdown(detail.body);
    renderPanelEdges(detail.edges.outgoing, detail.edges.incoming);
  } catch (err) {
    $("panel-body").innerHTML = `<p><em>Failed to load concept: ${escapeHtml(String(err))}</em></p>`;
    $("panel-badges").innerHTML = "";
    $("panel-edges").innerHTML = "";
  }
}

function renderPanelEdges(outgoing: ApiEdge[], incoming: ApiEdge[]): void {
  const parts: string[] = [];
  if (outgoing.length > 0) {
    parts.push(`<h3>Outgoing (${outgoing.length})</h3>`);
    parts.push(...outgoing.map((e) => edgeRow(e, e.to, "→")));
  }
  if (incoming.length > 0) {
    parts.push(`<h3>Incoming (${incoming.length})</h3>`);
    parts.push(...incoming.map((e) => edgeRow(e, e.from, "←")));
  }
  $("panel-edges").innerHTML = parts.join("") || `<h3>No edges</h3>`;
}

function closePanel(): void {
  panel.hidden = true;
  selectedId = null;
  for (const g of nodeEls.values()) g.classList.remove("selected");
}

// ---------------------------------------------------------------- focus mode

function setFocus(id: string | null): void {
  focusId = id;
  const node = id ? nodeById(id) : null;
  focusChip.hidden = id === null;
  if (node) focusChip.textContent = `Focused: ${node.title} ✕`;
  $<HTMLButtonElement>("panel-focus").classList.toggle("on", id !== null && id === selectedId);
  renderGraph();
}

// ---------------------------------------------------------------- search

function setupSearch(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeIdx = -1;
  let hits: SearchHitPayload[] = [];

  const close = (): void => {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
    activeIdx = -1;
    hits = [];
  };

  const pick = (idx: number): void => {
    const hit = hits[idx];
    if (!hit) return;
    close();
    searchInput.blur();
    const id = hit.concept.id;
    if (!layoutIds.has(id)) {
      // Node hidden by filter/focus — reset focus and enable its type so it renders.
      setFocus(null);
      enabledTypes.add(hit.concept.type);
      syncFilterCheckboxes();
      renderGraph();
    }
    panToNode(id);
    void selectNode(id);
  };

  const renderHits = (): void => {
    if (hits.length === 0) {
      searchResults.innerHTML = `<div class="search-empty">No results</div>`;
    } else {
      searchResults.innerHTML = hits
        .map(
          (h, i) => `<div class="search-hit${i === activeIdx ? " active" : ""}" data-idx="${i}">
            <div class="hit-title"><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TYPE_COLORS[h.concept.type] ?? "#6b7280"};margin-right:6px"></span>${escapeHtml(h.concept.title)} <span style="color:var(--text-dim);font-size:11px">${escapeHtml(h.concept.type)}</span></div>
            <div class="hit-snippet">${escapeHtml(h.snippet)}</div>
          </div>`,
        )
        .join("");
      for (const el of searchResults.querySelectorAll<HTMLElement>(".search-hit")) {
        el.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          pick(Number(el.dataset["idx"]));
        });
      }
    }
    searchResults.hidden = false;
  };

  searchInput.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    const q = searchInput.value.trim();
    if (!q) {
      close();
      return;
    }
    timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => r.json())
        .then((body: { hits?: SearchHitPayload[] }) => {
          hits = body.hits ?? [];
          activeIdx = hits.length > 0 ? 0 : -1;
          renderHits();
        })
        .catch(close);
    }, 140);
  });

  searchInput.addEventListener("keydown", (ev) => {
    if (searchResults.hidden) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const delta = ev.key === "ArrowDown" ? 1 : -1;
      activeIdx = (activeIdx + delta + hits.length) % Math.max(1, hits.length);
      renderHits();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pick(activeIdx);
    } else if (ev.key === "Escape") {
      close();
      searchInput.blur();
    }
  });

  searchInput.addEventListener("blur", () => setTimeout(close, 150));
}

// ---------------------------------------------------------------- filters

function syncFilterCheckboxes(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("#filters input")) {
    input.checked = enabledTypes.has(input.dataset["type"] ?? "");
  }
}

function setupFilters(): void {
  const wrap = $("filters");
  // Only default-on types are checked on first load; off types render nothing
  // until toggled. "All" / "Reset" toggle the whole set.
  const checkboxes = ALL_TYPES.map(
    (t) => `<label class="filter">
      <input type="checkbox"${enabledTypes.has(t) ? " checked" : ""} data-type="${t}" />
      <span class="dot" style="background:${TYPE_COLORS[t]}"></span>
      <span class="label">${t}</span>
    </label>`,
  ).join("");
  wrap.innerHTML =
    checkboxes +
    `<button id="filter-all" class="filter-action" title="Show every node type">All</button>` +
    `<button id="filter-reset" class="filter-action" title="Reset to default node types">Reset</button>`;

  wrap.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const type = input.dataset["type"];
    if (!type) return;
    if (input.checked) enabledTypes.add(type);
    else enabledTypes.delete(type);
    renderGraph();
  });

  const setTypes = (types: Iterable<string>): void => {
    enabledTypes.clear();
    for (const t of types) enabledTypes.add(t);
    syncFilterCheckboxes();
    renderGraph();
  };
  $<HTMLButtonElement>("filter-all").addEventListener("click", () => setTypes(ALL_TYPES));
  $<HTMLButtonElement>("filter-reset").addEventListener("click", () =>
    setTypes(defaultEnabledTypes()),
  );
}

// ---------------------------------------------------------------- boot

async function loadData(): Promise<void> {
  const [graphRes, statsRes] = await Promise.all([fetch("/api/graph"), fetch("/api/stats")]);
  graph = (await graphRes.json()) as GraphPayload;
  const stats = (await statsRes.json()) as StatsPayload;
  $("vault-name").textContent = stats.name;
  const pendingCount = graph.nodes.filter((n) => n.pending).length;
  $("vault-stats").textContent =
    `${stats.concepts} concepts · ${stats.edges} edges` +
    (pendingCount > 0 ? ` · ${pendingCount} pending` : "") +
    ` · embeddings ${stats.embeddingStatus}`;
  document.title = `${stats.name} — Brainz`;
}

function setupGlobalKeys(): void {
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== searchInput) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (ev.key === "Escape" && document.activeElement !== searchInput) {
      if (stickyFocusId !== null) setStickyFocus(null);
      else if (focusId !== null) setFocus(null);
      else closePanel();
    }
  });

  // Intercept internal links from rendered markdown + edge lists.
  panel.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#concept:")) {
      ev.preventDefault();
      const id = decodeURIComponent(href.slice("#concept:".length));
      if (nodeById(id)) {
        panToNode(id);
        void selectNode(id);
      }
    } else if (href.startsWith("http")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });

  $("panel-close").addEventListener("click", closePanel);
  $("panel-focus").addEventListener("click", () => {
    if (selectedId === null) return;
    setFocus(focusId === selectedId ? null : selectedId);
  });
  focusChip.addEventListener("click", () => setFocus(null));
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderGraph, 200);
  });
}

async function main(): Promise<void> {
  setupSvg();
  setupPanZoom();
  setupFilters();
  setupSearch();
  setupGlobalKeys();
  await loadData();
  renderGraph();
}

void main();
