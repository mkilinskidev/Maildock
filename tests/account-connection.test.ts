import { expect, it, vi } from "vitest";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { OAuthProviderRegistry } from "@/modules/accounts/application/oauth-provider-registry";
import type { OAuthMailProvider } from "@/modules/accounts/domain/oauth-mail-provider";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import type { Database } from "@/shared/infrastructure/database/database";

function setup(kind: "google" | "microsoft" | "password") {
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 9).toString("base64"),
  });
  const id = "00000000-0000-4000-8000-000000000001";
  const row = {
    id,
    enabled: true,
    workRevision: 1n,
    providerType: kind === "google" ? "gmail_smtp" : "imap_smtp",
    authMethod: kind === "password" ? "password" : "oauth2",
    oauthProviderId: kind === "password" ? null : kind,
    oauthStatus: "connected",
    imapHost: "imap.example.test",
    imapPort: 993,
    imapSecurity: "tls",
    imapUsername: "owner@example.test",
    imapPassword: encryption.encrypt(
      "fixture",
      `maildock:account-credential:v1:${id}:imap`,
    ),
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    smtpSecurity: "tls",
    smtpUsername: "owner@example.test",
    smtpUsesImapCredentials: kind !== "google",
  };
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [row] }) }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        updates.push(value);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
  const connect = vi.fn(async () => undefined);
  const verify = vi.fn(async () => undefined);
  const send = vi.fn();
  const factories = {
    createImap: vi.fn(() => ({
      connect,
      logout: async () => undefined,
      close: vi.fn(),
      usable: true,
    })),
    createSmtp: vi.fn(() => ({ verify, close: vi.fn(), sendMail: send })),
  } as unknown as ProtocolClientFactories;
  const provider = new ImapSmtpMailProvider(factories);
  const accessToken = vi.fn(async () => "synthetic-token");
  const oauth = new OAuthProviderRegistry([
    { id: kind, accessToken } as unknown as OAuthMailProvider,
  ]);
  const gmail = {
    schedule: async () => true,
    test: vi.fn(async () => undefined),
  };
  const service = new AccountsService(
    db,
    encryption,
    provider,
    undefined,
    oauth,
    undefined,
    undefined,
    gmail,
  );
  return { id, service, connect, verify, send, gmail, updates, accessToken };
}
it.each(["google", "microsoft", "password"] as const)(
  "tests %s receiving and SMTP independently without sending or changing credentials",
  async (kind) => {
    const t = setup(kind);
    t.verify.mockRejectedValue(new Error("SMTP verification failed"));
    expect(await t.service.testExisting(t.id)).toMatchObject({
      imap: { success: true },
      smtp: { success: false },
    });
    expect(t.gmail.test).toHaveBeenCalledTimes(kind === "google" ? 1 : 0);
    expect(t.connect).toHaveBeenCalledTimes(kind === "google" ? 0 : 1);
    expect(t.verify).toHaveBeenCalledOnce();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.updates[0]).toMatchObject({
      imapStatus: "success",
      smtpStatus: "error",
    });
    expect(
      Object.keys(t.updates[0]).every(
        (key) => !/password|cache|host|port|policy/i.test(key),
      ),
    ).toBe(true);
  },
);
it("retains Gmail receive results if SMTP credential resolution throws", async () => {
  const t = setup("google");
  t.accessToken.mockRejectedValue(new Error("private-token"));
  const report = await t.service.testExisting(t.id);
  expect(report).toMatchObject({
    imap: { success: true },
    smtp: { success: false },
  });
  expect(JSON.stringify(report)).not.toContain("private-token");
});
it("still tests SMTP after Gmail receiving fails", async () => {
  const t = setup("google");
  t.gmail.test.mockRejectedValue(new Error("receive failed"));
  expect(await t.service.testExisting(t.id)).toMatchObject({
    imap: { success: false },
    smtp: { success: true },
  });
  expect(t.verify).toHaveBeenCalledOnce();
  expect(t.send).not.toHaveBeenCalled();
});
