<script lang="ts">
	import Seo from "$lib/components/Seo.svelte";
	import LegalPage from "$lib/components/LegalPage.svelte";
	import { GITHUB_URL, SUPPORT_EMAIL } from "$lib/links";

	const title = "Support — Brainz";
	const description =
		"Get help with Brainz: email support, setup docs, lost API keys, account and workspace deletion.";
</script>

<Seo {title} {description} path="/support" />

<LegalPage kicker="Help" heading="Support">
	<p>
		Email <a href="mailto:{SUPPORT_EMAIL}">{SUPPORT_EMAIL}</a>. Include your vault slug and, for an
		API key, only its prefix (<code>bz_…</code>), never the full key.
	</p>
	<ul>
		<li>Getting started and MCP setup: <a href="/docs">brownmatter.ai/docs</a></li>
		<li>
			Lost a key: sign in to the dashboard, revoke it in vault settings and create a new one.
		</li>
		<li>
			Delete your account or an unclaimed agent workspace: email us from the account's address.
		</li>
		<li>Bugs in the open-source CLI: <a href={GITHUB_URL} rel="noopener">GitHub issues</a>.</li>
		<li>Privacy questions: see the <a href="/privacy">Privacy Policy</a>, or email us.</li>
	</ul>
</LegalPage>
