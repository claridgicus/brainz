import { describe, expect, it } from "vitest";
import {
  SESSION_BLOCK_END,
  SESSION_BLOCK_START,
  SESSION_PRIMER_PATH,
  claudeCodeSessionHook,
  sessionHookPlaybook,
  serverInstructions,
  sessionInstructions,
} from "../src/session.js";

describe("sessionInstructions", () => {
  it("tells the agent to use Brainz by default: read first, write back after", () => {
    const text = sessionInstructions();
    expect(text).toContain("`brainz` MCP server");
    expect(text).toContain("every session");
    expect(text).toContain("`get_context`");
    expect(text).toContain("`take_task`");
    expect(text).toContain("`upsert_concept`");
  });

  it("echoes a custom server name", () => {
    expect(sessionInstructions({ serverName: " acme-brain " })).toContain("`acme-brain` MCP server");
  });

  it("readOnly drops every write/task tool (viewer connections can't call them)", () => {
    const text = sessionInstructions({ readOnly: true });
    expect(text).toContain("`get_context`");
    expect(text).toContain("read-only");
    for (const tool of ["upsert_concept", "create_task", "take_task", "onboard", "sync"]) {
      expect(text).not.toContain(tool);
    }
  });
});

describe("sessionHookPlaybook", () => {
  it("embeds the primer verbatim plus both install paths by default", () => {
    const playbook = sessionHookPlaybook();
    expect(playbook).toMatch(/^# Session hook playbook/);
    expect(playbook).toContain(sessionInstructions());
    expect(playbook).toContain("## Claude Code");
    expect(playbook).toContain(SESSION_PRIMER_PATH);
    expect(playbook).toContain('"SessionStart"');
    expect(playbook).toContain("AGENTS.md");
    expect(playbook).toContain(SESSION_BLOCK_START);
    expect(playbook).toContain(SESSION_BLOCK_END);
  });

  it("client narrows the playbook to one harness", () => {
    const claude = sessionHookPlaybook({ client: "claude-code" });
    expect(claude).toContain('"SessionStart"');
    expect(claude).not.toContain(SESSION_BLOCK_START);
    const other = sessionHookPlaybook({ client: "other" });
    expect(other).toContain(SESSION_BLOCK_START);
    expect(other).not.toContain('"SessionStart"');
  });

  it("the embedded settings snippet is valid JSON matching claudeCodeSessionHook()", () => {
    const playbook = sessionHookPlaybook({ client: "claude-code" });
    const json = /```json\n([\s\S]*?)\n```/.exec(playbook)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toEqual(claudeCodeSessionHook());
    // No matcher → fires on startup, resume, clear, and compact.
    expect(claudeCodeSessionHook().hooks.SessionStart[0]).not.toHaveProperty("matcher");
  });
});

describe("serverInstructions (neutral, Brainz Cloud)", () => {
  it("describes the tools without directing when or how often to use them", () => {
    for (const text of [
      serverInstructions(),
      serverInstructions({ readOnly: true }),
      serverInstructions({ multiVault: true }),
    ]) {
      expect(text).toContain("get_context");
      expect(text).not.toMatch(/every session|don't wait|by default|before planning|skip brainz/i);
    }
  });

  it("names no write or task tools on a read-only connection", () => {
    const text = serverInstructions({ readOnly: true });
    expect(text).toContain("read-only");
    for (const tool of ["upsert_concept", "take_task", "onboard", "session_hook"]) {
      expect(text).not.toContain(tool);
    }
    expect(serverInstructions()).not.toContain("session_hook");
  });

  it("explains vault routing on a multi-vault connection only", () => {
    const multi = serverInstructions({ multiVault: true });
    expect(multi).toContain("several Brainz vaults");
    expect(multi).toContain("`list_vaults`");
    expect(multi).toContain("`vault` argument");
    expect(serverInstructions()).not.toContain("list_vaults");
    expect(serverInstructions({ multiVault: true, readOnly: true })).toContain("read-only");
  });
});
