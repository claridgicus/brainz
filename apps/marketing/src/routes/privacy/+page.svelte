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

<LegalPage kicker="Legal" heading="Privacy Policy" updated="30 October 2026">
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
			<strong>Connected apps (OAuth):</strong> when you connect an app such as Claude or
			ChatGPT to <code>/mcp</code>, we store a connection record (your account; on the consent
			screen, the vault or vaults you pick, or all your vaults, including ones you create or
			join later if you choose that option; the app's client id; and when you connected), the
			short-lived authorization code used to set it up, and the connection's access and
			refresh tokens. Codes and tokens are stored only as SHA-256 hashes. Apps that register
			with us automatically store the name they give themselves, their redirect addresses,
			their sign-in method (and a hash of their secret, if they have one) and when the app was
			registered and last used. Apps that identify themselves by a URL, as Claude does, are
			looked up at that URL when you connect and not stored.
		</li>
		<li>
			<strong>Tool calls from connected apps:</strong> an app calling a Brainz tool sends us only that
			tool's arguments (a search query, a concept to save). No Brainz tool asks for or receives your
			chat history with the app.
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
			limits. When an app registers for OAuth we record the IP address (for IPv6, its /48 network)
			and the time, for the same purpose.
		</li>
		<li>
			<strong>Support email:</strong> when you email support@brownmatter.ai we store your message
			(sender, subject, text and attachments), our replies, and the results of the sender checks
			(SPF, DKIM, DMARC) your mail arrived with. An AI agent reads and sorts support email and drafts
			replies. A person reviews anything about privacy, legal matters or account deletion, and every
			reply except routine how-to answers taken from our docs.
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
			email (Cloudflare Email Service, from <code>no-reply@brownmatter.ai</code>), receives and stores
			support email (Email Routing, D1, R2) and runs Workers AI,
			which computes embeddings of your concept text and, for dreaming without your own key, runs the
			dreaming model over excerpts of your vault content. Data is stored on Cloudflare's network; we
			do not currently pin it to a region.
		</li>
		<li><strong>GitHub</strong>, only if you choose "Continue with GitHub".</li>
		<li>
			<strong>Anthropic:</strong> our support agent runs on Anthropic's Claude, so the content of
			support emails you send us is processed by Anthropic to sort them and draft replies.
		</li>
		<li>
			<strong>Your LLM provider:</strong> if you add your own key, dreaming sends excerpts of your
			vault content to the provider you chose (Anthropic, or the OpenAI-compatible endpoint you
			entered) under your own account with that provider.
		</li>
		<li>
			<strong>Apps you connect:</strong> an app you connect with OAuth (such as Claude or
			ChatGPT) receives the results of the tools it calls on the vault or vaults you pick, or
			all your vaults, including ones you create or join later if you choose that option, and
			handles them under its own privacy policy. It can read those vaults, and change any of
			them where you are the owner or an editor.
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
		<li>
			Connected apps: authorization codes expire after 5 minutes, access tokens after 1 hour
			and refresh tokens after 30 days without use. A connection stops working when the app
			revokes it, when a refresh token is reused, when you lose access to a vault it covers,
			or when the vault or your account is deleted, which also deletes its connection records,
			codes and tokens. Once a day we delete authorization codes a day after they expire,
			expired tokens, and the tokens of a revoked connection. A revoked connection's record is
			deleted 30 days after it was revoked, and a connection whose last refresh token has expired
			is deleted at the next daily run. Apps that registered automatically are deleted after 30
			days if they have no connection and have not been used on the consent screen. OAuth
			registration rate-limit records are deleted after an hour.
		</li>
		<li>
			Support email: kept so we can follow up on your request. We do not yet delete it
			automatically; email us to have your support messages deleted.
		</li>
		<li>Deleted data can remain in Cloudflare's point-in-time recovery for up to 30 days.</li>
	</ul>

	<h2 id="your-choices">Your choices</h2>
	<p>
		You can read and export your vaults through the dashboard, REST API or MCP tools, change
		them at any time, and delete any vault you own from its settings. To disconnect an app,
		remove the connector in that app; if you want us to revoke a connection for you, email us.
		There is no self-serve account deletion yet: email <a
		href="mailto:{SUPPORT_EMAIL}">{SUPPORT_EMAIL}</a> from your account's address and we will
		delete your account and every vault you own within 30 days. You can also ask us what we hold
		about you, or to correct it.
	</p>

	<h2 id="security">Security</h2>
	<p>
		All traffic is over HTTPS. API keys, OAuth codes and tokens, and one-time tokens are stored
		hashed, and LLM keys encrypted. We hold no security certifications. Don't put secrets
		(passwords, private keys) in a vault.
	</p>

	<h2 id="children">Children</h2>
	<p>Brainz is not meant for children under 16.</p>

	<h2 id="changes">Changes</h2>
	<p>
		We will update this page when what we collect or who processes it changes, and change the date
		above.
	</p>
	<ul>
		<li>
			<strong>29 October 2026:</strong> expired and revoked connected-app codes, tokens and
			connection records are now deleted automatically.
		</li>
		<li>
			<strong>28 October 2026:</strong> added what we store when you connect an app such as
			Claude or ChatGPT with OAuth, how long we keep it, and that connected apps send us only
			tool arguments, never your chat history.
		</li>
	</ul>

	<h2 id="contact">Contact</h2>
	<p>Plutocracy Pty Ltd — <a href="mailto:{SUPPORT_EMAIL}">{SUPPORT_EMAIL}</a></p>
</LegalPage>
