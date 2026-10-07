import { normalizeMessage } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import {
  derivedBody,
  derivedSubject,
  replyRecipients,
  threading,
  safeAddresses,
  formatAddresses,
  type ReplySource,
} from "@/modules/mail/domain/reply-forward";
import {
  composeInput,
  parseOutgoingAddresses,
} from "@/modules/mail/domain/outgoing-message";
import { buildOutgoingMime } from "@/modules/mail/infrastructure/outgoing-mime";
const source: ReplySource = {
  from: [{ name: "Alice", address: "alice@example.com" }],
  sender: [],
  replyTo: [],
  to: [
    { address: "owner@example.com" },
    { name: "Team", address: "team@example.com" },
  ],
  cc: [{ address: "cc@example.com" }],
  subject: "Hello",
  rfcMessageId: "<original@example.com>",
  references: "<parent@example.com>",
  sentAt: new Date("2026-10-01T10:00:00Z"),
  internalDate: new Date("2026-10-01T10:01:00Z"),
};
describe("reply and forward derivation", () => {
  it("prefers valid Reply-To and falls back from malformed Reply-To to From", () => {
    expect(
      replyRecipients(
        { ...source, replyTo: [{ address: "reply@example.com" }] },
        "owner@example.com",
        false,
      ).to,
    ).toBe("reply@example.com");
    expect(
      replyRecipients(
        { ...source, replyTo: [{ address: "bad\r\nBcc: x" }] },
        "owner@example.com",
        false,
      ).to,
    ).toContain("alice@example.com");
    expect(replyRecipients(source, "owner@example.com", false).to).toContain(
      "alice@example.com",
    );
  });
  it("uses Sender only when From is unusable; reports no available recipient", () => {
    expect(
      replyRecipients(
        { ...source, from: [], sender: [{ address: "sender@example.com" }] },
        "owner@example.com",
        false,
      ).to,
    ).toBe("sender@example.com");
    expect(() =>
      replyRecipients(
        { ...source, from: [], replyTo: [] },
        "owner@example.com",
        false,
      ),
    ).toThrow("No usable reply recipient");
  });
  it("avoids self when other reply targets exist", () => {
    expect(
      replyRecipients(
        {
          ...source,
          replyTo: [
            { address: "OWNER@example.com" },
            { address: "reply@example.com" },
          ],
        },
        "owner@example.com",
        false,
      ).to,
    ).toBe("reply@example.com");
  });
  it("removes self and duplicates case-insensitively across To/Cc, using addresses rather than names", () => {
    const result = replyRecipients(
      {
        ...source,
        to: [
          ...source.to,
          { address: "ALICE@example.com", name: "Other name" },
          { address: "second@example.com", name: "Alice" },
        ],
        cc: [
          ...source.cc,
          { address: "TEAM@example.com" },
          { address: "OWNER@example.com" },
        ],
      },
      "OWNER@example.com",
      true,
    );
    expect(parseOutgoingAddresses(result.to).map((a) => a.address)).toEqual([
      "alice@example.com",
      "team@example.com",
      "second@example.com",
    ]);
    expect(parseOutgoingAddresses(result.cc)).toEqual([
      { address: "cc@example.com" },
    ]);
  });
  it("does not propagate Bcc and accepts reply-all with one recipient", () => {
    const original = {
      ...source,
      to: [],
      cc: [],
      bcc: [{ address: "secret@example.com" }],
    };
    expect(replyRecipients(original, "owner@example.com", true)).toEqual({
      to: '"Alice" <alice@example.com>',
      cc: "",
    });
  });
  it.each([
    ["Hello", "reply", "Re: Hello"],
    ["Re: Hello", "reply", "Re: Hello"],
    ["RE: Re: Hello", "reply_all", "Re: Hello"],
    ["Hello", "forward", "Fwd: Hello"],
    ["FWD: Hello", "forward", "Fwd: Hello"],
    ["", "reply", "Re: (No subject)"],
    [null, "forward", "Fwd: (No subject)"],
  ] as const)("derives subject %s %s", (subject, mode, expected) =>
    expect(derivedSubject(subject, mode)).toBe(expected),
  );

  it("captures folded References from existing synchronized metadata", () => {
    const result = normalizeMessage({
      seq: 1,
      uid: 1,
      size: 42,
      internalDate: new Date("2026-10-01T10:00:00Z"),
      headers: Buffer.from(
        "References: <parent@example.com>\r\n <newest@example.com>\r\nX-Other: private\r\n",
      ),
      flags: new Set(),
    });
    expect(result.envelope.references).toBe(
      "<parent@example.com> <newest@example.com>",
    );
    expect(result.envelope.references).not.toContain("private");
  });
  it("extends References, removes duplicate IDs and preserves a final source ID", () => {
    expect(threading(source, "reply")).toEqual({
      inReplyTo: source.rfcMessageId,
      references: ["<parent@example.com>", source.rfcMessageId],
    });
    expect(
      threading(
        {
          ...source,
          references:
            "<parent@example.com> <original@example.com> <original@example.com>",
        },
        "reply_all",
      ).references,
    ).toEqual(["<parent@example.com>", source.rfcMessageId]);
  });
  it("ignores malformed tokens without failing the reply", () => {
    expect(
      threading(
        {
          ...source,
          rfcMessageId: "<bad@example.com>\r\nX:evil",
          references: "invalid <bad> <ok@example.com> <broken\r\n@example.com>",
        },
        "reply",
      ),
    ).toEqual({ inReplyTo: null, references: ["<ok@example.com>"] });
  });
  it("bounds References count and length, retaining the relevant tail", () => {
    const references = Array.from(
      { length: 100 },
      (_, i) => `<${"x".repeat(180)}${i}@example.com>`,
    ).join(" ");
    const result = threading({ ...source, references }, "reply");
    expect(result.references.length).toBeLessThanOrEqual(30);
    expect(result.references.join(" ").length).toBeLessThanOrEqual(4000);
    expect(result.references.at(-1)).toBe(source.rfcMessageId);
  });

  it("preserves valid References when source Message-ID is missing", () =>
    expect(threading({ ...source, rfcMessageId: null }, "reply")).toEqual({
      inReplyTo: null,
      references: ["<parent@example.com>"],
    }));
  it("ignores invalid dot-atoms and domain labels", () =>
    expect(
      threading(
        {
          ...source,
          rfcMessageId: "<a..b@example.com>",
          references: "<a@bad..com> <a@-bad.com> <ok@example.com>",
        },
        "reply",
      ),
    ).toEqual({ inReplyTo: null, references: ["<ok@example.com>"] }));
  it("preserves a later useful display name without moving identity from To to Cc", () => {
    const result = replyRecipients(
      {
        ...source,
        from: [{ address: "alice@example.com" }],
        cc: [{ address: "ALICE@example.com", name: "Useful name" }],
      },
      "owner@example.com",
      true,
    );
    expect(parseOutgoingAddresses(result.to)[0]).toEqual({
      address: "alice@example.com",
      name: "Useful name",
    });
    expect(result.cc).toBe("");
  });
  it("omits threading on Forward", () =>
    expect(threading(source, "forward")).toEqual({
      inReplyTo: null,
      references: [],
    }));
  it("quotes every line, normalizes newlines and nests existing quotes", () => {
    expect(derivedBody(source, "line 1\r\n\r\n> previous", "reply")).toBe(
      '\n\nOn Thu, 01 Oct 2026 10:00:00 GMT, "Alice" <alice@example.com> wrote:\n> line 1\n> \n>> previous',
    );
  });
  it("forwards only the allowed headers and plain-text body", () => {
    const text = derivedBody(
      { ...source, subject: "Hello\r\nBcc: injected" },
      "Body",
      "forward",
    );
    expect(text).toContain("From:");
    expect(text).toContain("Date:");
    expect(text).toContain("To:");
    expect(text).toContain("Cc:");
    expect(text).not.toContain("\nBcc:");
    expect(text).not.toContain("Message-ID:");
    expect(text.endsWith("\n\nBody")).toBe(true);
  });
  it("sanitizes display names, validates addresses, and round-trips escaped names", () => {
    const addresses = safeAddresses([
      { name: 'Alice, "Team"\r\nInjected', address: "alice@example.com" },
      { address: "bad" },
    ]);
    expect(parseOutgoingAddresses(formatAddresses(addresses))).toEqual(
      addresses,
    );
  });
  it.each(["inReplyTo", "references"])("rejects browser supplied %s", (key) => {
    expect(
      composeInput.safeParse({
        accountId: "00000000-0000-4000-8000-000000000001",
        to: "to@example.com",
        subject: "",
        plainText: "",
        [key]: "<evil@example.com>",
      }).success,
    ).toBe(false);
  });
  it("extends deterministic MIME with threading and keeps its own stable Message-ID and Bcc privacy", async () => {
    const message = {
      from: { address: "owner@example.com" },
      to: [{ address: "alice@example.com" }],
      cc: [],
      subject: "Re: Hello",
      plainText: "Reply",
      messageId: "<new@maildock.invalid>",
      createdAt: source.sentAt!,
      ...threading(source, "reply"),
    };
    const bytes = await buildOutgoingMime(message);
    const parsed = await simpleParser(bytes);
    expect(bytes.equals(await buildOutgoingMime(message))).toBe(true);
    expect(parsed.messageId).toBe(message.messageId);
    expect(parsed.inReplyTo).toBe(source.rfcMessageId);
    expect(parsed.references).toEqual([
      "<parent@example.com>",
      source.rfcMessageId,
    ]);
    expect(parsed.bcc).toBeUndefined();
    await expect(
      buildOutgoingMime({
        ...message,
        inReplyTo: "<x@example.com>\r\nBcc:bad",
      }),
    ).rejects.toThrow("Invalid threading");
  });
});
