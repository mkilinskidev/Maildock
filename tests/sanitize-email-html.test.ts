import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { sanitizeEmailHtml } from "@/modules/mail/infrastructure/sanitize-email-html";

const payloads = [
  "<script>alert(1)</script>",
  '<p onclick="alert(1)">click</p>',
  '<a href="javascript:alert(1)">evil</a>',
  '<iframe src="https://tracker.example/x" srcdoc="<script>x</script>"></iframe>',
  '<object data="https://tracker.example/x"></object><embed src="https://tracker.example/x">',
  '<form action="https://tracker.example/x"><input name="password"><button>Send</button></form>',
  '<meta http-equiv="refresh" content="0;url=https://tracker.example/x"><base href="https://tracker.example/">',
  '<img src="https://tracker.example/pixel" width="1" height="1">',
  '<img srcset="https://tracker.example/1 1x, https://tracker.example/2 2x">',
  '<style>@import url(https://tracker.example/css);</style><p style="background:url(https://tracker.example/a)">x</p>',
  '<svg><image href="https://tracker.example/x"></image></svg><math><mi>x</mi></math>',
  '<a href="data:text/html,evil">data</a><img src="data:image/svg+xml,evil">',
  '<div><table><tr><td><img src="https://tracker.example/nested"></table></div>',
  '<p id="location" name="document">clobber</p>',
  '<video poster="https://tracker.example/poster" src="https://tracker.example/v"><source src="https://tracker.example/s"></video>',
  '<audio src="https://tracker.example/a"></audio><link rel="stylesheet" href="https://tracker.example/css">',
];

describe("email HTML security policy", () => {
  it.each(payloads)(
    "removes active and network-bearing markup: %s",
    (payload) => {
      const result = sanitizeEmailHtml(payload);
      const document = new JSDOM(result.html).window.document;
      expect(
        document.querySelector(
          "script,iframe,frame,object,embed,form,input,button,meta,base,link,style,svg,math,img,video,audio,source",
        ),
      ).toBeNull();
      expect(result.html).not.toMatch(
        /tracker\.example|javascript:|data:text|onclick=|style=|src=|srcset=|srcdoc=|id=|name=/i,
      );
    },
  );
  it("keeps only explicit safe navigation links", () => {
    const html = sanitizeEmailHtml(
      '<a href="https://example.test/a" target="_top">Web</a><a href="mailto:a@example.test">Mail</a><a href="file:///etc/passwd">File</a><a href="blob:https://example.test/x">Blob</a>',
    ).html;
    const links = [...new JSDOM(html).window.document.querySelectorAll("a")];
    expect(links.map((item) => item.getAttribute("href"))).toEqual([
      "https://example.test/a",
      "mailto:a@example.test",
      null,
      null,
    ]);
    expect(html).not.toContain("target");
  });
  it("reports removed remote resources and CID images", () => {
    expect(
      sanitizeEmailHtml('<img src="https://tracker.example/1">')
        .remoteContentBlocked,
    ).toBe(true);
    expect(sanitizeEmailHtml('<img src="cid:local">').html).not.toContain(
      "cid:",
    );
  });
});
