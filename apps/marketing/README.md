# brainz-marketing

Static SvelteKit marketing site for brownmatter.ai, deployed to Cloudflare
Workers static assets.

## Commands

```sh
npm run dev      # vite dev
npm run build    # vite build (prerendered static site into build/)
npm run preview  # wrangler dev over the built assets
npm run check    # svelte-check
npm test         # scripts/check-build.mjs — post-build assertions (CTA links, no external assets)
npm run deploy   # GATED: predeploy runs the marketing test subset first, then build + wrangler deploy
```

## Deploy is gated

`npm run deploy` cannot proceed unless the gate passes: the `predeploy` hook
runs `node ../../scripts/test-all.mjs --scope marketing` (svelte-check →
build → check-build). The full monorepo gate is `npm run test:all` at the
repo root — see `TESTING.md` there.
