# Directory submission packets

Prepared material for listing Brainz (`https://brainz.brownmatter.ai/mcp`) in third-party
directories. Nothing here is submitted automatically: submission needs James's own accounts.

| File | What it is |
|---|---|
| [`anthropic.md`](anthropic.md) | Claude Connectors Directory: portal steps 1–10 field by field, tool annotations, reviewer instructions, gap check |
| [`openai.md`](openai.md) | ChatGPT plugin directory: ZIP and portal fields, annotation justifications, test cases, gap check, demo video script |
| [`openai-plugin/`](openai-plugin/) | The plugin package to zip and upload to platform.openai.com/plugins |
| [`assets/`](assets/) | Logo: `brainz-tile*` (mark on the app's dark tile; primary icon) and `brainz-mark*` (transparent), as SVG plus PNG at 512/256/128/64/48 px, built from `apps/cloud/src/lib/components/Mark.svelte` with `rsvg-convert` |
| [`seed-reviewer-vault.mjs`](seed-reviewer-vault.mjs) | Seeds or resets a reviewer's demo vault on production through the REST API |

Reviewer credentials are never committed. They live in `~/.config/brainz-reviewers/{anthropic,openai}.json`
(mode 0600) on the operator's machine and go only into each portal's private reviewer field. The
accounts come from `apps/cloud/scripts/reviewer-account.mjs` (SPEC-CLOUD "Reviewer test login").

Open gaps are tracked as Brainz tasks tagged `area-distribution`. The umbrella task is
`james-submit-brainz-to-the-claude-connectors-directory-and-the-chatgpt-plugin-directory`.
