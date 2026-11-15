<script lang="ts">
	// Burndown panel (SPEC-CLOUD.md "Burndown"): pick a scope, then the chart,
	// velocity, projection, stale claims and the per-agent table. Polls every
	// 15s. Iterations and milestones are listed below with create/edit; they
	// are ordinary concepts saved through the concept REST endpoints.
	import type { ToolConceptMeta } from "@brainz/contracts";
	import { goto } from "$app/navigation";
	import { ApiError, createApi, roleOf, type Burndown } from "$lib/api";
	import { fmtHours, shortDay, velocityKey } from "$lib/burndown-chart";
	import BurndownChart from "$lib/components/BurndownChart.svelte";
	import { vaultTabLinks } from "$lib/nav";
	import { onMount } from "svelte";

	let { data } = $props();
	const api = createApi(fetch);
	const vault = $derived(data.vault);
	const canEdit = $derived(roleOf(data.vault) !== "viewer");

	// svelte-ignore state_referenced_locally
	let concepts = $state<ToolConceptMeta[]>(data.concepts);
	// svelte-ignore state_referenced_locally
	let result = $state<Burndown | null>(data.burndown);
	// svelte-ignore state_referenced_locally
	let loadError = $state<string | null>(data.error);
	$effect(() => {
		concepts = data.concepts;
		result = data.burndown;
		loadError = data.error;
	});
	const scope = $derived(data.scope);
	const unit = $derived(data.unit as "tasks" | "points");
	const unitLabel = $derived(unit === "points" ? "pts" : "tasks");

	// ------------------------------------------------------------ scopes
	const SCOPE_GROUPS: [string, string][] = [
		["iteration", "Iterations"],
		["milestone", "Milestones"],
		["domain", "Domains"],
		["feature", "Features"],
	];
	const taskTags = $derived(
		[...new Set(concepts.filter((c) => c.type === "task").flatMap((c) => c.tags))].sort(),
	);
	/** `?scope=&unit=` for a scope/unit change — rendered into real hrefs so the
	 * links work before hydration (and without JS); SvelteKit routes them
	 * client-side once hydrated. */
	function queryHref(next: { scope?: string; unit?: string }): string {
		const params = new URLSearchParams();
		const s = next.scope ?? scope;
		const un = next.unit ?? unit;
		if (s) params.set("scope", s);
		if (un === "points") params.set("unit", "points");
		const qs = params.toString();
		return qs ? `?${qs}` : "?";
	}
	function setQuery(next: { scope?: string; unit?: string }) {
		void goto(queryHref(next), { keepFocus: true, noScroll: true });
	}

	// Controls that only work with JS (the chart hover, the iteration editor)
	// stay disabled until the page has hydrated, so an early click is never
	// silently dropped; `data-hydrated` on the root marks the moment.
	let hydrated = $state(false);

	// ------------------------------------------------------------ polling
	const POLL_MS = 15000;
	onMount(() => {
		hydrated = true;
		const timer = setInterval(async () => {
			try {
				const next = await api.burndown(vault.id, { scope: scope || undefined, unit });
				if (JSON.stringify(next) !== JSON.stringify(result)) result = next;
				loadError = null;
			} catch {
				/* keep the last good result */
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const velocityMax = $derived(
		Math.max(1, ...(result?.velocity?.periods.map((p) => p.done) ?? [0])),
	);

	// --------------------------------------------- iterations & milestones
	const containers = $derived(
		concepts
			.filter((c) => c.type === "iteration" || c.type === "milestone")
			.sort(
				(a, b) =>
					(b.startDate ?? b.endDate ?? "").localeCompare(a.startDate ?? a.endDate ?? "") ||
					a.title.localeCompare(b.title),
			),
	);
	const milestones = $derived(concepts.filter((c) => c.type === "milestone"));

	interface Draft {
		id?: string;
		title: string;
		type: "iteration" | "milestone";
		startDate: string;
		endDate: string;
		parent: string;
		body: string;
	}
	const emptyDraft = (type: Draft["type"] = "iteration"): Draft => ({
		title: "",
		type,
		startDate: "",
		endDate: "",
		parent: "",
		body: "",
	});
	let draft = $state<Draft | null>(null);
	let saving = $state(false);
	let formError = $state<string | null>(null);

	async function edit(c: ToolConceptMeta) {
		formError = null;
		try {
			const full = await api.getConcept(vault.id, c.id);
			const parent =
				(await api.graph(vault.id)).edges.find(
					(e) => e.from === c.id && e.relation === "part_of" && milestones.some((m) => m.id === e.to),
				)?.to ?? "";
			draft = {
				id: c.id,
				title: full.title,
				type: c.type === "milestone" ? "milestone" : "iteration",
				startDate: full.startDate ?? "",
				endDate: full.endDate ?? "",
				parent,
				body: full.body,
			};
		} catch (err) {
			formError = err instanceof ApiError ? err.message : "Could not load it.";
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!draft) return;
		formError = null;
		if (!draft.title.trim()) return void (formError = "Give it a title.");
		if (draft.type === "iteration" && (!draft.startDate || !draft.endDate))
			return void (formError = "An iteration needs a start and an end date.");
		if (draft.startDate && draft.endDate && draft.endDate < draft.startDate)
			return void (formError = "The end date is before the start date.");
		saving = true;
		try {
			// A new concept carries its parent in the create; an edit keeps its
			// stored relations (omitted from the PUT) and swaps the milestone
			// parent server-side, so nothing is rebuilt from a cached graph.
			const isNew = !draft.id;
			const saved = await api.upsertConcept(vault.id, {
				...(draft.id ? { id: draft.id } : {}),
				title: draft.title.trim(),
				body: draft.body,
				type: draft.type,
				startDate: draft.startDate || null,
				endDate: draft.endDate || null,
				...(isNew && draft.parent ? { relations: { part_of: [draft.parent] } } : {}),
			});
			if (!isNew && draft.type === "iteration") {
				await api.setMembership(vault.id, saved.id, {
					type: "milestone",
					target: draft.parent || null,
				});
			}
			draft = null;
			concepts = (await api.listConcepts(vault.id)).concepts;
			if (!scope) setQuery({ scope: saved.id });
		} catch (err) {
			formError = err instanceof ApiError ? err.message : "Save failed.";
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>Burndown — {vault.name} — Brainz</title></svelte:head>

<div class="bd-page" data-hydrated={hydrated ? "true" : "false"}>
	<div class="toolbar">
		<div class="left">
			<h1>{vault.name} · Burndown</h1>
			{#each vaultTabLinks(vault.slug, "burndown") as link (link.href)}
				<a class="btn btn-ghost btn-sm" href={link.href}>{link.label}</a>
			{/each}
		</div>
		<div class="controls">
			<!-- A GET form: before hydration the "Show" button submits it natively;
			     once hydrated, changing the select navigates straight away. -->
			<form class="scope-pick" method="get" data-sveltekit-keepfocus data-sveltekit-noscroll>
				<label for="bd-scope" class="glabel">Scope</label>
				{#if unit === "points"}<input type="hidden" name="unit" value="points" />{/if}
				<select
					id="bd-scope"
					name="scope"
					class="select"
					value={scope}
					onchange={(e) => setQuery({ scope: e.currentTarget.value })}
				>
					<option value="">All tasks</option>
					{#each SCOPE_GROUPS as [type, label] (type)}
						{@const items = concepts.filter((c) => c.type === type)}
						{#if items.length > 0}
							<optgroup {label}>
								{#each items as c (c.id)}<option value={c.id}>{c.title}</option>{/each}
							</optgroup>
						{/if}
					{/each}
					{#if taskTags.length > 0}
						<optgroup label="Task tags">
							{#each taskTags as t (t)}<option value="tag:{t}">#{t}</option>{/each}
						</optgroup>
					{/if}
				</select>
				{#if !hydrated}<button type="submit" class="btn btn-sm">Show</button>{/if}
			</form>
			<div class="unit" role="group" aria-label="Unit">
				<a
					class="chip"
					class:on={unit === "tasks"}
					data-unit="tasks"
					aria-current={unit === "tasks" ? "true" : undefined}
					href={queryHref({ unit: "tasks" })}
					data-sveltekit-keepfocus
					data-sveltekit-noscroll>Tasks</a
				>
				<a
					class="chip"
					class:on={unit === "points"}
					data-unit="points"
					aria-current={unit === "points" ? "true" : undefined}
					href={queryHref({ unit: "points" })}
					data-sveltekit-keepfocus
					data-sveltekit-noscroll>Points</a
				>
			</div>
		</div>
	</div>

	{#if loadError}<p class="error-text banner" role="alert">{loadError}</p>{/if}

	{#if result}
		<section class="tiles" aria-label="Summary">
			<div class="tile">
				<span class="tile-label">Remaining</span>
				<span class="tile-value">{result.totals.open}</span>
				<span class="tile-sub">{unitLabel} of {result.totals.scope}</span>
			</div>
			<div class="tile">
				<span class="tile-label">Done</span>
				<span class="tile-value">{result.totals.done}</span>
				<span class="tile-sub">{result.totals.taken} in progress</span>
			</div>
			<div class="tile">
				<span class="tile-label">Velocity</span>
				<span class="tile-value">{result.velocity?.average ?? "—"}</span>
				<span class="tile-sub">{unitLabel} / {result.velocity?.by === "iteration" ? "iteration" : "week"}</span>
			</div>
			<div class="tile">
				<span class="tile-label">Projected</span>
				<span class="tile-value">{shortDay(result.projection?.likely)}</span>
				<span class="tile-sub">
					{#if result.projection?.likely && result.projection.optimistic !== result.projection.pessimistic}
						range {shortDay(result.projection.optimistic)} – {shortDay(result.projection.pessimistic)}
					{:else if result.projection?.reason}
						{result.projection.reason}
					{/if}
					{#if result.projection?.onTrack === true}<span class="track ok">✓ on track</span>{/if}
					{#if result.projection?.onTrack === false}<span class="track late">⚠ past {result.scope.endDate}</span>{/if}
				</span>
			</div>
		</section>
		{#if unit === "points" && result.totals.unestimated > 0}
			<p class="muted note">{result.totals.unestimated} task{result.totals.unestimated === 1 ? "" : "s"} in scope have no estimate and count as 0.</p>
		{/if}

		<section class="card">
			<h2>
				{result.scope.title}
				{#if result.scope.startDate || result.scope.endDate}
					<span class="muted dates">{result.scope.startDate ?? "…"} → {result.scope.endDate ?? "…"}</span>
				{/if}
			</h2>
			<BurndownChart {result} />
		</section>

		<div class="two-col">
			<section class="card">
				<h2>Velocity <span class="muted dates">per {result.velocity?.by ?? "week"}</span></h2>
				{#if result.velocity && result.velocity.periods.length > 0}
					<ul class="bars">
						{#each result.velocity.periods as p (velocityKey(p))}
							<li title="{p.label}: {p.done} {unitLabel}{p.complete ? '' : ' (in progress)'}">
								<span class="bar-label">{p.label}</span>
								<span class="bar-track">
									<span class="bar" class:partial={!p.complete} style="width:{(Math.max(p.done, 0) / velocityMax) * 100}%"></span>
								</span>
								<span class="bar-value">{p.done}{p.complete ? "" : "…"}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted">No periods in this window yet.</p>
				{/if}
			</section>

			<section class="card">
				<h2>Stale claims</h2>
				{#if result.stale && result.stale.length > 0}
					<table class="tbl">
						<thead><tr><th scope="col">Task</th><th scope="col">Held by</th><th scope="col">For</th></tr></thead>
						<tbody>
							{#each result.stale as s (s.id)}
								<tr>
									<td><a href="/v/{vault.slug}?focus={encodeURIComponent(s.id)}">{s.title}</a></td>
									<td>{s.takenBy ?? "unassigned"}</td>
									<td class="num">{fmtHours(s.ageHours)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="muted">No claims held longer than a day.</p>
				{/if}
			</section>
		</div>

		<section class="card">
			<h2>Agents</h2>
			{#if result.agents && result.agents.length > 0}
				<table class="tbl">
					<thead>
						<tr>
							<th scope="col">Agent</th><th scope="col" class="num">Holding</th><th scope="col" class="num">Done</th>
							<th scope="col" class="num">Median lead</th><th scope="col" class="num">Median cycle</th><th scope="col" class="num">Stale</th>
						</tr>
					</thead>
					<tbody>
						{#each result.agents as a (a.agent)}
							<tr>
								<td>{a.agent}</td>
								<td class="num">{a.held}</td>
								<td class="num">{a.done}</td>
								<td class="num">{fmtHours(a.medianLeadHours)}</td>
								<td class="num">{fmtHours(a.medianCycleHours)}</td>
								<td class="num">{a.stale}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="muted">Nobody has taken or finished a task in this window.</p>
			{/if}
		</section>
	{/if}

	<section class="card">
		<div class="section-head">
			<h2>Iterations &amp; milestones</h2>
			{#if canEdit && !draft}
				<div class="actions">
					<button type="button" class="btn btn-sm" data-testid="new-iteration" disabled={!hydrated} onclick={() => (draft = emptyDraft("iteration"))}>New iteration</button>
					<button type="button" class="btn btn-sm" data-testid="new-milestone" disabled={!hydrated} onclick={() => (draft = emptyDraft("milestone"))}>New milestone</button>
				</div>
			{/if}
		</div>

		{#if draft}
			<form class="draft" onsubmit={save}>
				<div class="grid">
					<div class="field">
						<label for="bd-title">Title</label>
						<input id="bd-title" class="input" bind:value={draft.title} required />
					</div>
					<div class="field">
						<label for="bd-type">Type</label>
						<select id="bd-type" class="select" bind:value={draft.type} disabled={!!draft.id}>
							<option value="iteration">Iteration</option>
							<option value="milestone">Milestone</option>
						</select>
					</div>
					<div class="field">
						<label for="bd-start">Start</label>
						<input id="bd-start" class="input" type="date" bind:value={draft.startDate} />
					</div>
					<div class="field">
						<label for="bd-end">{draft.type === "milestone" ? "Target date" : "End"}</label>
						<input id="bd-end" class="input" type="date" bind:value={draft.endDate} />
					</div>
					{#if draft.type === "iteration" && milestones.length > 0}
						<div class="field">
							<label for="bd-parent">Milestone</label>
							<select id="bd-parent" class="select" bind:value={draft.parent}>
								<option value="">None</option>
								{#each milestones as m (m.id)}<option value={m.id}>{m.title}</option>{/each}
							</select>
						</div>
					{/if}
				</div>
				<div class="field">
					<label for="bd-body">Notes</label>
					<textarea id="bd-body" class="textarea short" bind:value={draft.body}></textarea>
				</div>
				{#if formError}<p class="error-text" role="alert">{formError}</p>{/if}
				<div class="actions">
					<button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => (draft = null)}>Cancel</button>
				</div>
			</form>
		{/if}

		{#if containers.length === 0}
			<p class="muted">No iterations or milestones yet. Tasks join one through a <code>part_of</code> edge (the board's iteration picker sets it).</p>
		{:else}
			<ul class="containers">
				{#each containers as c (c.id)}
					<li>
						<span class="kind kind-{c.type}">{c.type}</span>
						<a class="linkish" href={queryHref({ scope: c.id })} data-sveltekit-keepfocus data-sveltekit-noscroll>{c.title}</a>
						<span class="muted dates">{c.startDate ?? "…"} → {c.endDate ?? "…"}</span>
						{#if canEdit}
							<button type="button" class="btn btn-ghost btn-sm" disabled={!hydrated} onclick={() => edit(c)}>Edit</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.bd-page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 20px 16px 48px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.left,
	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	h1 {
		font-size: 18px;
		margin: 0 8px 0 0;
	}
	h2 {
		font-size: 14px;
		margin: 0 0 12px;
	}
	.scope-pick {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.scope-pick .select {
		min-width: 220px;
		padding-top: 6px;
		padding-bottom: 6px;
	}
	.glabel {
		font-size: 12px;
		color: var(--text-dim);
	}
	.chip {
		font-size: 12.5px;
		padding: 5px 10px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-dim);
		cursor: pointer;
	}
	a.chip {
		text-decoration: none;
		display: inline-block;
	}
	.chip.on {
		color: var(--text);
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.banner {
		margin: 0;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}
	.tile {
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tile-label {
		font-size: 12px;
		color: var(--text-dim);
	}
	.tile-value {
		font-size: 26px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.tile-sub {
		font-size: 12px;
		color: var(--text-dim);
	}
	.track {
		margin-left: 6px;
	}
	.track.ok {
		color: var(--text);
	}
	.track.late {
		color: var(--danger, #f87171);
	}
	.note {
		margin: -4px 0 0;
		font-size: 12px;
	}
	.dates {
		font-weight: 400;
		font-size: 12px;
		margin-left: 8px;
	}
	.two-col {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 16px;
	}
	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.bars li {
		display: grid;
		grid-template-columns: 110px 1fr 40px;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.bar-label {
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bar-track {
		height: 14px;
	}
	.bar {
		display: block;
		height: 14px;
		max-height: 24px;
		background: #3987e5;
		border-radius: 0 4px 4px 0;
		min-width: 2px;
	}
	.bar.partial {
		background: repeating-linear-gradient(45deg, #3987e5 0 4px, rgb(57 135 229 / 0.45) 4px 8px);
	}
	.bar-value {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.tbl {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.tbl th {
		text-align: left;
		font-weight: 500;
		color: var(--text-dim);
		font-size: 12px;
		padding: 4px 8px;
		border-bottom: 1px solid var(--border);
	}
	.tbl td {
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.section-head h2 {
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	.draft {
		margin: 14px 0;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-deep);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0 12px;
	}
	.textarea.short {
		min-height: 70px;
	}
	.containers {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
	}
	.containers li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.kind {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		color: var(--text-dim);
	}
	.kind-iteration {
		border-color: #818cf8;
	}
	.kind-milestone {
		border-color: #e879f9;
	}
	.linkish {
		background: none;
		border: 0;
		text-decoration: none;
		color: var(--accent);
		cursor: pointer;
		padding: 0;
		font: inherit;
	}
	.linkish:hover {
		text-decoration: underline;
	}
	@media (max-width: 560px) {
		.scope-pick .select {
			min-width: 0;
			width: 100%;
		}
		.bars li {
			grid-template-columns: 80px 1fr 32px;
		}
	}
</style>
