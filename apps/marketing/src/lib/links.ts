/** Single source of truth for every outbound link on the marketing site. */
export const APP_URL = "https://brainz.brownmatter.ai";
export const SIGNUP_URL = `${APP_URL}/signup`;
export const LOGIN_URL = `${APP_URL}/login`;
export const MCP_URL = `${APP_URL}/mcp`;
/** Agent self-signup endpoint: the public `signup` / `sign_in` tools live here, not on /mcp. */
export const AGENT_MCP_URL = `${APP_URL}/mcp/agent`;
/** Paste-one-prompt agent self-setup skill (signup → key config → claim → onboard). */
export const SKILL_URL = `${APP_URL}/skill.md`;

/** Placeholder until the repository is published. */
export const GITHUB_URL = "https://github.com/brownmatter-ai/brainz";

export const SITE_URL = "https://brownmatter.ai";

/** Support mailbox — the contact on /support, /privacy, /terms and the MCP server card. */
export const SUPPORT_EMAIL = "support@brownmatter.ai";
