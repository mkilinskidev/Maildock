import { describe, expect, it } from "vitest";
import {
  assertEmailHtmlResourceBudget,
  EmailHtmlResourceLimitError,
} from "@/modules/mail/infrastructure/email-html-resource-budget";
import { sanitizeEmailHtml } from "@/modules/mail/infrastructure/sanitize-email-html";

describe("email HTML resource budget", () => {
  it("supports a large normal newsletter within the structural budget", () => {
    const input = `<html><body><h1>Newsletter</h1>${"<p>Offer and updates</p>".repeat(5_000)}</body></html>`;
    assertEmailHtmlResourceBudget(input);
    const result = sanitizeEmailHtml(input);
    expect(result.html.match(/<p>/g)).toHaveLength(5_000);
    expect(result.searchText).toContain("Newsletter Offer and updates");
  });

  it("sanitizes a near-5-MiB single text node within the input budget", () => {
    const text = "x".repeat(4_900_000);
    const input = `<p>${text}</p>`;
    expect(Buffer.byteLength(input, "utf8")).toBeLessThan(5 * 1024 * 1024);
    const result = sanitizeEmailHtml(input);
    expect(result.html).toContain(text);
    expect(result.searchText).toHaveLength(text.length);
  });

  it("rejects the original 87,380-paragraph fixture before constructing a DOM", () => {
    const input =
      "<div>" +
      "<p>R16 HTML body text.</p>".repeat(87_380) +
      '</div><img src="https://remote.invalid/image"><img src="cid:r16-inline">';
    expect(Buffer.byteLength(input, "utf8")).toBeLessThan(5 * 1024 * 1024);
    expect(() => sanitizeEmailHtml(input)).toThrowError(
      expect.objectContaining({
        name: "EmailHtmlResourceLimitError",
        limit: "24,000 element limit",
      }),
    );
  });

  it("rejects extreme nesting, per-element attributes and oversized attributes", () => {
    expect(() =>
      assertEmailHtmlResourceBudget(
        `${"<div>".repeat(257)}x${"</div>".repeat(257)}`,
      ),
    ).toThrow(EmailHtmlResourceLimitError);
    expect(() =>
      assertEmailHtmlResourceBudget(
        `<div ${Array.from({ length: 129 }, (_, i) => `a${i}="x"`).join(" ")}>x</div>`,
      ),
    ).toThrow(EmailHtmlResourceLimitError);
    expect(() =>
      assertEmailHtmlResourceBudget(
        `<p title="${"x".repeat(64 * 1024 + 1)}">x</p>`,
      ),
    ).toThrow(EmailHtmlResourceLimitError);
  });

  it("continues to handle malformed HTML, a large text node and entity references", () => {
    const malformed = sanitizeEmailHtml("<p>first<p>second<div>third");
    expect(malformed.html).toContain("first");
    expect(malformed.html).toContain("second");
    expect(malformed.html).toContain("third");

    const longText = "letter ".repeat(60_000);
    expect(sanitizeEmailHtml(`<p>${longText}</p>`).searchText).toContain(
      "letter letter",
    );
    expect(
      sanitizeEmailHtml(`<p>${"&NotEqualTilde;".repeat(10_000)}</p>`).searchText
        .length,
    ).toBeGreaterThan(10_000);
  });

  it("does not publish HTML omitted by a structural guard as sanitized markup", () => {
    const html = `<p>${"x".repeat(25_000)}</p>`;
    expect(() => sanitizeEmailHtml(html)).not.toThrow();
    const pathological = `<div>${"<p>x</p>".repeat(24_001)}</div>`;
    expect(() => sanitizeEmailHtml(pathological)).toThrow(
      EmailHtmlResourceLimitError,
    );
  });
});
