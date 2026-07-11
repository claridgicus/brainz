<script lang="ts">
	let { size = 21 }: { size?: number } = $props();
</script>

<!--
	The Brainz product mark: a zombie half-eaten brain. Flat pink brain with a
	central fissure and fold squiggles, a scalloped bite out of the right side,
	and two sickly-green ooze crumbs. Keep in sync with the favicon data-URI in
	src/app.html and the OG card in apps/marketing/assets/og.html.
	(The 💩 pile-of-poo emoji remains Brownmatter's *company* mark — see
	apps/marketing — it is no longer the Brainz product mark.)
-->
<svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
	<path
		fill="#F58EA8"
		d="M32 20 A13 13 0 0 1 54 13 A13 13 0 0 1 76 20 A12 12 0 0 1 91 33 A10.2 10.2 0 0 0 76 46 A6.1 6.1 0 0 0 76 58 A7.7 7.7 0 0 0 88 67 A14 14 0 0 1 68 86 A13 13 0 0 1 44 88 A13 13 0 0 1 22 80 A13 13 0 0 1 10 60 A12 12 0 0 1 12 38 A15 15 0 0 1 32 20 Z"
	/>
	<g fill="none" stroke="#C24D6F" stroke-width="7" stroke-linecap="round">
		<path d="M55 14 C50 24 57 32 49 44" />
		<path d="M22 42 C33 35 31 52 42 47" />
		<path d="M33 69 C44 62 42 77 55 71" />
	</g>
	<circle fill="#A4C93F" cx="92" cy="48" r="3.4" />
	<circle fill="#A4C93F" cx="96" cy="59" r="2.4" />
</svg>

<style>
	svg {
		display: block;
		flex: none;
	}
</style>
