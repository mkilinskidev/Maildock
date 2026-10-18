import { describe, expect, it } from "vitest";
import {
  ImapSmtpMailProvider,
  providerFailureDiagnostics,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import {
  MailProviderOperationError,
  type ProviderImapAccount,
} from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "fixture",
  imap: {
    host: "imap.invalid",
    port: 993,
    security: "tls",
    username: "fixture",
    credential: { kind: "password", password: "fixture" },
  },
};

function imapError(
  fields: Record<string, unknown>,
  message = "Command failed for owner@example.com",
) {
  return Object.assign(new Error(message), {
    responseText: "Private text for owner@example.com",
    ...fields,
  });
}

type Failure = Partial<
  Record<"mailboxOpen" | "search" | "fetch" | "batch", Error>
>;
async function runRecent(failure: Failure) {
  const provider = new ImapSmtpMailProvider({
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {},
      list: async () => [],
      mailboxOpen: async () => {
        if (failure.mailboxOpen) throw failure.mailboxOpen;
        return { uidValidity: 7n };
      },
      mailboxClose: async () => true,
      logout: async () => {},
      close: () => {},
      search: async () => {
        if (failure.search) throw failure.search;
        return [1];
      },
      fetch: async function* () {
        if (failure.fetch) throw failure.fetch;
        yield {
          seq: 1,
          uid: 1,
          flags: new Set<string>(),
          size: 1,
          internalDate: new Date("2026-01-02"),
        };
      },
      download: async () => {
        throw new Error("forbidden");
      },
    }),
    createSmtp: () => {
      throw new Error("forbidden");
    },
  } satisfies ProtocolClientFactories);
  try {
    await provider.synchronizeRecentMailbox(
      account,
      { remotePath: "INBOX", cutoff: new Date("2026-01-01"), batchSize: 150 },
      {
        selected: async () => {},
        batch: async () => {
          if (failure.batch) throw failure.batch;
        },
      },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(MailProviderOperationError);
    return error as MailProviderOperationError;
  }
  throw new Error("Expected the synchronization to fail.");
}

describe("provider failure diagnostics", () => {
  it("keeps only fixed protocol tokens and never response text", () => {
    const diagnostics = providerFailureDiagnostics(
      imapError({
        responseStatus: "no",
        serverResponseCode: "unavailable",
        code: "ETHROTTLE",
      }),
    );
    expect(diagnostics).toEqual({
      imapStatus: "NO",
      imapResponseCode: "UNAVAILABLE",
      errorCode: "ETHROTTLE",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("example.com");
    expect(
      providerFailureDiagnostics({
        responseStatus: "OK",
        serverResponseCode: "owner@example.com",
        code: "a b",
      }),
    ).toEqual({});
    expect(providerFailureDiagnostics(null)).toEqual({});
  });

  it.each([
    [
      "a temporary server refusal while searching",
      {
        search: imapError({
          responseStatus: "NO",
          serverResponseCode: "UNAVAILABLE",
        }),
      },
      "server_unavailable",
      { phase: "search", imapStatus: "NO", imapResponseCode: "UNAVAILABLE" },
    ],
    [
      "throttling while downloading",
      { fetch: imapError({ code: "ETHROTTLE" }) },
      "server_unavailable",
      { phase: "fetch", errorCode: "ETHROTTLE" },
    ],
    [
      "a dropped connection while downloading",
      {
        fetch: imapError({ code: "NoConnection" }, "Connection not available"),
      },
      "connection_lost",
      { phase: "fetch", errorCode: "NoConnection" },
    ],
    [
      "a missing mailbox",
      {
        mailboxOpen: imapError({
          responseStatus: "NO",
          serverResponseCode: "NONEXISTENT",
        }),
      },
      "mailbox_unavailable",
      {
        phase: "open_mailbox",
        imapStatus: "NO",
        imapResponseCode: "NONEXISTENT",
      },
    ],
    [
      "a plain server rejection",
      { search: imapError({ responseStatus: "BAD" }) },
      "server_rejected",
      { phase: "search", imapStatus: "BAD" },
    ],
  ] as const)(
    "classifies %s with its phase",
    async (_name, failure, category, diagnostics) => {
      const error = await runRecent(failure);
      expect(error.category).toBe(category);
      expect(error.diagnostics).toEqual(diagnostics);
      expect(error.message).not.toContain("example.com");
      expect(JSON.stringify(error.diagnostics)).not.toContain("example.com");
    },
  );

  it("attributes failures while saving to Maildock instead of the server", async () => {
    const error = await runRecent({
      batch: imapError({ responseStatus: "NO", code: "ETHROTTLE" }),
    });
    expect(error.category).toBe("internal_error");
    expect(error.message).toBe("Saving synchronized messages failed.");
    expect(error.diagnostics).toEqual({ phase: "save" });
  });
});
