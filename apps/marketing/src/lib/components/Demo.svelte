<script lang="ts">
	/**
	 * A recorded demo of Brainz Cloud, from `static/demos/`: a clip
	 * `npm run demos:record` rendered (see `demos/` at the repository root).
	 * `cut` picks the render: `backdrop` is the marketing cut (the app as a
	 * window on a soft canvas), `bleed` the docs cut (edge to edge). The clip
	 * plays muted on a loop while it is on screen, as a moving screenshot does,
	 * stays on its poster for anyone who prefers reduced motion, and shows the
	 * poster before it loads.
	 */
	let {
		id,
		title,
		cut = "backdrop",
	}: { id: string; title: string; cut?: "backdrop" | "bleed" } = $props();

	const name = $derived(`${id}${cut === "bleed" ? "-bleed" : ""}`);

	/** Play while visible; never for reduced motion. */
	function autoplay(video: HTMLVideoElement) {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) void video.play().catch(() => undefined);
				else video.pause();
			},
			{ threshold: 0.4 },
		);
		observer.observe(video);
		return { destroy: () => observer.disconnect() };
	}
</script>

<figure class="demo" class:bleed={cut === "bleed"}>
	<video
		src="/demos/{name}.mp4"
		poster="/demos/{name}.webp"
		muted
		loop
		playsinline
		preload="none"
		aria-label={title}
		use:autoplay
	></video>
	<figcaption>{title}</figcaption>
</figure>

<style>
	.demo {
		margin: 1.5rem 0 2rem;
	}

	video {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 12px;
		background: var(--ink);
	}

	.bleed video {
		border: 1px solid var(--border);
	}

	figcaption {
		margin-top: 0.5rem;
		font-size: 0.9rem;
		color: var(--text-dim);
	}
</style>
