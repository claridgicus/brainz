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

interface SimNode extends SimulationNodeDatum {
  id: string;
  data: ApiNode;
  r: number;
}
type SimLink = SimulationLinkDatum<SimNode> & { relation: string };

const radiusFor = (degree: number): number => 6 + Math.sqrt(degree) * 2.4;

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
const enabledTypes = new Set(ALL_TYPES);
let focusId: string | null = null;
let selectedId: string | null = null;

const simNodes = new Map<string, SimNode>(); // persists positions across re-renders
let sim: Simulation<SimNode, SimLink> | null = null;
let viewport: SVGGElement;
let edgesG: SVGGElement;
let nodesG: SVGGElement;
const nodeEls = new Map<string, SVGGElement>();
const lineEls: { el: SVGLineElement; link: SimLink }[] = [];

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
}

const toGraphCoords = (cx: number, cy: number): [number, number] => {
  const rect = svg.getBoundingClientRect();
  return [(cx - rect.left - view.x) / view.k, (cy - rect.top - view.y) / view.k];
};

// ---------------------------------------------------------------- rendering

function visibleGraph(): GraphPayload {
  const focus = focusId ? neighborhood(graph.edges, focusId, 2) : null;
  return filterGraph(graph, { types: enabledTypes, focus });
}

function renderGraph(): void {
  const { nodes, edges } = visibleGraph();
  emptyHint.hidden = nodes.length > 0;

  const width = svg.clientWidth || 900;
  const height = svg.clientHeight || 600;

  // Reuse sim nodes so positions survive filter changes.
  const nodeList: SimNode[] = nodes.map((n) => {
    let sn = simNodes.get(n.id);
    if (!sn) {
      sn = { id: n.id, data: n, r: radiusFor(n.degree) };
      simNodes.set(n.id, sn);
    }
    sn.data = n;
    sn.r = radiusFor(n.degree);
    return sn;
  });
  const links: SimLink[] = edges.map((e) => ({ source: e.from, target: e.to, relation: e.relation }));

  sim?.stop();
  sim = forceSimulation<SimNode, SimLink>(nodeList)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(85)
        .strength(0.4),
    )
    .force("charge", forceManyBody().strength(-320))
    .force("center", forceCenter(width / 2, height / 2).strength(0.06))
    .force("x", forceX(width / 2).strength(0.045))
    .force("y", forceY(height / 2).strength(0.045))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + 6))
    .alpha(0.9)
    .alphaDecay(0.035)
    .on("tick", tick);

  // (Re)build DOM.
  edgesG.innerHTML = "";
  nodesG.innerHTML = "";
  nodeEls.clear();
  lineEls.length = 0;

  for (const link of links) {
    const line = document.createElementNS(SVG_NS, "line");
    if (link.relation !== "references") {
      line.classList.add("typed");
    }
    line.addEventListener("pointerenter", (ev) => showTooltip(ev, link.relation));
    line.addEventListener("pointermove", (ev) => showTooltip(ev, link.relation));
    line.addEventListener("pointerleave", hideTooltip);
    edgesG.append(line);
    lineEls.push({ el: line, link });
  }

  for (const sn of nodeList) {
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
    nodesG.append(g);
    nodeEls.set(sn.id, g);
  }
  tick();
}

const linkId = (end: SimLink["source"]): string =>
  typeof end === "object" ? end.id : String(end);

function tick(): void {
  for (const { el, link } of lineEls) {
    const s = link.source as SimNode;
    const t = link.target as SimNode;
    if (typeof s !== "object" || typeof t !== "object") continue;
    const dx = (t.x ?? 0) - (s.x ?? 0);
    const dy = (t.y ?? 0) - (s.y ?? 0);
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    // Trim ends so lines meet circle borders and arrowheads stay visible.
    el.setAttribute("x1", String((s.x ?? 0) + ux * (s.r + 1)));
    el.setAttribute("y1", String((s.y ?? 0) + uy * (s.r + 1)));
    el.setAttribute("x2", String((t.x ?? 0) - ux * (t.r + 3)));
    el.setAttribute("y2", String((t.y ?? 0) - uy * (t.r + 3)));
  }
  for (const [id, g] of nodeEls) {
    const sn = simNodes.get(id);
    if (sn) g.setAttribute("transform", `translate(${sn.x ?? 0},${sn.y ?? 0})`);
  }
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

function setHover(id: string | null): void {
  if (id === null) {
    svg.classList.remove("hovering");
    for (const g of nodeEls.values()) g.classList.remove("active", "nbr");
    for (const { el } of lineEls) el.classList.remove("hl");
    return;
  }
  svg.classList.add("hovering");
  const nbrs = neighborhood(graph.edges, id, 1);
  for (const [nid, g] of nodeEls) {
    g.classList.toggle("active", nid === id);
    g.classList.toggle("nbr", nid !== id && nbrs.has(nid));
  }
  for (const { el, link } of lineEls) {
    el.classList.toggle("hl", linkId(link.source) === id || linkId(link.target) === id);
  }
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
        sn.fx = null;
        sn.fy = null;
      } else {
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
    let [px, py] = [ev.clientX, ev.clientY];
    const onMove = (mv: PointerEvent): void => {
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
    if (!simNodes.has(id) || !nodeEls.has(id)) {
      // Node hidden by filter/focus — reset focus so it can be shown.
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
  wrap.innerHTML = ALL_TYPES.map(
    (t) => `<label class="filter">
      <input type="checkbox" checked data-type="${t}" />
      <span class="dot" style="background:${TYPE_COLORS[t]}"></span>
      <span class="label">${t}</span>
    </label>`,
  ).join("");
  wrap.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const type = input.dataset["type"];
    if (!type) return;
    if (input.checked) enabledTypes.add(type);
    else enabledTypes.delete(type);
    renderGraph();
  });
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
      if (focusId !== null) setFocus(null);
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
