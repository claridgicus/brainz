// Sanitization contract for concept bodies — mirrors packages/web's rules.
import { describe, expect, it } from "vitest";
import { expandWikiLinks, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("escapes raw HTML instead of executing it", () => {
    const html = renderMarkdown('hello <script>alert("x")</script> <b onclick="p()">bold</b>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b onclick");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralizes javascript: URLs in links and images", () => {
    const html = renderMarkdown("[click](javascript:alert(1)) ![img](vbscript:evil)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("vbscript:");
    expect(html).toContain('href="#"');
  });

  it("keeps http(s)/mailto links", () => {
    const html = renderMarkdown("[ok](https://example.com) [mail](mailto:a@b.c)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:a@b.c"');
  });

  it("turns wiki-links into in-app #concept: anchors", () => {
    const html = renderMarkdown("See [[lead-scoring]] and [[auth-system|the auth note]].");
    expect(html).toContain('href="#concept:lead-scoring"');
    expect(html).toContain('href="#concept:auth-system"');
    expect(html).toContain(">the auth note</a>");
  });
});

describe("expandWikiLinks", () => {
  it("supports labeled and unlabeled forms", () => {
    expect(expandWikiLinks("[[a-b]]")).toBe("[a-b](#concept:a-b)");
    expect(expandWikiLinks("[[a-b|Label]]")).toBe("[Label](#concept:a-b)");
  });
});
