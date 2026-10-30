<script lang="ts">
	import type { GraphPayload } from "@brainz/contracts";
	import Graph from "$lib/components/Graph.svelte";
	import { ALL_TYPES } from "$lib/graph-data";

	let {
		graph,
		mode,
		bundling = true,
		budget,
	}: { graph: GraphPayload; mode: "auto" | "all"; bundling?: boolean; budget?: number } = $props();
	let selectedId = $state<string | null>(null);
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

<div style="height:100%">
	<Graph
		bind:this={graphRef}
		{graph}
		enabledTypes={mode === "all" ? [...ALL_TYPES] : ["domain", "feature", "spec", "story", "task"]}
		vaultId="bench"
		filterMode={mode === "all" ? "manual" : "auto"}
		{selectedId}
		{bundling}
		nodeBudget={budget}
		onselect={(id) => (selectedId = id)}
	/>
</div>
