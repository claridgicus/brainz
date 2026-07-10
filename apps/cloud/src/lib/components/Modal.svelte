<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		onclose,
		children,
	}: { title: string; onclose: () => void; children: Snippet } = $props();

	function onkeydown(ev: KeyboardEvent) {
		if (ev.key === "Escape") onclose();
	}
</script>

<svelte:window {onkeydown} />

<div
	class="backdrop"
	role="presentation"
	onclick={(ev) => {
		if (ev.target === ev.currentTarget) onclose();
	}}
>
	<div class="modal card" role="dialog" aria-modal="true" aria-label={title}>
		<div class="head">
			<h3>{title}</h3>
			<button type="button" class="btn btn-ghost btn-sm" onclick={onclose} aria-label="Close">✕</button>
		</div>
		{@render children()}
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgb(6 8 12 / 0.72);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		padding: 20px;
	}
	.modal {
		width: 100%;
		max-width: 520px;
		max-height: 85vh;
		overflow-y: auto;
		box-shadow: 0 18px 50px rgb(0 0 0 / 0.5);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.head h3 {
		margin: 0;
		font-size: 16px;
	}
</style>
