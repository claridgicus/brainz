<script lang="ts">
	import { enhance } from "$app/forms";

	let { data, form } = $props();

	const fmt = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<svelte:head><title>Support drafts — Brainz</title></svelte:head>

<main class="page">
	<h1>Support drafts</h1>
	<p class="muted intro">
		Replies the triage agent drafted for support@brownmatter.ai. Edit if needed, then send: the reply
		goes to the thread's sender, threaded, and is logged on the task.
	</p>

	{#if form?.sent}
		<p class="notice" role="status">
			Sent to {form.sent.to}{form.sent.delivered ? "" : " (dev: logged, not delivered)"}.
		</p>
	{/if}

	{#if data.drafts.length === 0}
		<div class="card empty"><p class="muted">No drafts waiting.</p></div>
	{:else}
		{#each data.drafts as d (d.taskId)}
			<form class="card draft" method="POST" action="?/send" use:enhance>
				<h2>{d.subject}</h2>
				<p class="meta muted">
					To <code>{d.to}</code> · drafted by {d.actor} · {fmt(d.at)} · task <code>{d.taskId}</code>
				</p>
				<input type="hidden" name="taskId" value={d.taskId} />
				<label class="sr-only" for="text-{d.taskId}">Reply text</label>
				<textarea id="text-{d.taskId}" name="text" rows="10">{d.text}</textarea>
				{#if form?.error && form.taskId === d.taskId}
					<p class="error" role="alert">{form.error}</p>
				{/if}
				<div class="row">
					<button class="btn btn-primary" type="submit">Send reply</button>
				</div>
			</form>
		{/each}
	{/if}
</main>

<style>
	.page {
		max-width: 860px;
		margin: 0 auto;
		padding: 36px 24px 60px;
	}
	h1 {
		font-size: 24px;
		margin-bottom: 8px;
	}
	.intro {
		margin: 0 0 22px;
	}
	.draft {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 16px;
	}
	.draft h2 {
		font-size: 16px;
		margin: 0;
	}
	.meta {
		font-size: 12.5px;
		margin: 0;
		overflow-wrap: anywhere;
	}
	textarea {
		width: 100%;
		font: inherit;
		resize: vertical;
	}
	.row {
		display: flex;
		justify-content: flex-end;
	}
	.notice {
		margin: 0 0 16px;
	}
	.error {
		color: var(--danger, #f87171);
		margin: 0;
	}
	.empty {
		text-align: center;
		padding: 28px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
