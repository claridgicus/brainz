<script lang="ts">
	import type { GraphPayload } from "@brainz/contracts";
	import Graph from "$lib/components/Graph.svelte";
	import { ALL_TYPES } from "$lib/graph-data";
	import { onMount } from "svelte";

	let {
		graph,
		mode,
		bundling = true,
		budget,
		flatMax,
		focus = null,
		panel = false,
	}: {
		graph: GraphPayload;
		mode: "auto" | "all";
		bundling?: boolean;
		budget?: number;
		flatMax?: number;
		/** Like the workspace's ?focus=: Graph's initialFocusId, then select it on mount. */
		focus?: string | null;
		/** Open a 380px side panel while something is selected (the workspace's concept panel). */
		panel?: boolean;
	} = $props();
	let selectedId = $state<string | null>(null);
	// The workspace selects the ?focus= concept in onMount, after the Graph's
	// own initial effects; the panel that opens then shrinks the canvas.
	onMount(() => {
		if (focus) selectedId = focus;
	});
	let graphRef = $state<ReturnType<typeof Graph>>();
	// Exposed for the drivers: select/pan like the search box does.
	(window as unknown as { __bench: unknown }).__bench = {
		graph: () => graph,
		select: (id: string) => {
			selectedId = id;
			graphRef?.panTo(id);
		},
		selected: () => selectedId,
	};
</script>

<div style="height:100%;display:flex">
	<div style="flex:1;min-width:0;height:100%">
	<Graph
		bind:this={graphRef}
		{graph}
		enabledTypes={mode === "all" ? [...ALL_TYPES] : ["domain", "feature", "spec", "story", "task"]}
		vaultId="bench"
		filterMode={mode === "all" ? "manual" : "auto"}
		{selectedId}
		initialFocusId={focus}
		{bundling}
		nodeBudget={budget}
		flatMaxNodes={flatMax}
		onselect={(id) => (selectedId = id)}
	/>
	</div>
	{#if panel && selectedId}
		<aside class="bench-panel" style="width:380px;flex:none">{selectedId}</aside>
	{/if}
</div>
