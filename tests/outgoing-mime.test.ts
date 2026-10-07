import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import {
  composeInput,
  parseOutgoingAddresses,
} from "@/modules/mail/domain/outgoing-message";
import { buildOutgoingMime } from "@/modules/mail/infrastructure/outgoing-mime";

describe("outgoing addresses and immutable MIME boundary", () => {
  it("includes explicit UTF-8 MIME metadata even for an empty body", async () => {
    const mime = await buildOutgoingMime({
      from: { address: "a@example.com" },
      to: [],
      cc: [],
      subject: "",
      plainText: "",
      messageId: "<empty@maildock.invalid>",
      createdAt: new Date(0),
    });
    expect(mime.toString()).toContain(
      "Content-Type: text/plain; charset=utf-8",
    );
    expect(mime.toString()).toContain("Content-Transfer-Encoding: base64");
  });
  it("parses display names, Polish names and recipient lists structurally", () => {
    expect(
      parseOutgoingAddresses(
        'Mateusz <foo@example.com>, "Łukasz Żółć" <lukasz@example.com>',
      ),
    ).toEqual([
      { name: "Mateusz", address: "foo@example.com" },
      { name: "Łukasz Żółć", address: "lukasz@example.com" },
    ]);
    expect(parseOutgoingAddresses("foo@example.com")).toEqual([
      { address: "foo@example.com" },
    ]);
    expect(parseOutgoingAddresses("")).toEqual([]);
  });
  it.each([
    "not-an-address",
    "foo@@example.com",
    "foo@example.com\r\nBcc: secret@example.com",
    "Name\n <a@example.com>",
    '"Unclosed <a@example.com>',
    "Name <a@example.com",
    "a@example.com>",
    "group: a@example.com;",
    "foo@example.com garbage",
    "Name <foo@example.com> garbage",
    "foo@example.com,",
  ])("rejects malformed or injected recipients: %s", (value) => {
    expect(() => parseOutgoingAddresses(value)).toThrow();
  });
  it("rejects injected subjects and client From", () => {
    const input = {
      accountId: "00000000-0000-4000-8000-000000000001",
      to: "a@example.com",
      subject: "Hello",
      plainText: "Body",
    };
    expect(() =>
      composeInput.parse({ ...input, from: "forged@example.com" }),
    ).toThrow();
    expect(() =>
      composeInput.parse({
        ...input,
        subject: "Hello\r\nBcc: secret@example.com",
      }),
    ).toThrow();
  });
  it("builds repeatable UTF-8 plain MIME with no Bcc and a fixed Message-ID and Date", async () => {
    const data = {
      from: { name: "Łukasz Żółć", address: "from@example.com" },
      to: [{ name: "Mateusz", address: "to@example.com" }],
      cc: [{ address: "cc@example.com" }],
      subject: "Zażółć gęślą jaźń",
      plainText: "Cześć!\nZażółć gęślą jaźń.\n",
      messageId: "<fixed@maildock.invalid>",
      createdAt: new Date("2026-10-01T10:00:00Z"),
    };
    const first = await buildOutgoingMime(data);
    expect(await buildOutgoingMime(data)).toEqual(first);
    const parsed = await simpleParser(first);
    expect(parsed.subject).toBe(data.subject);
    expect(parsed.text).toBe(data.plainText);
    expect(parsed.from?.value).toEqual([data.from]);
    expect(parsed.to).toMatchObject({ value: data.to });
    expect(parsed.cc).toMatchObject({ value: data.cc });
    expect(parsed.messageId).toBe(data.messageId);
    expect(parsed.date).toEqual(data.createdAt);
    expect(parsed.bcc).toBeUndefined();
    expect(first.toString()).toContain("Content-Transfer-Encoding: base64");
    expect(first.toString()).not.toMatch(/^Bcc:/im);
  });
});
