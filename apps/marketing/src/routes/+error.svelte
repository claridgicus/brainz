<script lang="ts">
	import { page } from "$app/state";
</script>

<svelte:head>
	<title>{page.status} — Brainz</title>
</svelte:head>

<div class="container wrap">
	<h1>{page.status}</h1>
	<p>{page.error?.message ?? "Something went wrong."}</p>
	<a class="btn" href="/">Back to the homepage</a>
</div>

<style>
	.wrap {
		padding: 120px 24px;
		text-align: center;
	}
	h1 {
		font-size: 64px;
		color: var(--accent);
	}
	p {
		color: var(--text-dim);
		margin-bottom: 28px;
	}
</style>
