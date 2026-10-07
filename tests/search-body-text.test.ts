import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { searchBodyText } from "@/modules/mail/infrastructure/search-body-text";

describe("inert local search text extraction", () => {
  it("prefers an existing plain part and decodes HTML-only entities with block separation", () => {
    expect(searchBodyText("Local plain", "<p>HTML</p>")).toBe("Local plain");
    expect(searchBodyText("   ", "<p>Łódź &amp; invoice</p><p>12345</p>")).toBe(
      "Łódź & invoice 12345",
    );
    expect(searchBodyText(null, null)).toBe("");
  });
  it("removes active, hidden and stylesheet text, including uppercase CSS", () => {
    expect(
      searchBodyText(null, "<style>body{display:none}</style><p>hidden</p>"),
    ).toBe("");
    expect(
      searchBodyText(null, "<style>*{display:none}</style><p>hidden</p>"),
    ).toBe("");
    expect(
      searchBodyText(
        null,
        `<style>.hide{DISPLAY:NONE}</style><p>visible</p><p class="hide">hidden</p><p hidden>hidden</p><p aria-hidden="true">hidden</p><script>active</script><template>active</template>`,
      ),
    ).toBe("visible");
  });
  it("neither executes HTML nor loads images/styles/frame resources", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end("trap");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No fixture address");
    const url = `http://127.0.0.1:${address.port}/resource`;
    try {
      expect(
        searchBodyText(
          null,
          `<link rel="stylesheet" href="${url}"><script>fetch('${url}')</script><style>@import '${url}'</style><img src="${url}"><iframe src="${url}"></iframe><p>visible text</p><a href="${url}">Link</a>`,
        ),
      ).toBe("visible text Link");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
