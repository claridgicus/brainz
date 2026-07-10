// Safe markdown rendering — ported from packages/web/frontend/markdown.ts
// (same sanitization rules; keep the two in sync).
//
// Sanitization strategy: raw HTML in notes is *escaped* (shown as text, never
// executed) via a renderer override, and link/image URLs with non-http(s)/
// mailto schemes are neutralized via walkTokens. Wiki-links [[id]] /
// [[id|label]] become internal anchors (href "#concept:<id>") that the
// concept panel intercepts for in-app navigation.

import { Marked, type Tokens } from "marked";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

function isSafeUrl(href: string): boolean {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(href);
  return m === null || SAFE_SCHEMES.has((m[1] as string).toLowerCase());
}

const md = new Marked({
  gfm: true,
  breaks: false,
  useNewRenderer: true,
  renderer: {
    // Never emit raw HTML from note bodies.
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
  },
  walkTokens(token) {
    if (token.type === "link" || token.type === "image") {
      const t = token as Tokens.Link | Tokens.Image;
      if (!isSafeUrl(t.href)) t.href = "#";
    }
  },
});

const WIKI_LINK = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

/** Convert [[id]] / [[id|label]] into markdown links to "#concept:<id>". */
export function expandWikiLinks(source: string): string {
  return source.replace(WIKI_LINK, (_m, id: string, label?: string) => {
    const target = id.trim();
    return `[${(label ?? target).trim()}](#concept:${target})`;
  });
}

/** Render note markdown to HTML with raw HTML escaped and URLs sanitized. */
export function renderMarkdown(source: string): string {
  return md.parse(expandWikiLinks(source), { async: false }) as string;
}
