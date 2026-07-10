<script lang="ts">
	import "../app.css";
	import Nav from "$lib/components/Nav.svelte";
	import Footer from "$lib/components/Footer.svelte";

	let { children } = $props();
</script>

<Nav />
<main>
	{@render children()}
</main>
<Footer />

<style>
	main {
		min-height: 60vh;
	}
</style>
