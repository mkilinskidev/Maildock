import { createServer, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { createImapSessionDiagnostics } from "@/modules/accounts/infrastructure/imap-session-diagnostics";
import { guardImapClient } from "@/modules/accounts/infrastructure/imap-client-lifecycle";
import { providerFailureDiagnostics } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { safeDiagnosticDetails } from "@/modules/diagnostics/domain/application-event";

function setup(accountId = "diagnostic-fixture") {
  let time = 0;
  const entries: Record<string, unknown>[] = [];
  const diagnostics = createImapSessionDiagnostics(
    { accountId, operation: "delta_sync" },
    {
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    },
    (entry) => entries.push(entry),
    () => time,
  );
  return {
    diagnostics,
    entries,
    at: (value: number) => {
      time = value;
    },
  };
}

describe("IMAP session timeout diagnostics", () => {
  it("reports the pending command and timings without protocol text or credentials", () => {
    const { diagnostics: d, entries, at } = setup();
    try {
      d.logger.info({
        src: "connection",
        secure: true,
        address: "private-host",
      });
      at(20);
      d.logger.debug({ src: "c", msg: "1 CAPABILITY" });
      at(30);
      d.logger.debug({ src: "s", msg: "* CAPABILITY IMAP4rev1 AUTH=XOAUTH2" });
      d.logger.debug({ src: "s", msg: "1 OK private server response" });
      at(40);
      d.logger.debug({ src: "c", msg: "2 AUTHENTICATE XOAUTH2 private-token" });
      at(50);
      d.logger.debug({ src: "s", msg: "+ private-oauth-error" });
      at(60);
      d.logger.debug({ src: "c", msg: "private-continuation" });
      at(15_060);
      d.failure(
        Object.assign(new Error("private-error"), {
          code: "ETIMEOUT",
          response: "private-response",
        }),
      );
      const actualError = { code: "ETIMEOUT" };
      d.failure(actualError);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        event: "mail.imap_session_timeout",
        pendingCommand: "AUTHENTICATE",
        commandDurationMs: 15_020,
        lastCompletedCommand: "CAPABILITY",
        lastCompletedCommandDurationMs: 10,
        sinceLastSendMs: 15_000,
        sinceLastReceiveMs: 15_010,
        tlsEstablished: true,
        authenticated: false,
        compressionEnabled: false,
        activeAccountSessionsInProcess: 1,
        socketTimeoutMs: 15_000,
      });
      expect(JSON.stringify(entries)).not.toContain("private-");
      expect(
        safeDiagnosticDetails(providerFailureDiagnostics(actualError)),
      ).toMatchObject({
        imapSessionId: entries[0].imapSessionId,
        errorCode: "ETIMEOUT",
      });
      expect(
        providerFailureDiagnostics({
          code: "ETIMEOUT",
          imapSessionId: "private-injected-id",
        }),
      ).toEqual({ errorCode: "ETIMEOUT" });
    } finally {
      d.close();
    }
  });

  it("tracks completed compression and UID commands, and releases account counters once", () => {
    const first = setup("counter-fixture"),
      second = setup("counter-fixture");
    try {
      first.diagnostics.logger.info({
        src: "auth",
        msg: "User authenticated",
        user: "private-user",
      });
      first.diagnostics.logger.debug({ src: "c", msg: "3 COMPRESS DEFLATE" });
      first.diagnostics.logger.debug({
        src: "s",
        msg: "3 OK compression enabled",
      });
      first.diagnostics.logger.debug({
        src: "c",
        msg: "4 UID SEARCH ALL private-folder",
      });
      second.diagnostics.logger.debug({ msg: "Connection closed" });
      second.diagnostics.close();
      first.diagnostics.failure({ code: "ETIMEOUT" });
      expect(first.entries[0]).toMatchObject({
        pendingCommand: "SEARCH",
        lastCompletedCommand: "COMPRESS",
        compressionEnabled: true,
        authenticated: true,
        activeAccountSessionsInProcess: 1,
      });
      expect(JSON.stringify(first.entries)).not.toContain("private-");
    } finally {
      first.diagnostics.close();
      second.diagnostics.close();
    }
  });

  it("never serializes arbitrary error codes, commands, server text or logger failures", () => {
    const { diagnostics: d, entries } = setup();
    try {
      d.logger.debug({ src: "c", msg: "1 PRIVATE private-token" });
      d.failure({ code: "private-code" });
      expect(entries).toEqual([]);
      d.failure({ code: "CONNECT_TIMEOUT" });
      expect(entries[0].pendingCommand).toBeUndefined();
      expect(JSON.stringify(entries)).not.toContain("private-");
    } finally {
      d.close();
    }
    const broken = createImapSessionDiagnostics(
      { operation: "connection_test" },
      {},
      () => {
        throw new Error("sink unavailable");
      },
    );
    expect(() => broken.failure({ code: "ETIMEOUT" })).not.toThrow();
    broken.close();
  });

  it("identifies a real ImapFlow timeout during AUTHENTICATE on a local fixture", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("* OK local fixture ready\r\n");
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let end: number;
        while ((end = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const [tag, command] = line.split(" ");
          if (command === "CAPABILITY")
            socket.write(
              `* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK capability done\r\n`,
            );
          // Deliberately leave AUTHENTICATE unanswered; no external mail server.
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const entries: Record<string, unknown>[] = [];
    const d = createImapSessionDiagnostics(
      { accountId: "local-fixture", operation: "delta_sync" },
      { socketTimeout: 100 },
      (entry) => entries.push(entry),
    );
    const client = guardImapClient(
      new ImapFlow({
        host: "127.0.0.1",
        port: address.port,
        secure: false,
        doSTARTTLS: false,
        connectionTimeout: 2_000,
        greetingTimeout: 2_000,
        socketTimeout: 100,
        auth: { user: "private-user", accessToken: "private-token" },
        logger: d.logger,
        logRaw: false,
        emitLogs: false,
      }),
      d,
    );
    try {
      await expect(client.connect()).rejects.toMatchObject({
        code: "ETIMEOUT",
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        pendingCommand: "AUTHENTICATE",
        lastCompletedCommand: "CAPABILITY",
        errorCode: "ETIMEOUT",
        authenticated: false,
      });
      expect(JSON.stringify(entries)).not.toContain("private-");
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
