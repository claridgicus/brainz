<script lang="ts">
	// Debounced search box with a results dropdown (keyboard navigable).
	import type { SearchHit } from "$lib/api";
	import { TYPE_COLORS } from "$lib/graph-data";

	let {
		search,
		onpick,
	}: {
		search: (q: string) => Promise<SearchHit[]>;
		onpick: (id: string) => void;
	} = $props();

	let input: HTMLInputElement;
	let query = $state("");
	let hits = $state<SearchHit[]>([]);
	let open = $state(false);
	let activeIdx = $state(-1);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function close() {
		open = false;
		hits = [];
		activeIdx = -1;
	}

	function pick(idx: number) {
		const hit = hits[idx];
		if (!hit) return;
		close();
		input.blur();
		onpick(hit.id);
	}

	function oninput() {
		if (timer) clearTimeout(timer);
		const q = query.trim();
		if (!q) {
			close();
			return;
		}
		timer = setTimeout(async () => {
			try {
				hits = await search(q);
				activeIdx = hits.length > 0 ? 0 : -1;
				open = true;
			} catch {
				close();
			}
		}, 140);
	}

	function onkeydown(ev: KeyboardEvent) {
		if (!open) return;
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			const delta = ev.key === "ArrowDown" ? 1 : -1;
			activeIdx = (activeIdx + delta + hits.length) % Math.max(1, hits.length);
		} else if (ev.key === "Enter") {
			ev.preventDefault();
			pick(activeIdx);
		} else if (ev.key === "Escape") {
			close();
			input.blur();
		}
	}

	function onGlobalKey(ev: KeyboardEvent) {
		if (ev.key === "/" && document.activeElement !== input) {
			const el = document.activeElement;
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
			ev.preventDefault();
			input.focus();
			input.select();
		}
	}
</script>

<svelte:window onkeydown={onGlobalKey} />

<div class="search">
	<input
		bind:this={input}
		bind:value={query}
		{oninput}
		{onkeydown}
		onblur={() => setTimeout(close, 150)}
		class="input"
		type="search"
		placeholder="Search concepts…  ( / )"
		aria-label="Search concepts"
	/>
	{#if open}
		<div class="results" role="listbox">
			{#if hits.length === 0}
				<div class="empty muted">No results</div>
			{:else}
				{#each hits as h, i (h.id)}
					<button
						type="button"
						class="hit"
						class:active={i === activeIdx}
						role="option"
						aria-selected={i === activeIdx}
						onpointerdown={(ev) => {
							ev.preventDefault();
							pick(i);
						}}
					>
						<span class="hit-title">
							<span class="dot" style="background:{TYPE_COLORS[h.type] ?? '#6b7280'}"></span>
							{h.title}
							<span class="hit-type">{h.type}</span>
						</span>
						<span class="hit-snippet">{h.snippet}</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.search {
		position: relative;
		width: 100%;
		max-width: 340px;
	}
	.results {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		z-index: 40;
		background: var(--bg-overlay);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
		overflow: hidden;
		max-height: 60vh;
		overflow-y: auto;
	}
	.empty {
		padding: 12px 14px;
		font-size: 13px;
	}
	.hit {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		border-bottom: 1px solid var(--border);
		padding: 9px 12px;
		cursor: pointer;
		color: var(--text);
		font: inherit;
	}
	.hit:last-child {
		border-bottom: none;
	}
	.hit.active,
	.hit:hover {
		background: var(--accent-soft);
	}
	.hit-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13.5px;
		font-weight: 600;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}
	.hit-type {
		color: var(--text-dim);
		font-size: 11px;
		font-weight: 400;
	}
	.hit-snippet {
		display: block;
		color: var(--text-dim);
		font-size: 12px;
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
