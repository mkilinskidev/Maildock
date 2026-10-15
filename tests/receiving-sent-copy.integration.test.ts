import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:tls";
import type { Socket } from "node:net";
import postgres from "postgres";
import { ImapFlow } from "imapflow";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import type { BlobStorage } from "@/shared/application/blob-storage";
import { SentCopyService } from "@/modules/mail/application/sent-copy-service";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { receivingTopologyHandlers } from "@/modules/mail/application/receiving-topology";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";

const originalMime = Buffer.from(
  'Message-ID: <r13@example.test>\r\nDate: Thu, 15 Oct 2026 10:00:00 +0000\r\nTo: Recipient <to@example.test>\r\nSubject: Immutable\r\nContent-Type: multipart/mixed; boundary="original"\r\n\r\n--original\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExact żółć\r\n--original\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--original--\r\n',
);
let mime = originalMime;
let storage: BlobStorage;

async function sentPeer(mode: string, lookup: number[] = [42]) {
  const capabilities = `IMAP4rev1 AUTH=PLAIN${mode === "no-uid" ? "" : " UIDPLUS"}${mode === "condstore" ? " ENABLE CONDSTORE" : ""}`;
  const sockets = new Set<Socket>();
  const commands: string[] = [],
    copies: Buffer[] = [];
  const server = createServer(
    {
      key: readFileSync(
        new URL(
          "../experiments/imap-transport/localhost-key.pem",
          import.meta.url,
        ),
      ),
      cert: readFileSync(
        new URL(
          "../experiments/imap-transport/localhost-cert.pem",
          import.meta.url,
        ),
      ),
    },
    (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.write(`* OK [CAPABILITY ${capabilities}] Sent fixture\r\n`);
      let input = Buffer.alloc(0),
        literal:
          | { size: number; tag: string; chunks: Buffer[]; received: number }
          | undefined;
      const send = (line: string) => socket.write(line + "\r\n");
      socket.on("data", (chunk) => {
        input = Buffer.concat([input, chunk]);
        while (input.length) {
          if (literal) {
            const take = Math.min(
              input.length,
              literal.size - literal.received,
            );
            if (take) literal.chunks.push(input.subarray(0, take));
            literal.received += take;
            input = input.subarray(take);
            if (literal.received < literal.size || input.length < 2) return;
            copies.push(Buffer.concat(literal.chunks, literal.size));
            input = input.subarray(2);
            if (mode === "lost") socket.destroy();
            else if (mode === "bad-uid")
              send(`${literal.tag} OK [APPENDUID 7 0] Invalid UID`);
            else if (mode === "uid-set")
              send(`${literal.tag} OK [APPENDUID 7 42:43] Invalid mapping`);
            else if (mode === "wrong-tag") {
              send(`${literal.tag}x OK [APPENDUID 7 42] Wrong tag`);
              socket.end();
            } else if (mode === "no") send(`${literal.tag} NO Cannot append`);
            else
              send(
                `${literal.tag} OK ${mode === "no-uid" ? "" : `[APPENDUID ${mode === "bad-epoch" ? 8 : 7} 42] `}Appended`,
              );
            literal = undefined;
            continue;
          }
          const end = input.indexOf("\r\n");
          if (end < 0) return;
          const line = input.subarray(0, end).toString();
          input = input.subarray(end + 2);
          const split = line.indexOf(" "),
            tag = line.slice(0, split),
            command = line.slice(split + 1);
          commands.push(command);
          const ok = () => send(`${tag} OK Completed`);
          if (command.startsWith("CAPABILITY")) {
            send(`* CAPABILITY ${capabilities}`);
            ok();
          } else if (/^(LOGIN|AUTHENTICATE)/.test(command)) ok();
          else if (command.startsWith("ENABLE")) {
            send("* ENABLED CONDSTORE");
            ok();
          } else if (command === 'LIST "" ""') {
            send('* LIST () "/" ""');
            ok();
          } else if (command.startsWith("LIST")) {
            send('* LIST (\\Sent) "/" "Sent"');
            ok();
          } else if (command.startsWith("EXAMINE")) {
            send("* 0 EXISTS");
            send("* FLAGS (\\Seen)");
            send("* OK [PERMANENTFLAGS (\\Seen \\*)] Flags");
            send(`* OK [UIDVALIDITY ${mode === "select-epoch" ? 8 : 7}] Epoch`);
            send("* OK [UIDNEXT 43] Next");
            if (mode === "condstore") send("* OK [HIGHESTMODSEQ 10] Highest");
            send(`${tag} OK [READ-ONLY] Selected`);
          } else if (command.startsWith("APPEND")) {
            const match = /\{([0-9]+)\}$/.exec(command);
            if (!match) {
              send(`${tag} BAD Literal required`);
              continue;
            }
            literal = { size: Number(match[1]), tag, chunks: [], received: 0 };
            send("+ Ready");
          } else if (command.startsWith("UID SEARCH")) {
            send(`* SEARCH${lookup.length ? " " + lookup.join(" ") : ""}`);
            ok();
          } else if (command.startsWith("UID FETCH")) {
            const body = mode === "different" ? Buffer.from("different") : mime;
            send(
              `* 1 FETCH (UID 42 FLAGS (\\Seen)${mode === "condstore" ? " MODSEQ (10)" : ""} BODY[] {${body.length}}`,
            );
            socket.write(body);
            send(")");
            ok();
          } else if (command === "LOGOUT") {
            send("* BYE");
            ok();
            socket.end();
          } else ok();
        }
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No peer address");
  return {
    commands,
    copies,
    port: address.port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("R13 owner routed Sent copy", () => {
  let container: StartedTestContainer,
    database: ReturnType<typeof createDatabase>,
    reader: postgres.Sql,
    executor: ReceivingExecutor;
  let account: string, mailbox: string, url: string, blobRoot: string;
  const cleanup: (() => Promise<unknown>)[] = [];
  beforeAll(async () => {
    blobRoot = await mkdtemp(path.join(tmpdir(), "maildock-r13-"));
    storage = new LocalBlobStorage(blobRoot);
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture-only",
        POSTGRES_DB: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const root = postgres(
      `postgres://fixture:fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/fixture`,
    );
    await root`create role lane login password 'lane-fixture-only'`;
    await root`create database r13 owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/r13`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    executor = new ReceivingExecutor(url, 2);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  }, 60000);
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
    account = randomUUID();
    mailbox = randomUUID();
    mime = Buffer.from(
      originalMime
        .toString()
        .replace("<r13@example.test>", `<${account}@example.test>`),
    );
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "R13",
      email: "r13@example.test",
      imapHost: "invalid.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyId: "fixture",
        iv: "fixture",
        ciphertext: "fixture",
        authTag: "fixture",
      },
      smtpHost: "invalid.test",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    await database.db.insert(mailboxes).values({
      id: mailbox,
      accountId: account,
      name: "Sent",
      remotePath: "Sent",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await reader`insert into mailbox_roles(account_id,role,mailbox_id,source) values(${account},'sent',${mailbox},'manual')`;
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
    if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
  });
  async function outgoing(policy = "maildock", blob = false) {
    const id = randomUUID();
    let blobId: string | null = null;
    if (blob) {
      blobId = randomUUID();
      const stored = await storage.put(
        (async function* () {
          yield mime;
        })(),
        mime.length,
      );
      await reader`insert into blobs(id,storage_key,size,sha256) values(${blobId},${stored.key},${stored.size},${stored.sha256})`;
    }
    await reader`insert into outgoing_messages(id,account_id,"from","to",cc,bcc,subject,plain_text,message_id,mime_base64,mime_blob_id,status,smtp_accepted_at,sent_copy_policy,sent_copy_status)
      values(${id},${account},'{}','[{}]','[]','[]','Immutable','Exact',${policy === "maildock" ? `<${account}@example.test>` : `<${id}@example.test>`},${blob ? null : mime.toString("base64")},${blobId},'sent','2026-10-15T10:00:00Z',${policy},${policy === "maildock" ? "pending" : "not_required"})`;
    return id;
  }
  async function row(id: string) {
    const [r] = await reader`select * from outgoing_messages where id=${id}`;
    return r;
  }
  async function harness(
    mode = "uid",
    matches?: number[],
    automatic = false,
    beforePublication?: () => Promise<void>,
    enroll = true,
  ) {
    const peer = await sentPeer(mode, matches);
    cleanup.push(() => peer.close());
    const connection = {
      host: "127.0.0.1",
      port: peer.port,
      security: "tls" as const,
      username: "fixture",
      credential: { kind: "password" as const, password: "fixture-only" },
    };
    let maxActive = 0;
    let sqlAtAppend = -1,
      claimAtAppend = false;
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      onAdmission: (admission) => {
        maxActive = Math.max(maxActive, admission.active);
      },
      tuning: { workers: 1 },
      loadAccount: async (_db, candidate) => ({ ...candidate, connection }),
      loadOperationConnection: async () => connection,
      operationHandlers: {
        ...receivingTopologyHandlers,
        append: { sentCopy: storage },
        store: { flags: true },
        "exact-lookup": { sentCopy: storage, flags: true },
      },
      createOperationClient: (options) => {
        const client = new ImapFlow({
          ...options,
          tls: { rejectUnauthorized: false },
        });
        if (beforePublication) {
          const retire = client.retireReceiving.bind(client);
          let once = true;
          client.retireReceiving = async () => {
            await retire();
            if (once) {
              once = false;
              await beforePublication();
            }
          };
        }
        const original = client.append.bind(client);
        client.append = async (...args) => {
          sqlAtAppend = executor.snapshot.executing;
          const [r] =
            await reader`select sent_copy_status,receiving_attempt from outgoing_messages where account_id=${account} order by created_at desc limit 1`;
          claimAtAppend =
            r.sent_copy_status === "saving" &&
            r.receiving_attempt.phase === "claimed";
          return original(...args);
        };
        return client;
      },
    });
    if (!automatic) coordinator.dispatchSentCopies = async () => {};
    cleanup.push(() => coordinator.stop());
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    expect(await coordinator.elect()).toBe(true);
    const [lease] =
      await reader`select owner,generation from receiving_coordinator`;
    const [state] =
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`;
    if (!state && enroll)
      await new ReceivingPersistence(executor).initialize(
        { actor: lease.owner, generation: BigInt(lease.generation) },
        mailbox,
        { complete: true, epoch: 7n, uidNext: 1n },
        { deadline: performance.now() + 5000 },
      );
    return {
      peer,
      coordinator,
      submit: (id: string, kind: "append" | "exact-lookup" = "append") =>
        coordinator.submit({
          ...(kind === "append"
            ? { kind: "append" as const, mimeBytes: mime.length }
            : { kind: "exact-lookup" as const, lookup: "sent-copy" as const }),
          pendingId: id,
          requestId: randomUUID(),
          deadline: performance.now() + 9000,
          identity: { account, mailbox, configurationVersion: 1n },
        }),
      counters: () => ({ sqlAtAppend, claimAtAppend, maxActive }),
    };
  }
  it("maildock saves one exact immutable MIME including attachment, Seen and original date", async () => {
    const id = await outgoing();
    const f = await harness();
    await f.submit(id);
    expect(f.peer.copies).toHaveLength(1);
    expect(f.peer.copies[0].length).toBe(mime.length);
    expect(createHash("sha256").update(f.peer.copies[0]).digest("hex")).toBe(
      createHash("sha256").update(mime).digest("hex"),
    );
    expect(f.peer.commands.filter((c) => c.startsWith("APPEND"))).toHaveLength(
      1,
    );
    expect(f.peer.commands.find((c) => c.startsWith("APPEND"))).toContain(
      "\\Seen",
    );
    expect(f.peer.commands.find((c) => c.startsWith("APPEND"))).toContain(
      "15-Oct-2026 10:00:00 +0000",
    );
    expect(f.counters()).toEqual({
      sqlAtAppend: 0,
      claimAtAppend: true,
      maxActive: 1,
    });
    expect(await row(id)).toMatchObject({
      status: "sent",
      sent_copy_status: "saved",
      sent_copy_uid: "42",
      sent_copy_uid_validity: "7",
      sent_copy_sync_pending: true,
    });
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.peer.copies).toHaveLength(1);
  });
  it("confirmed success without UIDPLUS remains saved with pending exact UID lookup", async () => {
    const id = await outgoing();
    const f = await harness("no-uid");
    await f.submit(id);
    expect(await row(id)).toMatchObject({
      status: "sent",
      sent_copy_status: "saved",
      sent_copy_uid: null,
      sent_copy_sync_pending: true,
    });
    await f.submit(id, "exact-lookup");
    expect(await row(id)).toMatchObject({
      sent_copy_status: "saved",
      sent_copy_uid: "42",
      sent_copy_sync_pending: true,
    });
    expect(f.peer.copies).toHaveLength(1);
  });
  it.each(["uid", "lost"])(
    "server snapshot produces zero APPEND even after retries and new owner (%s)",
    async (mode) => {
      const id = await outgoing("server");
      const f = await harness(mode);
      for (let i = 0; i < 2; i++) await expect(f.submit(id)).rejects.toThrow();
      await f.coordinator.stop();
      const next = await harness(mode);
      await expect(next.submit(id)).rejects.toThrow();
      expect(f.peer.copies).toHaveLength(0);
      expect(next.peer.copies).toHaveLength(0);
      expect(
        [...f.peer.commands, ...next.peer.commands].filter((c) =>
          c.startsWith("APPEND"),
        ),
      ).toHaveLength(0);
      expect(await row(id)).toMatchObject({
        sent_copy_status: "not_required",
        receiving_attempt: null,
        sent_copy_uid: null,
      });
    },
  );
  it("lost APPEND reply reconciles original UUID without a second APPEND", async () => {
    const id = await outgoing();
    const f = await harness("lost");
    await expect(f.submit(id)).rejects.toThrow();
    const first = await row(id);
    expect(first).toMatchObject({
      status: "sent",
      sent_copy_status: "uncertain",
    });
    await f.submit(id, "exact-lookup");
    const result = await row(id);
    expect(result.sent_copy_status).toBe("saved");
    expect(result.receiving_attempt.id).toBe(first.receiving_attempt.id);
    expect(f.peer.copies).toHaveLength(1);
  });
  it.each([{ matches: [42, 43] }, { matches: [] }, { matches: [42] }])(
    "ambiguous/absent/nonidentical lookup remains uncertain (%j)",
    async ({ matches }) => {
      const id = await outgoing();
      const f = await harness("lost");
      await expect(f.submit(id)).rejects.toThrow();
      await f.coordinator.stop();
      const next = await harness("different", matches);
      await next.submit(id, "exact-lookup");
      expect(await row(id)).toMatchObject({
        status: "sent",
        sent_copy_status: "uncertain",
        sent_copy_uid: null,
      });
      expect(next.peer.copies).toHaveLength(0);
    },
  );
  it("mismatched APPENDUID cannot publish a false UID or retry SMTP", async () => {
    const id = await outgoing();
    const f = await harness("bad-epoch");
    await expect(f.submit(id)).rejects.toThrow();
    expect(await row(id)).toMatchObject({
      status: "sent",
      attempts: 0,
      sent_copy_status: "uncertain",
      sent_copy_uid: null,
    });
    expect(f.peer.copies).toHaveLength(1);
  });
  it("changing account policy affects future snapshots only", async () => {
    const first = await outgoing();
    const server = await outgoing("server");
    await reader`update mail_accounts set sent_copy_policy='server' where id=${account}`;
    const f = await harness();
    await f.submit(first);
    await expect(f.submit(server)).rejects.toThrow();
    expect(f.peer.copies).toHaveLength(1);
    expect((await row(first)).sent_copy_policy).toBe("maildock");
    expect((await row(server)).sent_copy_policy).toBe("server");
  });
  it("default account policy is server", async () => {
    const [a] =
      await reader`select sent_copy_policy from mail_accounts where id=${account}`;
    expect(a.sent_copy_policy).toBe("server");
  });
  it("enrolled legacy runner cannot resolve credentials, APPEND or launch full-folder sync", async () => {
    const id = await outgoing();
    await harness();
    const accounts = {
      getProviderImapAccountForWork: vi.fn(),
    } as unknown as AccountsService;
    const provider = {
      appendMessage: vi.fn(),
      findSentCopy: vi.fn(),
    } as unknown as MailProvider;
    const sync = vi.fn();
    const service = new SentCopyService(
      database.db,
      accounts,
      provider,
      async (_id, work) => work(database.db),
      async () => {},
      sync,
    );
    await service.run(id);
    expect(accounts.getProviderImapAccountForWork).not.toHaveBeenCalled();
    expect(provider.appendMessage).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
  async function until(check: () => Promise<boolean>) {
    const end = performance.now() + 5000;
    while (!(await check())) {
      if (performance.now() > end) throw Error("R13 barrier expired");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  it("durable pending and sync-pending survive lost wakes and bounded discovery", async () => {
    const id = await outgoing();
    const f = await harness("uid", undefined, true);
    await f.coordinator.dispatchSentCopies();
    await until(async () => (await row(id)).sent_copy_status === "saved");
    expect(f.peer.copies).toHaveLength(1);
    expect((await row(id)).sent_copy_sync_pending).toBe(true);
  });
  it.each(["owner", "configuration", "role", "role-version"] as const)(
    "fences changed %s before result publication",
    async (change) => {
      const id = await outgoing();
      const f = await harness("uid", undefined, false, async () => {
        if (change === "owner") {
          await reader`update receiving_coordinator set expires_at='-infinity'`;
          await reader`select maildock_receiving_acquire(${randomUUID()}::uuid,60000)`;
        }
        if (change === "configuration")
          await reader`update mail_accounts set imap_host='replacement.test' where id=${account}`;
        if (change === "role")
          await reader`delete from mailbox_roles where account_id=${account} and role='sent'`;
        // The R07 topology result is the authority for a real path change. A
        // manual-role change is sufficient to invalidate the captured destination.
        if (change === "role-version")
          await reader`update mailbox_roles set updated_at=clock_timestamp() where account_id=${account} and role='sent'`;
      });
      await expect(f.submit(id)).rejects.toThrow();
      expect(await row(id)).toMatchObject({
        status: "sent",
        sent_copy_uid: null,
      });
      expect(f.peer.copies).toHaveLength(1);
    },
  );
  it("missing/unselectable destination leaves SMTP and original MIME intact", async () => {
    const id = await outgoing();
    const f = await harness();
    await reader`delete from mailbox_roles where account_id=${account} and role='sent'`;
    await expect(f.submit(id)).rejects.toThrow();
    expect(f.peer.copies).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      status: "sent",
      mime_base64: mime.toString("base64"),
      sent_copy_status: "failed",
    });
  });
  it.each(["claim", "result"] as const)(
    "recovers real lost %s COMMIT under conflicting locks",
    async (phase) => {
      let target = false,
        once = true;
      const relay = await receivingResponseRelay(url, (bytes) => {
        if (bytes.includes(Buffer.from("application_name"))) {
          relay.control.drop = false;
          target = false;
        }
        if (
          bytes.includes(
            Buffer.from(
              phase === "claim"
                ? "maildock_receiving_append_claim"
                : "maildock_receiving_append_result",
            ),
          )
        )
          target = true;
        if (once && target && bytes.includes(Buffer.from("commit\0"))) {
          relay.control.drop = true;
          once = false;
        }
      });
      cleanup.push(relay.close);
      await executor.stop();
      executor = new ReceivingExecutor(relay.url, 2);
      cleanup.push(async () => {
        await executor.stop();
        executor = new ReceivingExecutor(url, 2);
      });
      const id = await outgoing();
      const f = await harness();
      const pending = f.submit(id);
      void pending.catch(() => {});
      await until(
        async () =>
          (await row(id)).sent_copy_status ===
          (phase === "claim" ? "saving" : "saved"),
      );
      const held = await reader.reserve();
      await held`begin`;
      try {
        await held`select id from mailboxes where id=${mailbox} for update`;
        await until(
          async () =>
            (
              await reader`select exists(select from pg_stat_activity where datname='r13' and wait_event_type='Lock' and query like '%maildock_receiving_data_recover%') as waiting`
            )[0].waiting === true,
        );
        expect(f.peer.copies).toHaveLength(phase === "claim" ? 0 : 1);
      } finally {
        await held`commit`;
        held.release();
      }
      await pending;
      expect(once).toBe(false);
      expect(f.peer.copies).toHaveLength(1);
      expect((await row(id)).sent_copy_status).toBe("saved");
    },
  );
  it("transfers a real 25 MiB immutable storage snapshot within the original operation lifetime", async () => {
    mime = Buffer.concat([
      mime,
      Buffer.alloc(25 * 1024 * 1024 - mime.length, 65),
    ]);
    const id = await outgoing("maildock", true);
    const f = await harness();
    await f.submit(id);
    expect(f.peer.copies).toHaveLength(1);
    expect(f.peer.copies[0].length).toBe(mime.length);
    expect(createHash("sha256").update(f.peer.copies[0]).digest("hex")).toBe(
      createHash("sha256").update(mime).digest("hex"),
    );
    expect((await row(id)).sent_copy_status).toBe("saved");
    expect(f.counters().sqlAtAppend).toBe(0);
  });
  it("bounds reconciliation to three observations and retains original uncertain attempt", async () => {
    const id = await outgoing();
    const f = await harness("lost", []);
    await expect(f.submit(id)).rejects.toThrow();
    const original = (await row(id)).receiving_attempt.id;
    for (let n = 0; n < 3; n++) await f.submit(id, "exact-lookup");
    await expect(f.submit(id, "exact-lookup")).rejects.toThrow();
    const result = await row(id);
    expect(result.sent_copy_status).toBe("uncertain");
    expect(result.receiving_attempt.id).toBe(original);
    expect(result.receiving_attempt.observations).toBe(3);
    expect(f.peer.copies).toHaveLength(1);
    expect(
      f.peer.commands.filter((c) => c.startsWith("UID SEARCH")),
    ).toHaveLength(3);
  });
  it("does not downgrade an accepted no-UID copy when exact lookup is empty", async () => {
    const id = await outgoing();
    const f = await harness("no-uid", []);
    await f.submit(id);
    await f.submit(id, "exact-lookup");
    expect(await row(id)).toMatchObject({
      status: "sent",
      sent_copy_status: "saved",
      sent_copy_uid: null,
      sent_copy_sync_pending: true,
    });
    expect(f.peer.copies).toHaveLength(1);
  });
  it("missing physical MIME fails before APPEND and retains SMTP success", async () => {
    const id = await outgoing("maildock", true);
    const [blob] =
      await reader`select b.* from blobs b join outgoing_messages o on o.mime_blob_id=b.id where o.id=${id}`;
    await storage.delete(blob.storage_key);
    const f = await harness();
    await expect(f.submit(id)).rejects.toThrow();
    expect(await row(id)).toMatchObject({
      status: "sent",
      sent_copy_status: "failed",
      receiving_attempt: null,
    });
    expect(f.peer.copies).toHaveLength(0);
  });
  it("R07 enrolls selected Sent before APPEND without fetching folder history", async () => {
    const id = await outgoing();
    const f = await harness("uid", undefined, false, undefined, false);
    await f.coordinator.submit({
      kind: "select",
      role: "sent",
      requestId: randomUUID(),
      deadline: performance.now() + 9000,
      identity: { account, mailbox, configurationVersion: 1n },
    });
    const [selected] =
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`;
    await f.submit(id);
    const [after] =
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`;
    expect(after.fresh_through).toBe(selected.fresh_through);
    expect(after.history_before).toBe(selected.history_before);
    expect(after.reconcile_after).toBe(selected.reconcile_after);
    expect(
      f.peer.commands.filter(
        (c) => c.startsWith("UID FETCH") || c.startsWith("UID SEARCH"),
      ),
    ).toHaveLength(0);
    expect(f.peer.copies).toHaveLength(1);
  });
  it.each([false, true])(
    "clears sync-pending only after exact bytes and existing validated destination metadata agree (CONDSTORE=%s)",
    async (condstore) => {
      const id = await outgoing();
      const f = await harness(condstore ? "condstore" : "uid");
      await f.submit(id);
      const [lease] =
        await reader`select owner,generation from receiving_coordinator`;
      const [state] =
        await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`;
      await new ReceivingPersistence(executor).persist(
        { actor: lease.owner, generation: BigInt(lease.generation) },
        mailbox,
        {
          epoch: 7n,
          revision: BigInt(state.revision),
          freshThrough: BigInt(state.fresh_through),
          historyBefore: BigInt(state.history_before),
          reconcileAfter: BigInt(state.reconcile_after),
        },
        {
          kind: "fresh",
          evidence: {
            complete: true,
            epoch: 7n,
            low: 1n,
            high: 42n,
            searched: [42n],
            confirmedAbsent: [],
          },
          metadata: [
            {
              uid: "42",
              internalDate: "2026-10-15T10:00:00Z",
              size: String(mime.length),
              flags: ["\\Seen"],
              modseq: condstore ? "10" : undefined,
              hasAttachments: true,
              envelope: {
                messageId: `<${account}@example.test>`,
                subject: "Immutable",
                from: [],
                sender: [],
                replyTo: [],
                to: [{ name: "Recipient", address: "to@example.test" }],
                cc: [],
                bcc: [],
              },
            },
          ],
        },
        { deadline: performance.now() + 5000 },
      );
      await f.submit(id, "exact-lookup");
      expect(await row(id)).toMatchObject({
        sent_copy_status: "saved",
        sent_copy_uid: "42",
        sent_copy_uid_validity: "7",
        sent_copy_sync_pending: false,
      });
      expect(f.peer.copies).toHaveLength(1);
      const [count] =
        await reader`select count(*)::integer as count from mailbox_messages where mailbox_id=${mailbox}`;
      expect(count.count).toBe(1);
    },
  );
  it.each(["bad-uid", "uid-set", "wrong-tag", "no"])(
    "rejects %s protocol evidence without false mapping or SMTP replay",
    async (mode) => {
      const id = await outgoing();
      const f = await harness(mode);
      await expect(f.submit(id)).rejects.toThrow();
      expect(await row(id)).toMatchObject({
        status: "sent",
        attempts: 0,
        sent_copy_status: "uncertain",
        sent_copy_uid: null,
      });
      expect(f.peer.copies).toHaveLength(1);
    },
  );
  it("selected epoch mismatch fails before APPEND", async () => {
    const id = await outgoing();
    const f = await harness("select-epoch");
    await expect(f.submit(id)).rejects.toThrow();
    expect(await row(id)).toMatchObject({
      status: "sent",
      sent_copy_status: "failed",
      sent_copy_uid: null,
    });
    expect(f.peer.copies).toHaveLength(0);
  });
  it("duplicate admissions retain W=1 and account exclusion through socket and SQL retirement", async () => {
    const id = await outgoing();
    const f = await harness();
    const results = await Promise.allSettled([f.submit(id), f.submit(id)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(f.counters().maxActive).toBe(1);
    expect(f.peer.copies).toHaveLength(1);
    expect((await row(id)).sent_copy_status).toBe("saved");
  });
  it("a new elected owner reconciles the original attempt without another APPEND", async () => {
    const id = await outgoing();
    const old = await harness("lost");
    await expect(old.submit(id)).rejects.toThrow();
    const original = (await row(id)).receiving_attempt.id;
    await old.coordinator.stop();
    const next = await harness();
    await next.submit(id, "exact-lookup");
    expect((await row(id)).receiving_attempt.id).toBe(original);
    expect((await row(id)).sent_copy_status).toBe("saved");
    expect(old.peer.copies).toHaveLength(1);
    expect(next.peer.copies).toHaveLength(0);
  });
  it("manual Sent mapping wins over an automatic special-use candidate", async () => {
    const id = await outgoing();
    await database.db.insert(mailboxes).values({
      id: randomUUID(),
      accountId: account,
      name: "AutomaticSent",
      remotePath: "AutomaticSent",
      specialUse: ["\\Sent"],
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const f = await harness();
    await f.submit(id);
    expect((await row(id)).sent_copy_path).toBe("Sent");
    expect(f.peer.copies).toHaveLength(1);
    expect(f.peer.commands.find((c) => c.startsWith("APPEND"))).toMatch(
      /^APPEND Sent /,
    );
  });
});
