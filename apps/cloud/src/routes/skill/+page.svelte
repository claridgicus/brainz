<script lang="ts">
	import Wordmark from "$lib/components/Wordmark.svelte";

	let { data }: { data: { markdown: string | null } } = $props();

	let copied = $state(false);
	let copyFailed = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function copy() {
		if (!data.markdown) return;
		copyFailed = false;
		try {
			await navigator.clipboard.writeText(data.markdown);
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1600);
		} catch {
			// clipboard unavailable (http, permissions) — the text below stays selectable
			copyFailed = true;
		}
	}
</script>

<svelte:head>
	<title>Set up Brainz with your agent — Brainz</title>
	<meta
		name="description"
		content="A copy-paste prompt that lets any MCP-capable agent sign up, connect, and onboard Brainz for you."
	/>
</svelte:head>

<main>
	<a href="/" class="home" aria-label="Brainz home"><Wordmark /></a>

	<div class="card skill-card">
		<h1>Set up Brainz with your agent</h1>
		<p class="intro muted">
			Copy this prompt into Claude Code, Cursor, or any MCP-capable agent — it will sign up,
			connect, and onboard Brainz for you. You approve the workspace from your inbox; the prompt
			handles the rest.
		</p>

		{#if data.markdown}
			<div class="actions">
				<button type="button" class="btn btn-primary" onclick={copy}>
					{copied ? "Copied ✓" : "Copy prompt"}
				</button>
				<a href="/skill.md" class="raw muted">or fetch the raw file at /skill.md</a>
			</div>
			{#if copyFailed}
				<p class="error-text" role="alert">
					Couldn't access the clipboard — select and copy the text below instead.
				</p>
			{/if}
			<pre class="prompt">{data.markdown}</pre>
		{:else}
			<div class="coming-soon">
				<p class="muted">
					The setup prompt isn't published yet — check back soon. In the meantime you can
					<a href="/signup">sign up yourself</a> or <a href="/login">sign in</a>.
				</p>
			</div>
		{/if}
	</div>
</main>

<style>
	main {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 22px;
		padding: 48px 24px;
	}
	.home:hover {
		text-decoration: none;
	}
	.skill-card {
		width: 100%;
		max-width: 720px;
		padding: 26px;
	}
	h1 {
		font-size: 20px;
		margin-bottom: 10px;
	}
	.intro {
		font-size: 13.5px;
		margin: 0 0 18px;
		max-width: 56ch;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 14px;
		flex-wrap: wrap;
	}
	.raw {
		font-size: 12.5px;
	}
	.prompt {
		margin: 0;
		max-height: 60vh;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.coming-soon {
		padding: 22px;
		background: var(--bg-deep);
		border: 1px dashed var(--border-strong);
		border-radius: 8px;
		text-align: center;
	}
	.coming-soon p {
		margin: 0;
		font-size: 13.5px;
	}
</style>
