<script lang="ts">
	import { SITE_URL } from "$lib/links";

	/**
	 * Per-page head tags, rendered exactly once by every prerendered page:
	 * title/description, canonical, Open Graph, Twitter card, and schema.org
	 * JSON-LD. check-build.mjs asserts the output on every page in build/.
	 */
	interface Props {
		title: string;
		description: string;
		/** Site-relative canonical path, e.g. "/" or "/docs". */
		path: string;
		type?: "website" | "article";
		/** Extra schema.org entities appended to the page's JSON-LD @graph. */
		schema?: Record<string, unknown>[];
	}

	let { title, description, path, type = "website", schema = [] }: Props = $props();

	const url = $derived(path === "/" ? SITE_URL : `${SITE_URL}${path}`);
	const image = `${SITE_URL}/og.png`;
	const imageAlt = "Brainz — give your agent fleet a shared brain";

	// `<` escaped so serialized JSON can never close the script tag early.
	const jsonLd = $derived(
		JSON.stringify({
			"@context": "https://schema.org",
			"@graph": [
				{
					"@type": "Organization",
					"@id": `${SITE_URL}/#organization`,
					name: "Brownmatter",
					url: SITE_URL,
				},
				{
					"@type": "WebSite",
					"@id": `${SITE_URL}/#website`,
					name: "Brownmatter",
					url: SITE_URL,
					publisher: { "@id": `${SITE_URL}/#organization` },
				},
				...schema,
			],
		}).replaceAll("<", "\\u003c"),
	);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:type" content={type} />
	<meta property="og:site_name" content="Brownmatter" />
	<meta property="og:locale" content="en_US" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={image} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={imageAlt} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />
	<meta name="twitter:image:alt" content={imageAlt} />
	{@html `<script type="application/ld+json">${jsonLd}<` + `/script>`}
</svelte:head>
