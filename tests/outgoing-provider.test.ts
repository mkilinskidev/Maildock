import { describe, expect, it, vi } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderConnection } from "@/modules/accounts/domain/mail-provider";

const smtp: ProviderConnection = {
  host: "smtp.example.com",
  port: 465,
  security: "tls",
  username: "owner",
  credential: { kind: "password", password: "private-secret" },
};
function provider(verifyError?: unknown, sendError?: unknown) {
  const raw = Buffer.from(
    "Message-ID: <stable@maildock.invalid>\r\n\r\nimmutable MIME",
  );
  const envelope = {
    from: "owner@example.com",
    to: ["to@example.com", "hidden@example.com"],
  };
  const sendMail = vi.fn(async () => {
    if (sendError) throw sendError;
    return { accepted: envelope.to, rejected: [] };
  });
  const close = vi.fn();
  const instance = new ImapSmtpMailProvider({
    createSmtp: () => ({
      verify: async () => {
        if (verifyError) throw verifyError;
      },
      sendMail,
      close,
    }),
  } as unknown as ProtocolClientFactories);
  return {
    run: () =>
      instance.deliverMessage({ accountId: "account", smtp }, envelope, raw),
    sendMail,
    close,
    raw,
    envelope,
  };
}
describe("SMTP certainty boundary", () => {
  it("delivers raw snapshot and envelope including Bcc without compose fields", async () => {
    const test = provider();
    expect(await test.run()).toEqual({
      outcome: "accepted",
      acceptedCount: 2,
      rejectedCount: 0,
    });
    expect(test.sendMail).toHaveBeenCalledExactlyOnceWith({
      envelope: test.envelope,
      raw: test.raw,
      messageId: "<stable@maildock.invalid>",
    });
    expect(test.close).toHaveBeenCalledOnce();
  });
  it.each(["ETIMEDOUT", "ECONNREFUSED", "EDNS"])(
    "allows safe retries of %s during verification only",
    async (code) => {
      const test = provider({ code });
      expect(await test.run()).toMatchObject({
        outcome: "definite_failure",
        retryable: true,
      });
      expect(test.sendMail).not.toHaveBeenCalled();
    },
  );
  it.each(["EAUTH", "CERT_HAS_EXPIRED", "UNKNOWN"])(
    "does not retry permanent/unknown verification failure %s",
    async (code) => {
      const test = provider({
        code,
        message: "private-secret hidden@example.com",
      });
      const result = await test.run();
      expect(result).toMatchObject({
        outcome: "definite_failure",
        retryable: false,
      });
      expect(JSON.stringify(result)).not.toMatch(
        /private-secret|hidden@example/,
      );
      expect(test.sendMail).not.toHaveBeenCalled();
    },
  );
  it.each([
    { command: "CONN", code: "ETIMEDOUT" },
    { command: "DATA", responseCode: 550 },
    {},
    { code: "EAUTH" },
  ])(
    "conservatively treats unproven submission failure as uncertain: %j",
    async (failure) => {
      expect(await provider(undefined, failure).run()).toEqual({
        outcome: "uncertain",
      });
    },
  );
  it.each(["MAIL FROM", "RCPT TO"])(
    "recognizes permanent explicit pre-DATA rejection: %s",
    async (command) => {
      expect(
        await provider(undefined, { command, responseCode: 550 }).run(),
      ).toMatchObject({ outcome: "definite_failure", retryable: false });
    },
  );
});
