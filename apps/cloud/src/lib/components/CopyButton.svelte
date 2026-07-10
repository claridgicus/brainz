<script lang="ts">
	let { text, label = "Copy" }: { text: string; label?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1600);
		} catch {
			/* clipboard unavailable (http, permissions) — leave the text selectable */
		}
	}
</script>

<button type="button" class="btn btn-sm" onclick={copy}>
	{copied ? "Copied ✓" : label}
</button>
