import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailDeltaConnectionExperiment } from "@/modules/accounts/infrastructure/gmail-delta-connection-experiment";
import {
  ImapSmtpMailProvider,
  imapOptions,
  smtpOptions,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { guardImapClient } from "@/modules/accounts/infrastructure/imap-client-lifecycle";
import { createImapSessionDiagnostics } from "@/modules/accounts/infrastructure/imap-session-diagnostics";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";

afterEach(() => vi.useRealTimers());

function pendingClient() {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  return {
    connect: vi.fn(() => pending),
    close: vi.fn(() => reject(new Error("transport closed"))),
  };
}

describe("bounded Gmail delta connection experiment", () => {
  it("closes a silent initialization at the absolute 60-second deadline and clears timers", async () => {
    vi.useFakeTimers();
    const owner = new GmailDeltaConnectionExperiment();
    const client = pendingClient();
    const diagnostics = vi.fn();
    const work = owner.connect(client, undefined, diagnostics);
    const rejected = expect(work).rejects.toMatchObject({
      code: "CONNECT_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(client.close).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["worker", "job"])(
    "cancels pending login on %s shutdown without leaving work behind",
    async (source) => {
      vi.useFakeTimers();
      const owner = new GmailDeltaConnectionExperiment();
      const job = new AbortController();
      const client = pendingClient();
      const work = owner.connect(client, job.signal);
      const rejected = expect(work).rejects.toMatchObject({
        code: "ABORT_ERR",
      });
      await vi.advanceTimersByTimeAsync(0);
      if (source === "worker") owner.stop();
      else job.abort();
      await rejected;
      expect(client.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not start after shutdown, and can resume on readiness recovery", async () => {
    const owner = new GmailDeltaConnectionExperiment();
    owner.stop();
    const client = { connect: vi.fn(async () => {}), close: vi.fn() };
    await expect(owner.connect(client)).rejects.toMatchObject({
      code: "ABORT_ERR",
    });
    expect(client.connect).not.toHaveBeenCalled();
    owner.start();
    await owner.connect(client);
    expect(client.connect).toHaveBeenCalledOnce();
    const closed = client.close.mock.calls.length;
    owner.stop();
    expect(client.close.mock.calls.length).toBe(closed);
  });

  it("enables only Google OAuth delta; SMTP, content, discovery and other providers retain their budgets", async () => {
    const captured: ImapFlowOptions[] = [];
    const clients: EventEmitter[] = [];
    const factories = {
      createImap: (options: ImapFlowOptions) => {
        captured.push(options);
        const client = Object.assign(new EventEmitter(), {
          connect: vi.fn(async () => {}),
          mailboxOpen: vi.fn(async () => {
            throw new Error("stop after connection");
          }),
          list: vi.fn(async () => []),
          logout: vi.fn(async () => {}),
          close: vi.fn(),
          capabilities: new Map(),
          enabled: new Set(),
        });
        clients.push(client);
        return client as unknown as ReturnType<
          ProtocolClientFactories["createImap"]
        >;
      },
      createSmtp: vi.fn(),
    } satisfies ProtocolClientFactories;
    const provider = new ImapSmtpMailProvider(factories);
    const account: ProviderImapAccount = {
      accountId: "fixture",
      oauthProviderId: "google",
      imap: {
        host: "imap.gmail.com",
        port: 993,
        security: "tls",
        username: "fixture",
        credential: { kind: "oauth2", accessToken: "private-token" },
      },
    };
    for (const input of [
      account,
      { ...account, oauthProviderId: "microsoft" },
      {
        ...account,
        imap: {
          ...account.imap,
          credential: { kind: "password", password: "fixture" } as const,
        },
      },
    ]) {
      await expect(
        provider.synchronizeDeltaMailbox(input, "INBOX", 100, {} as never),
      ).rejects.toThrow();
    }
    expect(captured.map((x) => x.oauthAuthenticationTimeout)).toEqual([
      60_000,
      undefined,
      undefined,
    ]);
    await provider.listMailboxes(account);
    await expect(
      provider.fetchMessageContent(account, { uid: "1" } as never),
    ).rejects.toThrow();
    expect(
      captured
        .slice(3)
        .every((x) => x.oauthAuthenticationTimeout === undefined),
    ).toBe(true);
    expect(
      captured.every(
        (x) =>
          x.socketTimeout === 15_000 &&
          x.connectionTimeout === 10_000 &&
          x.greetingTimeout === 10_000,
      ),
    ).toBe(true);
    expect(imapOptions(account.imap).socketTimeout).toBe(15_000);
    expect(smtpOptions(account.imap).socketTimeout).toBe(15_000);
    expect(clients).toHaveLength(5);
  });
});

async function authenticationFixture(
  authDelay: number,
  options: { socketTimeout: number; oauthAuthenticationTimeout?: number },
  Client: typeof ImapFlow = ImapFlow,
) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.write("* OK local fixture\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, command] = line.split(" ");
        if (command === "CAPABILITY")
          socket.write(
            `* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK done\r\n`,
          );
        else if (command === "AUTHENTICATE") {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!socket.destroyed) socket.write(`${tag} OK authenticated\r\n`);
          }, authDelay);
          timers.add(timer);
        } else if (command === "LIST")
          socket.write(`* LIST () "/" ""\r\n${tag} OK done\r\n`);
        // NOOP is intentionally left unanswered to verify timeout restoration.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  const entries: Record<string, unknown>[] = [];
  const diagnostics = createImapSessionDiagnostics(
    { operation: "delta_sync", initializationDeadlineMs: 60_000 },
    options,
    (entry) => entries.push(entry),
  );
  const client = guardImapClient(
    new Client({
      host: "127.0.0.1",
      port: address.port,
      secure: false,
      doSTARTTLS: false,
      logger: diagnostics.logger,
      connectionTimeout: 2_000,
      greetingTimeout: 2_000,
      auth: { user: "fixture", accessToken: "private-token" },
      ...options,
    }),
    diagnostics,
  );
  return {
    client,
    entries,
    close: async () => {
      client.close();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("accepts a real 20-second OAuth response, beyond the old 15-second limit", async () => {
  const fixture = await authenticationFixture(20_000, {
    socketTimeout: 15_000,
    oauthAuthenticationTimeout: 60_000,
  });
  try {
    await fixture.client.connect();
    expect(fixture.client.authenticated).toBeTruthy();
    expect(fixture.entries).toContainEqual(
      expect.objectContaining({
        event: "mail.imap_authentication_slow",
        oauthAuthenticationTimeoutMs: 60_000,
      }),
    );
    expect(JSON.stringify(fixture.entries)).not.toContain("private-token");
  } finally {
    await fixture.close();
  }
}, 30_000);

it.each([
  ["ESM", ImapFlow],
  [
    "CommonJS",
    (
      createRequire(import.meta.url)("imapflow") as {
        ImapFlow: typeof ImapFlow;
      }
    ).ImapFlow,
  ],
] as const)(
  "%s restores the ordinary watchdog after OAuth, and leaves the default OAuth budget unchanged",
  async (_name, Client) => {
    const extended = await authenticationFixture(
      150,
      {
        socketTimeout: 100,
        oauthAuthenticationTimeout: 1_000,
      },
      Client,
    );
    try {
      await extended.client.connect();
      await expect(extended.client.noop()).rejects.toMatchObject({
        code: "ETIMEOUT",
      });
    } finally {
      await extended.close();
    }
    const baseline = await authenticationFixture(
      150,
      { socketTimeout: 100 },
      Client,
    );
    try {
      await expect(baseline.client.connect()).rejects.toMatchObject({
        code: "ETIMEOUT",
      });
    } finally {
      await baseline.close();
    }
  },
);
