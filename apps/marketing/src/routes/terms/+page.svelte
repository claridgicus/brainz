<script lang="ts">
	import Seo from "$lib/components/Seo.svelte";
	import LegalPage from "$lib/components/LegalPage.svelte";
	import { SUPPORT_EMAIL } from "$lib/links";

	// Approved by James 2026-10-28.
	const title = "Terms of Service — Brainz";
	const description =
		"The terms for using Brainz at brainz.brownmatter.ai: your account and keys, your agents, your content, acceptable use and liability.";
</script>

<Seo {title} {description} path="/terms" type="article" />

<LegalPage kicker="Legal" heading="Terms of Service" updated="28 October 2026">
	<p>
		These terms cover your use of Brainz at <code>brainz.brownmatter.ai</code>, run by Plutocracy Pty
		Ltd ("Brownmatter", "we"). By creating an account, connecting an agent or using an API key, you
		agree to them.
	</p>

	<h2 id="service">The service</h2>
	<p>
		Brainz is free to use. We may change, limit or stop features, and may introduce paid plans; if we
		do, we will say so before charging anyone. The open-source CLI and packages are licensed
		separately under the MIT License.
	</p>

	<h2 id="account">Your account and keys</h2>
	<p>
		You are responsible for your account and for every API key you or your agents create. Anyone
		with a key can read and change its vault, so keep keys secret and revoke any you think leaked. A
		workspace an agent creates without a human is provisional and stops working after 7 days unless a
		human approves the claim email.
	</p>

	<h2 id="agents">Your agents</h2>
	<p>
		You are responsible for what agents acting with your keys do in Brainz, as if you did it
		yourself.
	</p>

	<h2 id="content">Your content</h2>
	<p>
		You own what you put in Brainz. You give us permission to store, index, process and display it
		only to run the service for you, including sending it to the processors in our
		<a href="/privacy">Privacy Policy</a> (for example Workers AI for search and dreaming, or the LLM
		provider you configured). You must have the right to put it there.
	</p>

	<h2 id="acceptable-use">Acceptable use</h2>
	<p>
		Don't use Brainz to break the law or infringe others' rights; store other people's personal data
		without a lawful basis; store malware; attack, probe or overload the service or get around its
		rate limits; access vaults you weren't given; or resell the service. We may suspend or delete
		accounts that do, or that we reasonably believe are abusing the service.
	</p>

	<h2 id="ending">Ending</h2>
	<p>
		You can stop using Brainz and delete your vaults at any time (see the
		<a href="/privacy#your-choices">Privacy Policy</a> for account deletion). We may close accounts
		that break these terms, and will try to warn you first unless the abuse is serious.
	</p>

	<h2 id="warranty">No warranty</h2>
	<p>
		Brainz is provided "as is" and "as available", without warranties of any kind, to the extent the
		law allows. We don't promise it will be uninterrupted, error-free or that data will never be lost
		— keep your own copy of anything important (the CLI can hold a local vault).
	</p>

	<h2 id="liability">Limits on liability</h2>
	<p>
		To the extent the law allows, we are not liable for indirect or consequential loss, lost data or
		lost profits, and our total liability is limited to AUD $100. Nothing here excludes rights you
		have under consumer law that can't be excluded.
	</p>

	<h2 id="changes">Changes</h2>
	<p>
		We may update these terms; we will change the date above, and for material changes give notice on
		this page before they apply.
	</p>

	<h2 id="law">Law</h2>
	<p>These terms are governed by the laws of Victoria, Australia.</p>

	<h2 id="contact">Contact</h2>
	<p>Plutocracy Pty Ltd — <a href="mailto:{SUPPORT_EMAIL}">{SUPPORT_EMAIL}</a></p>
</LegalPage>
