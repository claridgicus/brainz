import { describe, expect, it } from "vitest";
import { expandWikiLinks, renderMarkdown } from "../frontend/markdown.js";

describe("renderMarkdown sanitization", () => {
  it("renders plain markdown", () => {
    const html = renderMarkdown("# Hello\n\nSome **bold** text.");
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes raw HTML instead of executing it", () => {
    const html = renderMarkdown('before\n\n<script>alert("xss")</script>\n\nafter');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes inline HTML like event handlers", () => {
    const html = renderMarkdown('click <img src=x onerror="alert(1)"> here');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("neutralizes javascript: links but keeps safe ones", () => {
    const bad = renderMarkdown("[boom](javascript:alert(1))");
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain('href="#"');

    const good = renderMarkdown("[docs](https://example.com/x)");
    expect(good).toContain('href="https://example.com/x"');

    const mail = renderMarkdown("[hi](mailto:a@b.c)");
    expect(mail).toContain('href="mailto:a@b.c"');
  });

  it("turns wiki-links into internal concept anchors", () => {
    expect(expandWikiLinks("see [[jwt-tokens]] and [[lead|Leads]]"))
      .toBe("see [jwt-tokens](#concept:jwt-tokens) and [Leads](#concept:lead)");
    const html = renderMarkdown("see [[jwt-tokens]]");
    expect(html).toContain('href="#concept:jwt-tokens"');
    expect(html).toContain(">jwt-tokens</a>");
  });
});
