/**
 * Session defaults — making Brainz the thing an agent reaches for FIRST, every
 * session, without a human reminding it.
 *
 * Two layers, both rendered from here so the product speaks with one voice:
 *
 * 1. `sessionInstructions()` — sent as the MCP `instructions` on initialize by
 *    both servers (local stdio and Brainz Cloud). Every MCP client that
 *    surfaces server instructions gets it for free, with nothing installed.
 * 2. `sessionHookPlaybook()` — returned by the `session_hook` tool (and
 *    `brainz hook`). Brainz can't write to the caller's repo, so — like
 *    onboarding — it hands the CALLING agent a playbook for installing a
 *    session-start hook in its own harness, which survives clients that ignore
 *    server instructions and context compaction.
 */

/** Default name the Brainz MCP server is registered under in a client. */
export const DEFAULT_MCP_SERVER_NAME = "brainz";

/** Repo-relative file the session-start hook prints into the agent's context. */
export const SESSION_PRIMER_PATH = ".claude/brainz-session.md";

/** Markers delimiting the Brainz block in a rules file (AGENTS.md etc.) so re-installs replace, not duplicate. */
export const SESSION_BLOCK_START = "<!-- brainz:session:start -->";
export const SESSION_BLOCK_END = "<!-- brainz:session:end -->";

export interface SessionInstructionsOptions {
  /** Name the MCP server is registered under in the client (default "brainz"). */
  serverName?: string;
  /** Viewer-scoped connection (public vault): read guidance only, no write-back. */
  readOnly?: boolean;
}

/**
 * The every-session default: what an agent should do with Brainz before,
 * during, and after work. Short on purpose — it is injected into every session.
 */
export function sessionInstructions(opts: SessionInstructionsOptions = {}): string {
  const name = opts.serverName?.trim() || DEFAULT_MCP_SERVER_NAME;
  const lines = [
    `# Brainz — this project's shared product knowledge graph`,
    "",
    `The \`${name}\` MCP server holds the product's features, specs, decisions, and constraints. Use it by default, every session — don't wait to be asked:`,
    "",
    "- **Before planning or changing anything:** call `get_context` with a query describing the task (or `search_concepts` to explore) and read the result — it tells you which specs and decisions govern the area.",
    "- **Before delegating to a subagent:** call `get_context` and paste the returned markdown into the subagent's prompt.",
  ];
  if (opts.readOnly) {
    lines.push(
      "- **To go deeper:** `get_concept` for one full note, `get_related` to map what a change touches.",
      "",
      "This connection is read-only. Skip Brainz only for work that doesn't touch the product (e.g. a one-off shell question).",
    );
    return lines.join("\n");
  }
  lines.push(
    "- **Looking for work:** `list_tasks` to survey, `take_task` to claim (it returns a briefing), `complete_task` when done.",
    "- **After the work:** write back what changed or what you learned with `upsert_concept` (anchor it with `codeAreas`), and file follow-ups with `create_task`. A graph that lags the code misleads the next agent.",
    "- **If a result says the vault isn't onboarded or is stale:** run `onboard` / `sync`.",
    "",
    "Skip Brainz only for work that doesn't touch the product (e.g. a one-off shell question).",
  );
  return lines.join("\n");
}

/** Clients the hook playbook has specific install steps for. */
export const SESSION_HOOK_CLIENTS = ["claude-code", "other"] as const;
export type SessionHookClient = (typeof SESSION_HOOK_CLIENTS)[number];

export interface SessionHookPlaybookOptions {
  /** Restrict the playbook to one client's steps; omit for both. */
  client?: SessionHookClient;
  /** Name the MCP server is registered under in the client (default "brainz"). */
  serverName?: string;
}

/** The Claude Code `SessionStart` hook entry the playbook asks the agent to merge into settings. */
export function claudeCodeSessionHook(): {
  hooks: { SessionStart: { hooks: { type: "command"; command: string }[] }[] };
} {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `cat ${SESSION_PRIMER_PATH}` }] }],
    },
  };
}

/**
 * The session-hook playbook (markdown) returned by `session_hook`:
 * instructions for the calling agent to install a session-start hook in its
 * own harness so every future session opens with the Brainz defaults.
 */
export function sessionHookPlaybook(opts: SessionHookPlaybookOptions = {}): string {
  const primer = sessionInstructions({ serverName: opts.serverName });
  const claude = opts.client === undefined || opts.client === "claude-code";
  const other = opts.client === undefined || opts.client === "other";
  const parts: string[] = [];

  parts.push(`# Session hook playbook

Install a session-start hook so every future agent session in this repo opens knowing to use Brainz by default. Brainz can't write to your repo — YOU make these edits, in the repository root, then commit them so the whole team (and every agent) gets the hook.

The steps are idempotent: if a previous install exists, replace it rather than adding a second copy.

## The primer

This is the text each session will start with. Use it verbatim:

\`\`\`markdown
${primer}
\`\`\``);

  if (claude) {
    parts.push(`## Claude Code

1. Write the primer above to \`${SESSION_PRIMER_PATH}\` (overwrite if present).
2. Merge this into \`.claude/settings.json\` (create the file if missing). Keep every existing key and any existing \`SessionStart\` entries — only add the Brainz entry, and only if an entry with this exact command isn't already there:

\`\`\`json
${JSON.stringify(claudeCodeSessionHook(), null, 2)}
\`\`\`

   No \`matcher\` is set on purpose: the hook then fires on startup, resume, clear, AND after context compaction, so the defaults are never lost mid-session. Whatever the command prints is added to the session's context.
3. Verify: run \`cat ${SESSION_PRIMER_PATH}\` from the repo root and confirm it prints the primer, and that \`.claude/settings.json\` is still valid JSON.`);
  }

  if (other) {
    parts.push(`## ${claude ? "Other agents (Cursor, Codex, Windsurf, …)" : "Install"}

Clients without session hooks read a rules file at session start instead. Add the primer to the one your client loads — \`AGENTS.md\` at the repo root unless the client has its own (e.g. \`.cursor/rules/brainz.mdc\`) — wrapped in these markers so a re-install replaces the block instead of duplicating it:

\`\`\`markdown
${SESSION_BLOCK_START}
${primer}
${SESSION_BLOCK_END}
\`\`\`

If the markers are already in the file, replace everything between them. Leave the rest of the file untouched.`);
  }

  parts.push(`## Finish

Tell your human what you changed and that the hook takes effect from the NEXT session. Then carry on with this one as the primer says: \`get_context\` before you plan.`);

  return `${parts.join("\n\n")}\n`;
}
