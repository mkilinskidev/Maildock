import { enqueueAttachment } from "@/modules/mail/infrastructure/attachment-jobs";
import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import {
  MailTransportRouter,
  GmailReceiveUnsupportedError,
  resolveReceiveTransport,
  assertAccountWork,
} from "@/modules/accounts/domain/receive-transport";
import {
  imapJobRevision,
  assertImapJob,
} from "@/modules/mail/infrastructure/receive-job-policy";
import { enqueueDelta } from "@/modules/mail/infrastructure/delta-sync-jobs";

const google = {
  providerType: "gmail_smtp",
  authMethod: "oauth2",
  oauthProviderId: "google",
  enabled: true,
  oauthStatus: "connected",
  workRevision: 9n,
};
const password = {
  ...google,
  providerType: "imap_smtp",
  authMethod: "password",
  oauthProviderId: null,
  oauthStatus: null,
};
function boss(account: Parameters<typeof assertAccountWork>[0] = google) {
  const send = vi.fn();
  return {
    send,
    getDb: () => ({
      executeSql: async () => ({
        rows: [
          {
            account_id: "00000000-0000-4000-8000-000000000001",
            provider_type: account.providerType,
            auth_method: account.authMethod,
            oauth_provider_id: account.oauthProviderId,
            enabled: account.enabled,
            oauth_status: account.oauthStatus,
            work_revision: account.workRevision.toString(),
          },
        ],
      }),
    }),
  } as unknown as PgBoss;
}
describe("P1 authoritative receiving policy", () => {
  it("admits current IMAP work and exposes discriminated provider identities", () => {
    const router = new MailTransportRouter();
    expect(() => router.requireImap(password, "9")).not.toThrow();
    expect(router.identity(password)).toEqual({
      kind: "imap",
      provider: "password",
    });
    expect(router.identity(google)).toEqual({
      kind: "gmail",
      provider: "google",
    });
  });
  it("routes Google OAuth to native Gmail", () =>
    expect(resolveReceiveTransport(google)).toBe("gmail"));
  it("routes Microsoft OAuth to IMAP", () =>
    expect(
      resolveReceiveTransport({
        ...google,
        providerType: "imap_smtp",
        oauthProviderId: "microsoft",
      }),
    ).toBe("imap"));
  it("routes password accounts to IMAP independently of domain", () =>
    expect(resolveReceiveTransport(password)).toBe("imap"));
  it.each([
    { ...google, providerType: "imap_smtp" },
    { ...google, authMethod: "password" },
    { ...google, oauthProviderId: "microsoft" },
    { ...password, oauthProviderId: "google" },
    { ...google, providerType: "unknown" },
  ])("rejects inconsistent persisted combinations", (account) =>
    expect(() => resolveReceiveTransport(account)).toThrow("Invalid account"),
  );
  it("fences disabled, disconnected and reconnected work", () => {
    expect(() => assertAccountWork({ ...google, enabled: false }, "9")).toThrow(
      "stale",
    );
    expect(() =>
      assertAccountWork({ ...google, oauthStatus: "reconnect_required" }, "9"),
    ).toThrow("stale");
    expect(() =>
      assertAccountWork({ ...google, workRevision: 10n }, "9"),
    ).toThrow("stale");
    expect(assertAccountWork(google, "9")).toBe("gmail");
  });
  it("rejects Google scheduling without enqueueing an IMAP job", async () => {
    const jobs = boss();
    await expect(
      enqueueDelta(jobs, "id", "mailbox", "poll"),
    ).rejects.toBeInstanceOf(GmailReceiveUnsupportedError);
    expect(jobs.send).not.toHaveBeenCalled();
  });
  it("fences attachment producers and captures their owning account revision", async () => {
    const googleJobs = boss();
    await enqueueAttachment(googleJobs, "attachment");
    expect(googleJobs.send).toHaveBeenCalledWith(
      "attachment-fetch-v1",
      {
        attachmentId: "attachment",
        accountId: "00000000-0000-4000-8000-000000000001",
        accountRevision: "9",
      },
      { singletonKey: "attachment" },
    );
    const disabled = boss({ ...google, enabled: false });
    await expect(enqueueAttachment(disabled, "attachment")).rejects.toThrow(
      "stale",
    );
    expect(disabled.send).not.toHaveBeenCalled();
    const imapJobs = boss(password);
    await enqueueAttachment(imapJobs, "attachment");
    expect(imapJobs.send).toHaveBeenCalledWith(
      "attachment-fetch-v1",
      {
        attachmentId: "attachment",
        accountId: "00000000-0000-4000-8000-000000000001",
        accountRevision: "9",
      },
      { singletonKey: "attachment" },
    );
  });
  it("rejects queued Google IMAP work and jobs without revision", async () => {
    await expect(
      assertImapJob(boss(), { accountId: "id", accountRevision: "9" }),
    ).rejects.toBeInstanceOf(GmailReceiveUnsupportedError);
    await expect(
      assertImapJob(boss(password), { accountId: "id" }),
    ).rejects.toThrow("stale");
  });
  it("rejects stale IMAP work after reconnect and admits the current revision", async () => {
    const jobs = boss(password);
    await expect(imapJobRevision(jobs, "id", "8")).rejects.toThrow("stale");
    expect(await imapJobRevision(jobs, "id", "9")).toBe("9");
  });
  it("provides typed unsupported operations and server-managed Sent without fallback", async () => {
    const router = new MailTransportRouter();
    const locator = {
      kind: "gmail" as const,
      accountId: "id",
      messageId: "opaque-9007199254740993",
    };
    expect(router.capabilities(google)).toMatchObject({
      receiveTransport: "gmail",
      moveMessages: true,
      serverManagedSent: true,
      remoteDrafts: false,
    });
    await expect(router.gmail.content(locator)).rejects.toBeInstanceOf(
      GmailReceiveUnsupportedError,
    );
    await expect(
      router.gmail.attachment({ kind: "gmail", message: locator, partId: "" }),
    ).rejects.toBeInstanceOf(GmailReceiveUnsupportedError);
    await expect(router.gmail.mutate(locator)).rejects.toBeInstanceOf(
      GmailReceiveUnsupportedError,
    );
  });
});
