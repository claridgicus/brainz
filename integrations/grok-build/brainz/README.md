# Brainz for Grok Build

Connect Grok Build to [Brainz](https://brainz.brownmatter.ai), a shared
product-knowledge graph for agent fleets. Before coding, Grok pulls a briefing of
the specs, decisions and code areas that govern the task. After coding, it writes
what changed back, so the next agent starts from the same picture. A vault also
holds a task pile that several agents can claim from.

## Installation

1. Sign in at https://brainz.brownmatter.ai and create an API key in your vault's
   settings. Each key is scoped to one vault.
2. Put the key in the environment Grok starts from, for example in your shell
   profile:

   ```sh
   export BRAINZ_API_KEY=bz_...
   ```

3. In Grok Build, open `/plugins`, search for **Brainz** and install it, or run
   `grok plugin install brainz --trust`. Restart Grok if it was already running
   when you set the variable.

Try: "Use Brainz to get the context for the checkout flow before you change it."

## Components and permissions

This plugin contains one HTTP MCP connection and one skill. It has no scripts,
lifecycle hooks, local executables or dependency installation. The MCP tools
read and write concepts and tasks in the vault the API key belongs to, and
nothing else.

## Network and authentication

- `https://brainz.brownmatter.ai/mcp`: the hosted Brainz MCP server (Streamable
  HTTP). It is the only endpoint the plugin contacts.

Credentials: a Brainz API key, read from the `BRAINZ_API_KEY` environment
variable and sent as `Authorization: Bearer ${BRAINZ_API_KEY}`. No key is bundled
in the plugin, and the plugin reads no other files or environment variables.
Revoke or rotate keys in the vault settings. Brainz does not offer OAuth yet, so
there is no browser sign-in flow on first connect.

## Ownership and license

Maintained by Brownmatter (https://brownmatter.ai), the maker of Brainz. Source:
https://github.com/claridgicus/brainz (`integrations/grok-build/brainz`).
The plugin files are MIT licensed. Documentation: https://brownmatter.ai/docs.

## Updating the submission

This folder is the source of truth for `external_plugins/brainz` in
[xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace).
After changing it, copy it into the marketplace, run
`python3 scripts/generate-plugin-index.py`, `python3 scripts/validate-catalog.py`
and `python3 scripts/generate-plugin-index.py --check`, and open a PR.
