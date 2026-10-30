/**
 * Cards: the plain pages a flow shows that the app does not serve — a
 * title, an end card, a stand-in app's "connected" page. Self-contained
 * HTML in the app's dark palette, with the Brainz mark (the same SVG as
 * apps/cloud/src/lib/components/Mark.svelte).
 */

const MARK = `<svg viewBox="0 0 100 100" width="88" height="88" aria-hidden="true">
<path fill="#F58EA8" d="M32 20 A13 13 0 0 1 54 13 A13 13 0 0 1 76 20 A12 12 0 0 1 91 33 A10.2 10.2 0 0 0 76 46 A6.1 6.1 0 0 0 76 58 A7.7 7.7 0 0 0 88 67 A14 14 0 0 1 68 86 A13 13 0 0 1 44 88 A13 13 0 0 1 22 80 A13 13 0 0 1 10 60 A12 12 0 0 1 12 38 A15 15 0 0 1 32 20 Z"/>
<g fill="none" stroke="#C24D6F" stroke-width="7" stroke-linecap="round"><path d="M55 14 C50 24 57 32 49 44"/><path d="M22 42 C33 35 31 52 42 47"/><path d="M33 69 C44 62 42 77 55 71"/></g>
<circle fill="#A4C93F" cx="92" cy="48" r="3.4"/><circle fill="#A4C93F" cx="96" cy="59" r="2.4"/>
</svg>`;

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export interface CardContent {
  /** A small line above the heading. */
  readonly eyebrow?: string;
  readonly heading: string;
  readonly lines?: ReadonlyArray<string>;
  /** Show the Brainz mark above it all. */
  readonly mark?: boolean;
}

export const card = ({ eyebrow, heading, lines = [], mark = false }: CardContent): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(heading)}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: grid; place-items: center; background: radial-gradient(ellipse at 50% 40%, #1e1a2e 0%, #0e0e11 70%);
    color: #e7e7ea; /* the app's --font-sans */
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif;
  }
  main { text-align: center; max-width: 1100px; padding: 0 48px; }
  .mark { display: inline-block; margin-bottom: 28px; }
  .eyebrow { color: #a78bfa; font-size: 20px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 14px; }
  h1 { font-size: 64px; line-height: 1.08; letter-spacing: -0.02em; margin: 0 0 26px; }
  p { font-size: 26px; line-height: 1.5; color: #b7b7bd; margin: 6px 0; }
</style></head>
<body><main>
${mark ? `<div class="mark">${MARK}</div>` : ""}
${eyebrow === undefined ? "" : `<p class="eyebrow">${escape(eyebrow)}</p>`}
<h1>${escape(heading)}</h1>
${lines.map((line) => `<p>${escape(line)}</p>`).join("\n")}
</main></body></html>`;
