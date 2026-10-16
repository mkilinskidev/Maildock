import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ImapFlow, type ImapFlowOptions } from "imapflow";

export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(predicate: () => boolean, timeout = 1500) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= end)
      throw new Error("Fixture barrier deadline exceeded");
    await delay(2);
  }
}
export type Command = {
  connection: number;
  tag: string;
  command: string;
  startMs: number;
  taggedMs: number | null;
  bytesSent: number;
};
export type Peer = {
  id: number;
  socket: Socket;
  idleTag?: string;
  send: (data: string | Buffer, command?: Command) => void;
  ok: (command: Command, status?: string) => void;
  later: (ms: number, callback: () => void) => void;
};
export type Handler = (peer: Peer, command: Command) => boolean;

/** Scripted protocol peer; actual installed ImapFlow parser, compiler and TCP. */
export async function fixture(
  handler: Handler,
  options: Partial<ImapFlowOptions> = {},
  greeting: "PREAUTH" | "OK" = "PREAUTH",
  capabilities = "IMAP4rev1 IDLE",
) {
  const origin = performance.now();
  const now = () => performance.now() - origin;
  const commands: Command[] = [];
  const peers: Peer[] = [];
  const clients: ImapFlow[] = [];
  const tasks = new Set<ReturnType<typeof setTimeout>>();
  const events: {
    event: string;
    connection: number;
    ms: number;
    detail?: unknown;
  }[] = [];
  const sockets = new Set<Socket>();
  const accept = (socket: Socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const peer: Peer = {
      id: peers.length + 1,
      socket,
      send(data, command) {
        if (socket.destroyed) {
          events.push({
            event: "late-write-discarded",
            connection: peer.id,
            ms: now(),
          });
          return;
        }
        if (command) command.bytesSent += Buffer.byteLength(data);
        socket.write(data);
      },
      ok(command, status = "OK Completed") {
        command.taggedMs = now();
        peer.send(`${command.tag} ${status}\r\n`, command);
      },
      later(ms, callback) {
        const task = setTimeout(() => {
          tasks.delete(task);
          callback();
        }, ms);
        tasks.add(task);
      },
    };
    peers.push(peer);
    events.push({ event: "server-open", connection: peer.id, ms: now() });
    socket.on("error", (error) =>
      events.push({
        event: "server-error",
        connection: peer.id,
        ms: now(),
        detail: error.message,
      }),
    );
    socket.on("end", () =>
      events.push({ event: "server-end", connection: peer.id, ms: now() }),
    );
    socket.on("close", () => {
      sockets.delete(socket);
      events.push({ event: "server-close", connection: peer.id, ms: now() });
    });
    peer.send(
      `* ${greeting} [CAPABILITY ${capabilities}] Disposable fixture\r\n`,
    );
    let input = "";
    socket.on("data", (data) => {
      input += data.toString("ascii");
      let boundary: number;
      while ((boundary = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, boundary);
        input = input.slice(boundary + 2);
        const space = line.indexOf(" ");
        const command: Command = {
          connection: peer.id,
          tag: line === "DONE" ? peer.idleTag! : line.slice(0, space),
          command: line === "DONE" ? line : line.slice(space + 1),
          startMs: now(),
          taggedMs: null,
          bytesSent: 0,
        };
        commands.push(command);
        if (handler(peer, command)) continue;
        if (command.command === "CAPABILITY")
          peer.send(`* CAPABILITY ${capabilities}\r\n`, command);
        else if (command.command === 'LIST "" ""')
          peer.send('* LIST () "/" ""\r\n', command);
        else if (
          command.command.startsWith("LIST ") ||
          command.command.startsWith("LSUB ")
        )
          peer.send('* LIST () "/" "INBOX"\r\n', command);
        else if (/^(SELECT|EXAMINE) /.test(command.command)) {
          peer.send(
            "* 16384 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [PERMANENTFLAGS (\\Seen \\*)] Flags\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT 16385] Next\r\n",
            command,
          );
          peer.ok(command, "OK [READ-WRITE] Selected");
          continue;
        } else if (command.command === "IDLE") {
          peer.idleTag = command.tag;
          peer.send("+ Idling\r\n", command);
          continue;
        } else if (command.command === "DONE") {
          peer.ok(command);
          continue;
        } else if (command.command === "LOGOUT") {
          peer.send("* BYE Closing\r\n", command);
          peer.ok(command);
          socket.end();
          continue;
        } else if (command.command !== "NOOP" && command.command !== "CLOSE") {
          peer.ok(command, "BAD Unsupported fixture command");
          continue;
        }
        peer.ok(command);
      }
    });
  };
  const tls = process.env.IMAP_EXPERIMENT_PLAINTEXT !== "1";
  const server = tls
    ? createTlsServer(
        {
          key: readFileSync(new URL("localhost-key.pem", import.meta.url)),
          cert: readFileSync(new URL("localhost-cert.pem", import.meta.url)),
        },
        accept,
      )
    : createServer(accept);
  // TLS 'secureConnection' is too late to own every accepted transport. A
  // cancelled client can leave an unfinished handshake which server.close()
  // otherwise waits on until Node's handshake timeout. Track raw TCP as well.
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  async function connect() {
    const connection = clients.length + 1;
    const captureLog = (entry: unknown) => {
      const value = entry as { msg?: string; err?: Error & { code?: string } };
      events.push({
        event: "library-diagnostic",
        connection,
        ms: now(),
        detail: {
          message: value.msg,
          error: value.err?.message,
          code: value.err?.code,
        },
      });
    };
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: typeof address === "object" && address ? address.port : 0,
      secure: tls,
      tls: { rejectUnauthorized: false },
      doSTARTTLS: false,
      logger: {
        debug() {},
        info() {},
        trace() {},
        warn: captureLog,
        error: captureLog,
        fatal: captureLog,
      },
      disableAutoIdle: true,
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 2000,
      ...options,
    });
    clients.push(client);
    client.on("response", (response: { response: string }) => {
      const request = (
        client as unknown as { currentRequest?: { tag?: string } }
      ).currentRequest;
      events.push({
        event: "client-tagged-response",
        connection,
        ms: now(),
        detail: { tag: request?.tag, status: response.response },
      });
    });
    client.on("error", (error: Error & { code?: string }) =>
      events.push({
        event: "client-error",
        connection,
        ms: now(),
        detail: { message: error.message, code: error.code },
      }),
    );
    client.on("close", () =>
      events.push({ event: "client-close-event", connection, ms: now() }),
    );
    await client.connect();
    // Read-only observation of actual Node socket; never replace library methods.
    const socket = (client as unknown as { socket: Socket }).socket;
    socket.on("close", () =>
      events.push({ event: "native-socket-close", connection, ms: now() }),
    );
    socket.prependListener("data", (data) =>
      events.push({
        event: "received",
        connection,
        ms: now(),
        detail: data.length,
      }),
    );
    await client.mailboxOpen("INBOX");
    return client;
  }
  async function cleanup() {
    for (const task of tasks) clearTimeout(task);
    tasks.clear();
    for (const client of clients) client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  return {
    now,
    commands,
    peers,
    clients,
    events,
    connect,
    cleanup,
    endpoint: { host: "127.0.0.1", port: address.port, secure: tls },
  };
}

export function header(
  peer: Peer,
  command: Command,
  uid: number,
  content = Buffer.from("Subject: synthetic\r\n\r\n"),
) {
  peer.send(
    `* ${uid} FETCH (UID ${uid} BODY[HEADER] {${content.length}}\r\n`,
    command,
  );
  peer.send(content, command);
  peer.send(")\r\n", command);
}
