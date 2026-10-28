<script lang="ts">
	import Seo from "$lib/components/Seo.svelte";
	import LegalPage from "$lib/components/LegalPage.svelte";
	import { SUPPORT_EMAIL } from "$lib/links";

	// Approved by James 2026-10-28. Every statement here is drawn from what
	// apps/cloud actually stores and sends — change the code, change this page.
	const title = "Privacy Policy — Brainz";
	const description =
		"What Brainz stores, who processes it (Cloudflare, GitHub, your own LLM provider), how long it is kept and how to delete it.";
</script>

<Seo {title} {description} path="/privacy" type="article" />

<LegalPage kicker="Legal" heading="Privacy Policy" updated="28 October 2026">
	<p>
		Brainz is a hosted knowledge graph for AI agents, run by Plutocracy Pty Ltd ("Brownmatter",
		"we"). This policy covers <code>brainz.brownmatter.ai</code> (the dashboard, REST API and the
		remote MCP server at <code>/mcp</code>) and this site, <code>brownmatter.ai</code>. The
		open-source Brainz CLI and local MCP server run on your own machine and send us nothing.
	</p>

	<h2 id="what-we-store">What we store</h2>
	<ul>
		<li>
			<strong>Account:</strong> your email address and display name. If you sign in with GitHub,
			also your GitHub account id, name, profile image URL and the OAuth tokens GitHub issues for
			sign-in.
		</li>
		<li>
			<strong>Sign-in sessions:</strong> a session token (kept in a cookie), plus the IP address and
			browser user agent of the session.
		</li>
		<li>
			<strong>Vault content:</strong> everything you or your agents write to a vault — concepts,
			tasks, links, tags, code-area paths — and the derived search index and text embeddings.
			Dreaming also stores a Dream Diary and before-images of the concepts it changed, so a dream can
			be reverted.
		</li>
		<li>
			<strong>API keys:</strong> a SHA-256 hash of each key, its first characters (so you can tell
			keys apart), its name and when it was last used. We never store the full key.
		</li>
		<li>
			<strong>Team and claim records:</strong> invite emails and roles, and pending claim requests
			(the email an agent asked to attach a workspace to). Their one-time tokens are stored hashed.
		</li>
		<li>
			<strong>Your own LLM key for dreaming,</strong> if you add one: encrypted at rest with AES-GCM,
			plus the provider, a short hint of the key, and the base URL and model you chose. A daily ledger
			of dreaming cost per account.
		</li>
		<li>
			<strong>Abuse prevention:</strong> the email address and IP address of each sign-in link
			request, and the IP address of each agent signup and each public-vault read, used for rate
			limits.
		</li>
		<li>
			<strong>Request logs:</strong> Cloudflare Workers Logs record requests and errors for operating
			and debugging the service.
		</li>
	</ul>
	<p>
		We do not use analytics, advertising or tracking cookies. The only cookie is the sign-in session
		cookie on <code>brainz.brownmatter.ai</code>. <code>brownmatter.ai</code> sets no cookies and
		loads no third-party scripts.
	</p>

	<h2 id="how-we-use-it">How we use it</h2>
	<p>
		To run the service: store and search your vaults, send sign-in, invite and claim emails, run
		dreaming, prevent abuse, and fix problems. We do not sell your data, use it for advertising, or
		use your vault content to train models.
	</p>

	<h2 id="processors">Who processes it</h2>
	<ul>
		<li>
			<strong>Cloudflare</strong> hosts the whole service (Workers, D1, Durable Objects), sends our
			email (Cloudflare Email Service, from <code>no-reply@brownmatter.ai</code>) and runs Workers AI,
			which computes embeddings of your concept text and, for dreaming without your own key, runs the
			dreaming model over excerpts of your vault content. Data is stored on Cloudflare's network; we
			do not currently pin it to a region.
		</li>
		<li><strong>GitHub</strong>, only if you choose "Continue with GitHub".</li>
		<li>
			<strong>Your LLM provider:</strong> if you add your own key, dreaming sends excerpts of your
			vault content to the provider you chose (Anthropic, or the OpenAI-compatible endpoint you
			entered) under your own account with that provider.
		</li>
		<li>
			<strong>Your agents and teammates:</strong> anyone holding one of your vault's API keys, and
			members you invite, can read and change that vault. If a vault owner turns on public read
			access, anyone with the link can read it.
		</li>
	</ul>

	<h2 id="retention">How long we keep it</h2>
	<ul>
		<li>Account and vault content: until you delete it.</li>
		<li>Deleting a vault deletes its stored content, API keys and memberships straight away.</li>
		<li>Your own LLM key: until you remove it in settings, which deletes it straight away.</li>
		<li>
			Dream Diary: the newest 50 entries per vault; older entries and their before-images are
			deleted.
		</li>
		<li>
			One-time tokens expire: sign-in links in about 15 minutes, claim links in 24 hours, invites in
			14 days.
		</li>
		<li>
			Workspaces an agent creates without a human stop working after 7 days unless claimed. We do not
			yet delete them automatically; email us to have one removed.
		</li>
		<li>
			Rate-limit records and request logs: we do not yet delete rate-limit records automatically.
			Request logs are kept for Cloudflare's Workers Logs retention period.
		</li>
		<li>Deleted data can remain in Cloudflare's point-in-time recovery for up to 30 days.</li>
	</ul>

	<h2 id="your-choices">Your choices</h2>
	<p>
		You can read and export your vaults through the dashboard, REST API or MCP tools, change them at
		any time, and delete any vault you own from its settings. There is no self-serve account deletion
		yet: email <a href="mailto:{SUPPORT_EMAIL}">{SUPPORT_EMAIL}</a> from your account's address and
		we will delete your account and every vault you own within 30 days. You can also ask us what we
		hold about you, or to correct it.
	</p>

	<h2 id="security">Security</h2>
	<p>
		All traffic is over HTTPS. API keys and one-time tokens are stored hashed, and LLM keys
		encrypted. We hold no security certifications. Don't put secrets (passwords, private keys) in a
		vault.
	</p>

	<h2 id="children">Children</h2>
	<p>Brainz is not meant for children under 16.</p>

	<h2 id="changes">Changes</h2>
	<p>
		We will update this page when what we collect or who processes it changes, and change the date
		above.
	</p>

	<h2 id="contact">Contact</h2>
	<p>Plutocracy Pty Ltd — <a href="mailto:{SUPPORT_EMAIL}">{SUPPORT_EMAIL}</a></p>
</LegalPage>
