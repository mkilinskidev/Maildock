import { createContentSecurityPolicy } from "@/shared/infrastructure/security/content-security-policy";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  sanitizeEmailHtml,
  normalizeContentId,
  cidReference,
} from "@/modules/mail/infrastructure/sanitize-email-html";
import { renderEmailDocument } from "@/modules/mail/infrastructure/render-email-document";
import { normalizedSender } from "@/modules/mail/application/remote-content-sender-service";

function rendered(
  input: string,
  allow = false,
  cids: Map<string, string> = new Map(),
) {
  return renderEmailDocument(sanitizeEmailHtml(input).html, allow, cids);
}
describe("Phase 2H HTML/privacy boundary", () => {
  it("allows consented images through inherited reader CSP while the email policy still blocks by default", () => {
    const parentPolicy = createContentSecurityPolicy("test-nonce");
    expect(parentPolicy).toContain("img-src 'self' data: https: http:");
    expect(parentPolicy).toContain("connect-src 'self'");
    expect(parentPolicy).toContain("object-src 'none'");
    expect(parentPolicy).toContain("'nonce-test-nonce' 'strict-dynamic'");
    const defaultDoc = new JSDOM(
      rendered('<img src="https://tracker.test/pixel">'),
    ).window.document;
    expect(defaultDoc.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(
      defaultDoc.querySelector("meta[http-equiv]")?.getAttribute("content"),
    ).toContain("img-src data:;");
    const allowedDoc = new JSDOM(
      rendered('<img src="https://tracker.test/pixel">', true),
    ).window.document;
    expect(allowedDoc.querySelector("img")?.src).toBe(
      "https://tracker.test/pixel",
    );
    expect(
      allowedDoc.querySelector("meta[http-equiv]")?.getAttribute("content"),
    ).toContain("img-src data: https: http:");
    expect(
      allowedDoc.querySelector("meta[http-equiv]")?.getAttribute("content"),
    ).toContain("script-src 'none'");
  });
  it("preserves tables, colors, spacing, inline styles and inert image references", () => {
    const clean = sanitizeEmailHtml(
      '<style>.invoice{color:#123;margin:2px}</style><table bgcolor="#eee" width="800"><tr><td style="padding:10px;color:rgb(1,2,3);text-align:center">Invoice<img src="cid:logo"></td></tr></table>',
    );
    expect(clean.remoteContentBlocked).toBe(false);
    expect(clean.html).toContain('data-maildock-cid="logo"');
    const doc = new JSDOM(renderEmailDocument(clean.html, false)).window
      .document;
    expect(doc.querySelector("td")?.style.padding).toBe("10px");
    expect(doc.querySelector("table")?.getAttribute("bgcolor")).toBe("#eee");
    expect(doc.querySelector("style")?.textContent).toContain("max-width");
    expect(doc.documentElement.innerHTML).toContain(".invoice");
  });
  const hostile = [
    '<img src="https://tracker.test/pixel" width="1" height="1" onerror="alert(1)">',
    '<img srcset="https://tracker.test/x 1x"><picture><source srcset="https://tracker.test/y"></picture>',
    '<div background="https://tracker.test/bg" style="background-image:url(https://tracker.test/bg);color:red">x</div>',
    '<style>@import "https://tracker.test/css";@font-face{font-family:evil;src:url(https://tracker.test/font)}div{background:url(https://tracker.test/bg)}</style>',
    "<style>div{background:u\\72l(https://tracker.test/bg);behavior:url(https://tracker.test/htc)}</style>",
    '<link rel="preload" href="https://tracker.test/x"><link rel="stylesheet" href="https://tracker.test/y"><video poster="https://tracker.test/p" src="https://tracker.test/v"></video>',
    '<iframe src="https://tracker.test/frame"></iframe><object data="https://tracker.test/object"></object><embed src="https://tracker.test/embed">',
  ];
  it.each(hostile)("blocks remote paths before rendering %s", (input) => {
    const sanitized = sanitizeEmailHtml(input);
    expect(sanitized.remoteContentBlocked).toBe(true);
    const html = renderEmailDocument(sanitized.html, false);
    const doc = new JSDOM(html).window.document;
    expect(doc.body.innerHTML).not.toContain("tracker.test");
    expect(
      doc.querySelector(
        "img[src], [srcset], link, iframe, object, embed, video, audio, source, [background]",
      ),
    ).toBeNull();
    expect(
      doc.querySelector("meta[http-equiv]")?.getAttribute("content"),
    ).toContain("img-src data:;");
  });
  it("makes zero resource loader requests with default hostile HTML", async () => {
    const requests: string[] = [];
    const dom = new JSDOM(rendered(hostile.join("")), {
      resources: {
        interceptors: [
          () => () => {
            requests.push("resource");
            throw Error("Network forbidden in test");
          },
        ],
      },
      url: "https://maildock.test/",
    });
    await new Promise((resolve) =>
      dom.window.addEventListener("load", resolve),
    );
    expect(requests).toEqual([]);
    dom.window.close();
  });
  it("remote permission activates only images and never active markup or CSS resources", () => {
    const doc = new JSDOM(
      rendered(
        '<img src="https://tracker.test/p"><script>x()</script><form><input></form><style>div{background:url(https://tracker.test/bg)}</style><a href="javascript:alert(1)">x</a>',
        true,
      ),
    ).window.document;
    expect(doc.querySelector("img")?.src).toBe("https://tracker.test/p");
    expect(doc.querySelector("script,form,input")).toBeNull();
    expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(doc.documentElement.innerHTML).not.toContain("tracker.test/bg");
    expect(
      doc.querySelector("meta[http-equiv]")?.getAttribute("content"),
    ).toContain("script-src 'none'");
  });
  it("safe links always open outside the iframe with opener/referrer protections", () => {
    const doc = new JSDOM(
      rendered(
        '<a href="https://example.test" target="_top">web</a><a href="mailto:a@example.test">mail</a><a href="custom:evil">unknown</a>',
      ),
    ).window.document;
    const links = [...doc.querySelectorAll("a")];
    for (const link of links.slice(0, 2)) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
    expect(links[2]?.hasAttribute("href")).toBe(false);
  });
  it("rejects clobbering, SVG and unknown image protocols", () => {
    const doc = new JSDOM(
      rendered(
        '<p id="document" name="location">x</p><svg><script>x</script></svg><img src="data:image/svg+xml,evil"><img src="file:///x"><img src="custom:x">',
        true,
      ),
    ).window.document;
    expect(
      doc.body.querySelector("[id],[name],svg,script,img[src]"),
    ).toBeNull();
  });
  it("resolves only validated local raster mappings and handles missing CID", () => {
    const doc = new JSDOM(
      rendered(
        '<img src="cid:%3Clogo%40EXAMPLE.TEST%3E"><img src="cid:missing"><img src="cid:unsafe">',
        false,
        new Map([
          ["logo@example.test", "data:image/png;base64,AQID"],
          ["unsafe", "data:image/svg+xml;base64,AQID"],
        ]),
      ),
    ).window.document;
    expect(
      [...doc.querySelectorAll("img")].map((img) => img.getAttribute("src")),
    ).toEqual(["data:image/png;base64,AQID", null, null]);
    expect(normalizeContentId(" <Logo@EXAMPLE.TEST> ")).toBe(
      "Logo@example.test",
    );
    expect(cidReference("CID:<Logo@EXAMPLE.TEST>")).toBe("Logo@example.test");
    expect(cidReference("cid:%zz")).toBeNull();
  });
  it("does not report remote content for text, links or CID-only HTML", () => {
    for (const input of [
      "<p>Hello</p>",
      '<a href="https://example.test">link</a>',
      '<img src="cid:local">',
    ])
      expect(sanitizeEmailHtml(input).remoteContentBlocked).toBe(false);
  });
  it("preserves legacy body colors without flagging local CSS or escaped font names as remote", () => {
    const clean = sanitizeEmailHtml(
      '<html><body bgcolor="#000000" text="#ffffff"><p style="font-family:\\41 rial">Readable</p><style>@font-face{font-family:x;src:local(Arial)}</style></body></html>',
    );
    const doc = new JSDOM(renderEmailDocument(clean.html, false)).window
      .document;
    expect(doc.body.querySelector("div")?.style.backgroundColor).toBe(
      "rgb(0, 0, 0)",
    );
    expect(doc.body.querySelector("div")?.style.color).toBe(
      "rgb(255, 255, 255)",
    );
    expect(clean.remoteContentBlocked).toBe(false);
    expect(sanitizeEmailHtml('<img src="javascript:alert(1)">').html).toBe("");
  });
  it("strips forged internal references and falls back from formatting-only HTML", () => {
    const clean = sanitizeEmailHtml(
      '<img data-maildock-cid="other-message" data-maildock-remote="https://tracker.test/forged">',
    );
    expect(clean.html).not.toContain("other-message");
    expect(clean.html).not.toContain("tracker.test");
    expect(
      sanitizeEmailHtml("<style>body{color:red}</style><p> </p>").html,
    ).toBe("");
  });
  it("sender identity comes only from a single parsed exact mailbox", () => {
    expect(normalizedSender([{ address: " Evil@Example.Test " }])).toBe(
      "evil@example.test",
    );
    expect(normalizedSender([{}])).toBeNull();
    expect(
      normalizedSender([
        { address: "one@example.test" },
        { address: "two@example.test" },
      ]),
    ).toBeNull();
  });
});
