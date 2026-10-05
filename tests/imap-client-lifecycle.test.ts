import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import {
  MailProviderOperationError,
  type ProviderImapAccount,
} from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "test",
  imap: {
    host: "imap.test",
    port: 993,
    security: "tls",
    username: "test",
    credential: { kind: "password", password: "test" },
  },
};
const timeout = () =>
  Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" });
class Client extends EventEmitter {
  capabilities = new Map([
    ["MOVE", true],
    ["CONDSTORE", true],
  ]);
  enabled = new Set(["CONDSTORE"]);
  connect = vi.fn(async () => {
    expect(this.listenerCount("error")).toBe(1);
  });
  list = vi.fn(async () => []);
  mailboxOpen = vi.fn(async () => ({
    uidValidity: 7n,
    uidNext: 43,
    exists: 1,
  }));
  mailboxClose = vi.fn(async () => true);
  logout = vi.fn(async () => {});
  close = vi.fn(() => {});
  download = vi.fn(async () => {
    throw new Error("Unexpected download");
  });
  search = vi.fn(async () => [42]);
  fetch = async function* () {
    yield {
      uid: 42,
      flags: new Set<string>(),
      internalDate: new Date(),
      size: 1,
      envelope: {},
    };
  };
  fetchOne = vi.fn(async () => ({
    uid: 42,
    flags: new Set<string>(),
    modseq: 3n,
  }));
  messageFlagsAdd = vi.fn(async () => true);
  messageFlagsRemove = vi.fn(async () => true);
  messageMove = vi.fn(async () => ({
    uidValidity: 7n,
    uidMap: new Map([[42, 43]]),
  }));
  append = vi.fn(async () => ({ uidValidity: 7n, uid: 43 }));
}
function setup() {
  const client = new Client();
  const provider = new ImapSmtpMailProvider({
    createImap: () =>
      client as unknown as ReturnType<ProtocolClientFactories["createImap"]>,
    createSmtp: () => {
      throw new Error("Unexpected SMTP");
    },
  });
  return { client, provider };
}
const request = { sourcePath: "INBOX", uidValidity: "7", uid: "42" };

describe("provider-owned short-lived IMAP lifecycle", () => {
  it("survives a real ImapFlow error event in a child process and fails the owner operation", async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/imap-error-child.ts", import.meta.url),
        ),
      ],
      { cwd: process.cwd(), timeout: 20_000 },
    );
    expect(stdout).toContain("operation failed safely; process survived");
    expect(stderr).not.toContain("Unhandled");
  });
  it("fails safely on an asynchronous timeout during FETCH", async () => {
    const { client, provider } = setup();
    client.fetch = async function* () {
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          client.emit("error", timeout());
          resolve();
        }),
      );
      yield {
        uid: 42,
        flags: new Set<string>(),
        internalDate: new Date(),
        size: 1,
        envelope: {},
      };
    };
    await expect(
      provider.synchronizeRecentMailbox(
        account,
        { remotePath: "INBOX", cutoff: new Date(), batchSize: 10 },
        {
          selected: async () => {},
          batch: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
    expect(client.close).toHaveBeenCalled();
  });
  it("observes an error between protocol calls without issuing another command", async () => {
    const { client, provider } = setup();
    await expect(
      provider.synchronizeRecentMailbox(
        account,
        { remotePath: "INBOX", cutoff: new Date(), batchSize: 10 },
        {
          selected: async () => {
            client.emit("error", timeout());
          },
          batch: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
    expect(client.search).not.toHaveBeenCalled();
  });
  it("observes an error during the last application sink before reporting success", async () => {
    const { client, provider } = setup();
    await expect(
      provider.synchronizeRecentMailbox(
        account,
        { remotePath: "INBOX", cutoff: new Date(), batchSize: 10 },
        {
          selected: async () => {},
          batch: async () => {
            client.emit("error", timeout());
          },
        },
      ),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
  });
  it("continues to propagate awaited protocol failures", async () => {
    const { client, provider } = setup();
    client.list.mockRejectedValueOnce(timeout());
    await expect(provider.listMailboxes(account)).rejects.toBeInstanceOf(
      MailProviderOperationError,
    );
  });
  it("fails backfill when the final sink receives an asynchronous client failure", async () => {
    const { client, provider } = setup();
    await expect(
      provider.synchronizeBackfillMailbox(
        account,
        {
          remotePath: "INBOX",
          frontier: "42",
          chunkSize: 10,
        },
        {
          selected: async () => {},
          chunk: async () => {
            client.emit("error", timeout());
          },
        },
      ),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
  });
  it("reports a client error during the connection test", async () => {
    const { client } = setup();
    client.logout.mockImplementationOnce(async () => {
      client.emit("error", timeout());
    });
    const factories: ProtocolClientFactories = {
      createImap: () =>
        client as unknown as ReturnType<ProtocolClientFactories["createImap"]>,
      createSmtp: () => ({ verify: async () => {}, close: () => {} }),
    };
    expect(
      (
        await new ImapSmtpMailProvider(factories).testConnection({
          ...account,
          smtp: account.imap,
        })
      ).imap,
    ).toMatchObject({ success: false });
  });
  it.each([
    "mark_read",
    "mark_unread",
    "flag",
    "unflag",
    "archive",
    "trash",
  ] as const)(
    "preserves acknowledged %s through cleanup error events",
    async (action) => {
      const { client, provider } = setup();
      client.logout.mockImplementationOnce(async () => {
        client.emit("error", timeout());
      });
      expect(
        await provider.mutateMessage(account, {
          ...request,
          action,
          destinationPath: "Sent",
          modseq: "3",
        }),
      ).toMatchObject({ outcome: "applied" });
      expect(client.listenerCount("error")).toBe(1);
      // Late teardown events remain observed, and teardown is not recursive.
      client.emit("error", timeout());
    },
  );
  it("preserves an acknowledged APPEND despite cleanup failure", async () => {
    const { client, provider } = setup();
    client.logout.mockImplementationOnce(async () => {
      client.emit("error", timeout());
    });
    expect(
      await provider.appendMessage(
        account,
        { remotePath: "Sent", flags: ["\\Seen"], internalDate: new Date() },
        Buffer.from("test"),
      ),
    ).toMatchObject({ outcome: "saved", uid: "43" });
  });
  it("retains uncertain APPEND after a failure during transmission", async () => {
    const { client, provider } = setup();
    client.append.mockImplementationOnce(async () => {
      client.emit("error", timeout());
      throw timeout();
    });
    expect(
      await provider.appendMessage(
        account,
        { remotePath: "Sent", flags: [], internalDate: new Date() },
        Buffer.from("test"),
      ),
    ).toEqual({ outcome: "uncertain" });
    expect(client.append).toHaveBeenCalledTimes(1);
  });
  it.each(["password", "oauth2"] as const)(
    "uses the same lifecycle protection for %s credentials",
    async (kind) => {
      const { client, provider } = setup();
      client.list.mockImplementationOnce(async () => {
        client.emit("error", timeout());
        return [];
      });
      const imap = {
        ...account.imap,
        credential:
          kind === "password"
            ? { kind, password: "test" }
            : { kind, accessToken: "test" },
      };
      await expect(
        provider.listMailboxes({ ...account, imap }),
      ).rejects.toBeInstanceOf(MailProviderOperationError);
    },
  );
});
