<script lang="ts">
	// Burndown chart: remaining (open) line, scope step line, done area, the
	// ideal guide when the scope has dates, a "now" rule and scope-change ticks.
	// Geometry is pure ($lib/burndown-chart). Colours are local tokens with a
	// selected dark set (the app's theme) and a light set, validated with the
	// dataviz palette check; identity never rides on colour alone (legend +
	// direct end labels + dash pattern), and a data table mirrors the chart.
	import type { BurndownResultWire } from "@brainz/contracts";
	import { chartModel, nearestPoint, shortDay, type ChartModel } from "$lib/burndown-chart";

	let { result }: { result: BurndownResultWire } = $props();
	const uid = $props.id();
	const titleId = `bd-chart-title-${uid}`;

	const model = $derived<ChartModel | null>(chartModel(result));
	const unit = $derived(result.window.unit === "points" ? "pts" : "tasks");

	let svgEl = $state<SVGSVGElement | null>(null);
	let hover = $state<ChartModel["points"][number] | null>(null);
	let hoverChange = $state<ChartModel["changes"][number] | null>(null);

	function onMove(e: PointerEvent) {
		if (!model || !svgEl) return;
		const rect = svgEl.getBoundingClientRect();
		const x = ((e.clientX - rect.left) / rect.width) * model.box.width;
		hover = x >= model.x0 - 8 && x <= model.x1 + 8 ? nearestPoint(model, x) : null;
	}

	const summary = $derived.by(() => {
		const t = result.totals;
		return `${result.scope.title}: ${t.open} ${unit} remaining of ${t.scope}, ${t.done} done.`;
	});
	const tooltipLeft = $derived(
		hover && model ? `${(hover.x / model.box.width) * 100}%` : "0",
	);
	const flip = $derived(hover && model ? hover.x > model.box.width * 0.66 : false);
</script>

<div class="bd-root">
	{#if !model}
		<p class="muted">Not enough history to draw a chart yet.</p>
	{:else}
		<ul class="legend" aria-label="Legend">
			<li><span class="sw sw-remaining"></span>Remaining</li>
			<li><span class="sw sw-scope"></span>Scope</li>
			<li><span class="sw sw-done"></span>Done</li>
			{#if model.ideal}<li><span class="sw sw-ideal"></span>Ideal</li>{/if}
		</ul>
		<div class="plot">
			<svg
				bind:this={svgEl}
				viewBox="0 0 {model.box.width} {model.box.height}"
				role="img"
				aria-labelledby={titleId}
				onpointermove={onMove}
				onpointerleave={() => (hover = null)}
			>
				<title id={titleId}>{summary}</title>
				<!-- grid -->
				{#each model.yTicks as t (t.value)}
					<line class="grid" x1={model.x0} x2={model.x1} y1={t.pos} y2={t.pos} />
					<text class="axis" x={model.x0 - 6} y={t.pos} text-anchor="end" dominant-baseline="middle">{t.label}</text>
				{/each}
				{#each model.xTicks as t (t.value)}
					<text
						class="axis"
						x={t.pos}
						y={model.y0 + 18}
						text-anchor={t.pos > model.x1 - 24 ? "end" : t.pos < model.x0 + 24 ? "start" : "middle"}
					>{t.label}</text>
				{/each}
				<line class="baseline" x1={model.x0} x2={model.x1} y1={model.y0} y2={model.y0} />

				<!-- series -->
				<path class="done-area" d={model.doneArea} />
				<path class="done-line" d={model.doneLine} />
				{#if model.ideal}<path class="ideal" d={model.ideal} />{/if}
				<path class="scope" d={model.scope} />
				<path class="remaining" d={model.remaining} />

				{#if model.nowX !== null}
					<line class="now" x1={model.nowX} x2={model.nowX} y1={model.y1} y2={model.y0} />
					<text class="axis now-label" x={model.nowX + 4} y={model.y1 + 10}>now</text>
				{/if}

				<!-- scope-change ticks -->
				{#each model.changes as c (c.x)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<g
						class="change"
						onpointerenter={() => (hoverChange = c)}
						onpointerleave={() => (hoverChange = null)}
					>
						<rect x={c.x - 6} y={model.y0 - 4} width="12" height="14" fill="transparent" />
						<line x1={c.x} x2={c.x} y1={model.y0 - 3} y2={model.y0 + 5} />
					</g>
				{/each}

				<!-- end markers + direct labels -->
				{#if model.last}
					<circle class="marker m-remaining" cx={model.last.x} cy={model.last.yRemaining} r="4" />
					<text class="end-label" x={model.last.x + 8} y={model.last.yRemaining} dominant-baseline="middle">
						{model.last.remaining} left
					</text>
				{/if}

				{#if hover}
					<line class="crosshair" x1={hover.x} x2={hover.x} y1={model.y1} y2={model.y0} />
				{/if}
			</svg>
			{#if hover}
				<div class="tip" class:flip style="left:{tooltipLeft}" role="status">
					<div class="tip-head">{shortDay(hover.point.at)}</div>
					<div><span class="sw sw-remaining"></span>Remaining <b>{hover.point.open}</b></div>
					<div><span class="sw sw-scope"></span>Scope <b>{hover.point.scope}</b></div>
					<div><span class="sw sw-done"></span>Done <b>{hover.point.done}</b></div>
					{#if hover.point.ideal !== null}
						<div><span class="sw sw-ideal"></span>Ideal <b>{hover.point.ideal}</b></div>
					{/if}
				</div>
			{/if}
			{#if hoverChange}
				<div class="tip tip-change" style="left:{(hoverChange.x / model.box.width) * 100}%" role="status">
					<div class="tip-head">Scope change</div>
					{#each hoverChange.titles.slice(0, 6) as t, i (i)}<div>{t}</div>{/each}
					{#if hoverChange.titles.length > 6}<div class="muted">+{hoverChange.titles.length - 6} more</div>{/if}
				</div>
			{/if}
		</div>
		<details class="table-view">
			<summary>Data table</summary>
			<table>
				<thead>
					<tr><th scope="col">Date</th><th scope="col">Scope</th><th scope="col">Done</th><th scope="col">Remaining</th><th scope="col">Ideal</th></tr>
				</thead>
				<tbody>
					{#each result.series ?? [] as p (p.at)}
						<tr>
							<td>{shortDay(p.at)}</td>
							<td>{p.scope ?? "—"}</td>
							<td>{p.done ?? "—"}</td>
							<td>{p.open ?? "—"}</td>
							<td>{p.ideal ?? "—"}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</div>

<style>
	/* Chart tokens. The app is dark-themed: the dark steps are the default,
	   validated against the panel surface (#16161b); the light steps apply
	   under an explicit light theme. Slots: 1 blue = remaining, 2 orange =
	   scope, 3 aqua = done (adjacent and all-pairs CVD ΔE ≥ 9). */
	.bd-root {
		--bd-surface: var(--bg-raised, #16161b);
		--bd-grid: #26262d;
		--bd-axis: #a3a3af;
		--bd-text: #ececf1;
		--bd-remaining: #3987e5;
		--bd-scope: #d95926;
		--bd-done: #199e70;
		--bd-ideal: #8a8a96;
		position: relative;
	}
	:global(:root[data-theme="light"]) .bd-root {
		--bd-surface: #fcfcfb;
		--bd-grid: #e7e6e2;
		--bd-axis: #52514e;
		--bd-text: #0b0b0b;
		--bd-remaining: #2a78d6;
		--bd-scope: #eb6834;
		--bd-done: #1baf7a;
		--bd-ideal: #6f6e69;
	}
	.legend {
		display: flex;
		gap: 16px;
		list-style: none;
		padding: 0;
		margin: 0 0 8px;
		font-size: 12px;
		color: var(--bd-axis);
		flex-wrap: wrap;
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.sw {
		display: inline-block;
		width: 14px;
		height: 0;
		border-top: 2px solid;
		margin-right: 4px;
		vertical-align: middle;
	}
	.sw-remaining { border-color: var(--bd-remaining); }
	.sw-scope { border-color: var(--bd-scope); border-top-style: solid; border-top-width: 1.5px; }
	.sw-done { border-color: var(--bd-done); border-top-width: 6px; opacity: 0.7; }
	.sw-ideal { border-color: var(--bd-ideal); border-top-style: dashed; }
	.plot {
		position: relative;
	}
	svg {
		width: 100%;
		height: auto;
		display: block;
		touch-action: pan-y;
	}
	.grid {
		stroke: var(--bd-grid);
		stroke-width: 1;
	}
	.baseline {
		stroke: var(--bd-axis);
		stroke-opacity: 0.4;
		stroke-width: 1;
	}
	.axis {
		fill: var(--bd-axis);
		font-size: 11px;
	}
	.done-area {
		fill: var(--bd-done);
		fill-opacity: 0.12;
	}
	.done-line {
		fill: none;
		stroke: var(--bd-done);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.scope {
		fill: none;
		stroke: var(--bd-scope);
		stroke-width: 1.5;
		stroke-linejoin: round;
	}
	.remaining {
		fill: none;
		stroke: var(--bd-remaining);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.ideal {
		fill: none;
		stroke: var(--bd-ideal);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.now {
		stroke: var(--bd-axis);
		stroke-width: 1;
		stroke-opacity: 0.5;
	}
	.change line {
		stroke: var(--bd-scope);
		stroke-width: 2;
		stroke-linecap: round;
	}
	.marker {
		stroke: var(--bd-surface);
		stroke-width: 2;
	}
	.m-remaining { fill: var(--bd-remaining); }
	.end-label {
		fill: var(--bd-text);
		font-size: 11px;
	}
	.crosshair {
		stroke: var(--bd-axis);
		stroke-width: 1;
		stroke-opacity: 0.6;
	}
	.tip {
		position: absolute;
		top: 8px;
		transform: translateX(12px);
		background: var(--bg-overlay, #1e1e25);
		border: 1px solid var(--border-strong, #37373f);
		border-radius: 8px;
		padding: 8px 10px;
		font-size: 12px;
		color: var(--bd-text);
		pointer-events: none;
		min-width: 140px;
		z-index: 2;
	}
	.tip.flip {
		transform: translateX(calc(-100% - 12px));
	}
	.tip-change {
		top: auto;
		bottom: 34px;
		transform: translateX(-50%);
	}
	.tip-head {
		color: var(--bd-axis);
		margin-bottom: 4px;
	}
	.tip b {
		font-variant-numeric: tabular-nums;
		float: right;
		margin-left: 12px;
	}
	.table-view {
		margin-top: 8px;
		font-size: 12px;
		color: var(--bd-axis);
	}
	.table-view table {
		border-collapse: collapse;
		margin-top: 6px;
		width: 100%;
	}
	.table-view th,
	.table-view td {
		text-align: right;
		padding: 2px 8px;
		font-variant-numeric: tabular-nums;
		color: var(--bd-text);
	}
	.table-view th:first-child,
	.table-view td:first-child {
		text-align: left;
	}
</style>
