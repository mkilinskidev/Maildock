import { describe, expect, it } from "vitest";
import { selectDisplayParts } from "@/modules/mail/domain/display-parts";
import type { RemoteMimePart } from "@/modules/accounts/domain/mail-provider";

function part(
  type: string,
  id: string | null,
  children: RemoteMimePart[] = [],
  extra: Partial<RemoteMimePart> = {},
): RemoteMimePart {
  return {
    type,
    part: id,
    children,
    disposition: null,
    filename: null,
    encoding: null,
    size: null,
    contentId: null,
    parameters: {},
    dispositionParameters: {},
    ...extra,
  };
}
const plain = (id: string) => part("text/plain", id);
const html = (id: string) => part("text/html", id);
const ids = (root: RemoteMimePart | null) =>
  selectDisplayParts(root).map((item) => item.part);

describe("display MIME selection", () => {
  it("selects individual plain and HTML bodies", () => {
    expect(ids(plain("1"))).toEqual(["1"]);
    expect(ids(html("1"))).toEqual(["1"]);
    expect(ids(part("text/plain", null))).toEqual(["1"]);
    expect(ids(part("text/html", null))).toEqual(["1"]);
  });
  it("keeps plain fallback and preferred HTML in alternatives", () => {
    expect(
      ids(part("multipart/alternative", null, [plain("1"), html("2")])),
    ).toEqual(["1", "2"]);
    expect(
      ids(
        part("multipart/alternative", null, [
          plain("1"),
          plain("2"),
          html("3"),
        ]),
      ),
    ).toEqual(["2", "3"]);
  });
  it("follows the body branch in mixed and nested multiparts", () => {
    const alternative = part("multipart/alternative", "1", [
      plain("1.1"),
      html("1.2"),
    ]);
    expect(
      ids(
        part("multipart/mixed", null, [
          alternative,
          part("application/pdf", "2", [], { disposition: "attachment" }),
        ]),
      ),
    ).toEqual(["1.1", "1.2"]);
  });
  it("never promotes attached text, images, or CID resources", () => {
    expect(
      ids(
        part("multipart/mixed", null, [
          plain("1"),
          part("text/plain", "2", [], { filename: "notes.txt" }),
          part("image/png", "3", [], { contentId: "cid" }),
        ]),
      ),
    ).toEqual(["1"]);
    expect(
      ids(
        part("multipart/mixed", null, [
          part("text/plain", "1", [], { disposition: "attachment" }),
          html("2"),
        ]),
      ),
    ).toEqual(["2"]);
  });
  it("rejects unusable, malformed, and missing part identities", () => {
    expect(ids(null)).toEqual([]);
    expect(
      ids(part("text/html", null, [], { disposition: "attachment" })),
    ).toEqual([]);
    expect(ids(part("text/plain", "1;UID EXPUNGE"))).toEqual([]);
    expect(
      ids(part("multipart/mixed", null, [part("application/zip", "1")])),
    ).toEqual([]);
  });
  it("uses the last valid alternative without downloading duplicate branches", () => {
    expect(
      ids(
        part("multipart/alternative", null, [
          html("1"),
          part("multipart/alternative", "2", [plain("2.1"), html("2.2")]),
        ]),
      ),
    ).toEqual(["2.1", "2.2"]);
  });
});
