<script lang="ts">
	import { GITHUB_URL, LOGIN_URL, SIGNUP_URL } from "$lib/links";
	import Wordmark from "./Wordmark.svelte";
</script>

<header>
	<div class="container inner">
		<a href="/" class="home" aria-label="Brownmatter home"><Wordmark /></a>
		<nav aria-label="Main">
			<a href="/docs" class="navlink">Docs</a>
			<a href={GITHUB_URL} class="navlink hide-sm" rel="noopener">GitHub</a>
			<a href={LOGIN_URL} class="navlink hide-sm">Sign in</a>
			<a href={SIGNUP_URL} class="btn btn-primary">Sign up</a>
		</nav>
	</div>
</header>

<style>
	header {
		position: sticky;
		top: 0;
		z-index: 20;
		background: rgb(239 237 233 / 0.88);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--border);
	}
	.inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 68px;
	}
	.home {
		text-decoration: none;
	}
	nav {
		display: flex;
		align-items: center;
		gap: 24px;
	}
	.navlink {
		color: var(--text);
		font-size: 15px;
		font-weight: 500;
		text-decoration: none;
	}
	.navlink:hover {
		color: var(--accent);
		text-decoration: none;
	}
	nav .btn {
		padding: 9px 18px;
		font-size: 14px;
	}
	@media (max-width: 560px) {
		nav {
			gap: 14px;
		}
		.hide-sm {
			display: none;
		}
	}
</style>
