import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { attackFixtures, hostileMime, png } from "./fixtures";
import { parseFixture } from "./pipeline";
import {
  isSafeRaster,
  renderEmailDocument,
} from "../../src/modules/mail/infrastructure/render-email-document";
import { cidReference } from "../../src/modules/mail/infrastructure/sanitize-email-html";
import { normalizedSender } from "../../src/modules/mail/application/remote-content-sender-service";

const fixtures = attackFixtures("http://127.0.0.1:54321");
describe("independent Phase 2H adversarial MIME/parser corpus", () => {
  for (const fixture of fixtures) {
    it.each([false, true])(
      `${fixture.name}: remote permission %s retains no active surface`,
      async (allow) => {
        const { clean } = await parseFixture(hostileMime(fixture.html));
        const dom = new JSDOM(renderEmailDocument(clean.html, allow));
        try {
          const doc = dom.window.document;
          expect(
            doc.body.querySelector(
              "script,svg,math,iframe,frame,object,embed,form,input,button,link,meta,base,video,audio,source,picture,[id],[name],[srcset],[background],[poster],[srcdoc],[ping]",
            ),
          ).toBeNull();
          for (const el of doc.body.querySelectorAll("*")) {
            for (const attr of el.attributes)
              expect(attr.name).not.toMatch(/^on/i);
            if (el.hasAttribute("src")) {
              expect(allow).toBe(true);
              expect(el.tagName).toBe("IMG");
              expect(el.getAttribute("src")).toMatch(/^https?:\/\//);
            }
          }
          for (const a of doc.querySelectorAll("a[href]")) {
            expect(a.getAttribute("href")).toMatch(/^(https?:|mailto:)/);
            expect(a.getAttribute("target")).toBe("_blank");
          }
          const css = [...doc.querySelectorAll("style,[style]")]
            .map((e) =>
              e.tagName === "STYLE" ? e.textContent : e.getAttribute("style"),
            )
            .join("");
          expect(css).not.toMatch(
            /url\s*\(|@import|@font-face|expression\s*\(|image-set|127\.0\.0\.1/i,
          );
        } finally {
          dom.window.close();
        }
      },
    );
  }
  it("passes hostile CID MIME through decoding without mailparser substituting data URLs", async () => {
    const { parsed, clean } = await parseFixture(
      hostileMime(
        '<p>CID</p><img src="cid:%3CLogo%40EXAMPLE.TEST%3E"><img src="cid:%zz"><img src="cid:%00bad"><img src="cid:svg">',
        [
          { cid: "<Logo@EXAMPLE.TEST>", type: "image/png", bytes: png },
          {
            cid: "<svg>",
            type: "image/svg+xml",
            bytes: Buffer.from('<svg onload="alert(1)"/>'),
          },
        ],
      ),
    );
    expect(parsed.html).toContain("cid:");
    expect(parsed.attachments).toHaveLength(2);
    expect(clean.html).toContain('data-maildock-cid="Logo@example.test"');
    expect(cidReference("cid:%zz")).toBeNull();
    // Malformed IDs may remain inert identifiers, but never become markup or paths.
    const dom = new JSDOM(
      renderEmailDocument(
        clean.html,
        false,
        new Map([
          [
            "Logo@example.test",
            `data:image/png;base64,${png.toString("base64")}`,
          ],
        ]),
      ),
    );
    expect([...dom.window.document.querySelectorAll("img[src]")]).toHaveLength(
      1,
    );
    dom.window.close();
  });
  it("does not mistake SVG/HTML with a spoofed MIME type for a raster", () => {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ]) {
      expect(isSafeRaster(Buffer.from('<svg onload="alert(1)"/>'), type)).toBe(
        false,
      );
      expect(
        isSafeRaster(Buffer.from("<html><script>alert(1)</script>"), type),
      ).toBe(false);
      expect(isSafeRaster(Buffer.alloc(0), type)).toBe(false);
    }
  });
  it("records the signature-only limitation: magic-prefixed active text passes detection, stays an IMG data URL", () => {
    const fake = Buffer.concat([
      png.subarray(0, 8),
      Buffer.from('<svg onload="alert(1)"/>'),
    ]);
    expect(isSafeRaster(fake, "image/png")).toBe(true);
    const dom = new JSDOM(
      renderEmailDocument(
        '<img data-maildock-cid="fake">',
        false,
        new Map([["fake", `data:image/png;base64,${fake.toString("base64")}`]]),
      ),
    );
    expect(dom.window.document.querySelector("svg,script")).toBeNull();
    expect(dom.window.document.querySelector("img")?.src).toMatch(
      /^data:image\/png;/,
    );
    dom.window.close();
  });
  it.each([
    ['"trusted@example.test" <attacker@example.test>', "attacker@example.test"],
    ["Case <UPPER@Example.Test>", "upper@example.test"],
    ["one@example.test, two@example.test", null],
    ["Group: one@example.test, two@example.test;", null],
  ])(
    "trust uses parsed From, never display/group identity: %s",
    async (from, expected) => {
      const { parsed } = await parseFixture(
        hostileMime("<p>sender</p>", [], from!),
      );
      // Group entries contain no single address, matching the production normalizer.
      expect(normalizedSender(parsed.from?.value ?? [])).toBe(expected);
    },
  );
});
