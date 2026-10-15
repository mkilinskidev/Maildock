import { mkdtemp, rm, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/shared/application/attachment-limits";
import {
  RECEIVING_ATTACHMENT_BYTES,
  RECEIVING_ATTACHMENT_LIFETIME_MS,
} from "@/modules/mail/domain/receiving-attachment-limits";
import { AttachmentDecoder } from "@/modules/mail/application/receiving-attachment";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { verifyBlob } from "@/shared/application/blob-storage";
function attachmentNode(size: number, encoding: string, part: string) {
  return {
    part,
    type: "application/octet-stream",
    disposition: "inline",
    filename: "payload.bin",
    encoding,
    size: String(size),
    contentId: "<resource>",
    parameters: { name: "payload.bin" },
    dispositionParameters: { filename: "payload.bin" },
    children: [],
  };
}
import { randomUUID } from "node:crypto";
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
  describe,
  expect,
  it,
  vi,
} from "vitest";
const apiPorts = vi.hoisted(() => ({
  download: null as unknown as AttachmentService["downloadStream"],
  denied: null as Response | null,
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: async () => apiPorts.denied,
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  attachmentService: {
    downloadStream: (
      ...args: Parameters<AttachmentService["downloadStream"]>
    ) => apiPorts.download(...args),
  },
}));
import { GET as downloadGet } from "@/app/api/attachments/[attachmentId]/download/route";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { EmailRenderingService } from "@/modules/mail/application/email-rendering-service";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import {
  ReceivingPublication,
  type PublicationSource,
} from "@/modules/mail/application/receiving-publication";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import { fixture } from "../experiments/imap-transport/fixture";
import { metadataPeer } from "./fixtures/imap-metadata-peer";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import type { ReceivingCoordinatorConfig } from "@/modules/mail/application/receiving-coordinator";
import type { ReceivingAdmission } from "@/modules/mail/application/receiving-scheduler";
import { validateReceivingOperation } from "@/modules/mail/application/receiving-operation";

const budget = () => ({ deadline: performance.now() + 5000 });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() >= end)
      throw new Error("Flag fixture barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("R12 owned attachment retrieval", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let url: string, account: string, message: string;
  let source: PublicationSource;
  let attachment: string;
  let storage: LocalBlobStorage;
  let storageRoot: string;
  const cleanup: (() => Promise<unknown>)[] = [];
  beforeAll(async () => {
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
    await root`create database receiving_attachment owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_attachment`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 4 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 2);
    storageRoot = await mkdtemp(path.join(tmpdir(), "maildock-r12-"));
    storage = new LocalBlobStorage(storageRoot);
  });
  async function seed(size: number, encoding: string, nested = false) {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    const owner = { actor, generation: BigInt(lease.generation) };
    account = randomUUID();
    const mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Content",
      email: "flags@example.test",
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
      name: "Source",
      remotePath: "Source",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const persistence = new ReceivingPersistence(executor);
    await persistence.initialize(
      owner,
      mailbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await persistence.persist(
      owner,
      mailbox,
      {
        epoch: 7n,
        revision: 0n,
        freshThrough: 1n,
        historyBefore: 2n,
        reconcileAfter: 0n,
      },
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 1n,
          high: 1n,
          searched: [1n],
          confirmedAbsent: [],
        },
        metadata: [
          {
            uid: "1",
            internalDate: "2026-01-01T00:00:00Z",
            size: "10",
            hasAttachments: true,
            mimeStructure: {
              part: null,
              type: "multipart/mixed",
              disposition: null,
              filename: null,
              encoding: null,
              size: null,
              contentId: null,
              parameters: {},
              dispositionParameters: {},
              children: [
                {
                  part: "1",
                  type: "text/html",
                  disposition: null,
                  filename: null,
                  encoding: "8bit",
                  size: "500000000",
                  contentId: null,
                  parameters: {},
                  dispositionParameters: {},
                  children: [],
                },
                ...(nested
                  ? [
                      {
                        part: "2",
                        type: "multipart/related",
                        disposition: null,
                        filename: null,
                        encoding: null,
                        size: null,
                        contentId: null,
                        parameters: {},
                        dispositionParameters: {},
                        children: [attachmentNode(size, encoding, "2.1")],
                      },
                    ]
                  : [attachmentNode(size, encoding, "2")]),
              ],
            },
            flags: ["\\Answered", "$Custom"],
            envelope: {
              messageId: `<${account}@example.test>`,
              subject: "Content",
              from: [],
              sender: [],
              replyTo: [],
              to: [],
              cc: [],
              bcc: [],
            },
          },
        ],
      },
      budget(),
    );
    const [placement] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    message = placement.message_id;
    source = {
      mailbox,
      configuration: 1n,
      state: {
        epoch: 7n,
        revision: 1n,
        freshThrough: 1n,
        historyBefore: 1n,
        reconcileAfter: 0n,
      },
    };
  }
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
    if (storageRoot) {
      if (
        !path
          .resolve(storageRoot)
          .startsWith(path.resolve(tmpdir()) + path.sep) ||
        !path.basename(storageRoot).startsWith("maildock-r12-")
      )
        throw new Error("Unsafe cleanup");
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
  const service = () =>
    new AttachmentService(
      database.db,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      async () => {},
    );
  async function row() {
    return (
      await reader`select * from message_attachments where id=${attachment}`
    )[0];
  }
  async function harness(
    input: {
      size?: number;
      data?: Buffer;
      encoding?: string;
      nested?: boolean;
      automatic?: boolean;
      corrupt?: string;
      at?: number;
      beforeLiteral?: () => Promise<void>;
      beforePublish?: () => Promise<void>;
      store?: typeof storage;
      metadata?: Awaited<ReturnType<typeof metadataPeer>>;
      onTurn?: ReceivingCoordinatorConfig["onTurn"];
      onAdmission?: (admission: ReceivingAdmission) => void;
      lifetimeMs?: number;
    } = {},
  ) {
    const encoding = input.encoding ?? "binary",
      size = input.data?.length ?? input.size ?? 100;
    await seed(size, encoding, input.nested);
    if (input.metadata) {
      const inbox = randomUUID();
      await database.db.insert(mailboxes).values({
        id: inbox,
        accountId: account,
        name: "INBOX",
        remotePath: "INBOX",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
      const [owner] =
        await reader`select owner,generation from receiving_coordinator`;
      await new ReceivingPersistence(executor).initialize(
        { actor: owner.owner, generation: BigInt(owner.generation) },
        inbox,
        { complete: true, epoch: 7n, uidNext: 1025n },
        budget(),
      );
    }
    attachment = (
      await reader`select id from message_attachments where message_id=${message}`
    )[0].id;
    await service().request(attachment);
    const part = input.nested ? "2.1" : "2";
    const leaf = `("APPLICATION" "OCTET-STREAM" ("NAME" "payload.bin") "<resource>" NIL "${encoding.toUpperCase()}" ${size} NIL ("INLINE" ("FILENAME" "payload.bin")) NIL NIL)`;
    const structure = `(("TEXT" "HTML" NIL NIL NIL "8BIT" 500000000 1 NIL NIL NIL NIL) ${input.nested ? `(${leaf} "RELATED" NIL NIL NIL NIL)` : leaf} "MIXED" NIL NIL NIL NIL)`;
    let bytes = 0,
      slices = 0,
      connects = 0,
      largest = 0;
    const peer = await fixture(
      (p, c) => {
        if (/^(LOGIN|AUTHENTICATE)/.test(c.command)) {
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("EXAMINE")) {
          p.send(
            `* 1 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY ${input.corrupt === "epoch" ? 8 : 7}] Epoch\r\n* OK [UIDNEXT 2] Next\r\n`,
            c,
          );
          p.ok(c, "OK [READ-ONLY] Selected");
          return true;
        }
        if (c.command.startsWith("UID STORE")) {
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("UID FETCH") && c.command.includes("FLAGS")) {
          p.send("* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n", c);
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("UID FETCH")) {
          void (async () => {
            expect(executor.snapshot.executing).toBe(0);
            if (c.command.includes("BODYSTRUCTURE")) {
              p.send(`* 1 FETCH (UID 1 BODYSTRUCTURE ${structure})\r\n`, c);
              p.ok(c);
              return;
            }
            await input.beforeLiteral?.();
            const match = c.command.match(
              /BODY\.PEEK\[([^\]]+)\]<(\d+)\.(\d+)>/,
            );
            if (!match || match[1] !== part)
              throw new Error("Nonselective attachment fetch");
            const offset = Number(match[2]),
              length = Number(match[3]);
            expect(length).toBe(32768);
            let chunk = input.data
              ? input.data.subarray(offset, offset + length)
              : Buffer.alloc(Math.max(0, Math.min(length, size - offset)), 65);
            const fault = offset >= (input.at ?? 0) ? input.corrupt : undefined;
            if (fault === "overlong") chunk = Buffer.from("A");
            if (fault === "short")
              chunk = chunk.subarray(0, Math.max(0, chunk.length - 1));
            if (fault === "missing") {
              p.ok(c);
              return;
            }
            slices++;
            bytes += chunk.length;
            largest = Math.max(largest, chunk.length);
            p.send(
              `* 1 FETCH (UID ${fault === "uid" ? 99 : 1} BODY[${fault === "part" ? "99" : part}]<${fault === "offset" ? offset + 1 : offset}> {${chunk.length}}\r\n`,
              c,
            );
            if (fault === "truncated") {
              p.send(chunk.subarray(0, 2), c);
              p.socket.destroy();
              return;
            }
            p.send(chunk, c);
            p.send(")\r\n", c);
            if (fault === "duplicate") p.send("* 1 FETCH (UID 1)\r\n", c);
            if (fault === "no-ok") p.socket.destroy();
            else if (fault === "wrong-tag") p.send("other OK Done\r\n", c);
            else if (fault === "no") p.ok(c, "NO Failed");
            else {
              p.ok(c);
              if (fault === "duplicate-ok") p.ok(c);
            }
          })().catch(() => p.socket.destroy());
          return true;
        }
        return false;
      },
      {},
      "OK",
      "IMAP4rev1 AUTH=PLAIN BINARY",
    );
    cleanup.push(() => peer.cleanup());
    const connection = {
      host: peer.endpoint.host,
      port: peer.endpoint.port,
      security: "tls" as const,
      username: "fixture",
      credential: { kind: "password" as const, password: "fixture-only" },
    };
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: {
        workers: input.metadata ? 1 : 2,
        historyWaitMs: 1,
        historyTurnMs: 1000,
      },
      onAdmission: input.onAdmission,
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: input.metadata?.connection ?? connection,
        createClient: input.metadata?.createClient,
        onTurn: input.onTurn,
        timing: input.metadata ? { pollMs: 1 } : undefined,
      }),
      loadOperationConnection: async () => connection,
      operationHandlers: {
        "attachment-slice": { attachment: input.store ?? storage },
        store: { flags: true },
        "exact-lookup": { flags: true },
      },
      createOperationClient: (options) => {
        if (input.metadata)
          expect(
            input.metadata.observed.every((client) => !client.usable),
          ).toBe(true);
        connects++;
        const client = new ImapFlow({
          ...options,
          tls: { rejectUnauthorized: false },
        });
        const connect = client.connect.bind(client);
        client.connect = async () => {
          if ((await row()).status !== "ready")
            expect((await row()).status).toBe("fetching");
          return connect();
        };
        if (input.beforePublish) {
          const retire = client.retireReceiving.bind(client);
          let once = true;
          client.retireReceiving = async () => {
            await retire();
            if (once) {
              once = false;
              await input.beforePublish!();
            }
          };
        }
        return client;
      },
    });
    if (!input.automatic)
      coordinator.dispatchAttachmentRequests = async () => {};
    coordinator.dispatchFlagCommands = async () => {};
    cleanup.push(() => coordinator.stop());
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    expect(await coordinator.elect()).toBe(true);
    const submit = (signal?: AbortSignal) =>
      coordinator.submit({
        kind: "attachment-slice",
        pendingId: attachment,
        offset: 0,
        maxBytes: RECEIVING_ATTACHMENT_BYTES,
        requestId: randomUUID(),
        deadline:
          performance.now() +
          (input.lifetimeMs ?? RECEIVING_ATTACHMENT_LIFETIME_MS),
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: 1n,
        },
        signal,
      });
    return {
      coordinator,
      submit,
      peer,
      counters: () => ({ bytes, slices, connects, largest }),
    };
  }

  it.each(["binary", "8bit", "7bit", "base64", "quoted-printable"])(
    "retrieves %s selectively and serves the cached download",
    async (encoding) => {
      const expected = Buffer.from(
        encoding === "7bit" ? "hello attachment" : "Zażółć attachment\r\n",
      );
      const data =
        encoding === "base64"
          ? Buffer.from(expected.toString("base64"))
          : encoding === "quoted-printable"
            ? Buffer.from(
                [...expected]
                  .map((b) => `=${b.toString(16).padStart(2, "0")}`)
                  .join(""),
              )
            : expected;
      const h = await harness({ data, encoding });
      await h.submit();
      expect((await row()).status).toBe("ready");
      expect((await service().download(attachment)).bytes).toEqual(expected);
      const before = h.counters();
      await service().request(attachment);
      await h.coordinator.notify(account);
      expect(h.counters()).toEqual(before);
      const result = await service().downloadStream(attachment);
      const hash = createHash("sha256");
      for await (const chunk of result.stream) hash.update(chunk);
      expect(hash.digest("hex")).toBe(
        createHash("sha256").update(expected).digest("hex"),
      );
      expect(
        h.peer.commands.some((c) =>
          /STORE|RFC822|BODY\.PEEK\[1\]|BINARY\.PEEK/.test(c.command),
        ),
      ).toBe(false);
    },
  );
  it("retrieves the original nested part", async () => {
    const h = await harness({ nested: true });
    await h.submit();
    expect((await row()).status).toBe("ready");
  });
  it.each([20, 80, 100])(
    "streams a real %i MiB attachment with incremental disk verification",
    async (mib) => {
      const size = mib * 1024 * 1024,
        start = performance.now();
      const h = await harness({ size });
      global.gc?.();
      const memory = process.memoryUsage();
      let peakBuffers = memory.arrayBuffers,
        peakHeap = memory.heapUsed;
      const timer = setInterval(() => {
        const m = process.memoryUsage();
        peakBuffers = Math.max(peakBuffers, m.arrayBuffers);
        peakHeap = Math.max(peakHeap, m.heapUsed);
      }, 10);
      try {
        await h.submit();
      } finally {
        clearInterval(timer);
      }
      const result = await service().downloadStream(attachment);
      let total = 0;
      const hash = createHash("sha256"),
        expected = createHash("sha256");
      for await (const chunk of result.stream) {
        total += chunk.length;
        hash.update(chunk);
      }
      const block = Buffer.alloc(32768, 65);
      for (let at = 0; at < size; at += block.length)
        expected.update(block.subarray(0, Math.min(block.length, size - at)));
      expect(total).toBe(size);
      expect(hash.digest("hex")).toBe(expected.digest("hex"));
      expect(h.counters().bytes).toBe(size);
      expect(h.counters().slices).toBe(size / 32768 + 1);
      expect(h.counters().largest).toBe(32768);
      await new Promise<void>((resolve) => setImmediate(resolve));
      global.gc?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      global.gc?.();
      const retained = process.memoryUsage();
      if (global.gc) {
        expect(retained.arrayBuffers - memory.arrayBuffers).toBeLessThan(
          4 * 1024 * 1024,
        );
        expect(retained.heapUsed - memory.heapUsed).toBeLessThan(
          8 * 1024 * 1024,
        );
      }
      const [blob] =
        await reader`select b.* from blobs b join message_attachments a on a.blob_id=b.id where a.id=${attachment}`;
      expect(Number(blob.size)).toBe(size);
      expect(
        (
          await stat(
            path.join(
              storageRoot,
              "blobs",
              blob.storage_key.slice(0, 2),
              blob.storage_key,
            ),
          )
        ).size,
      ).toBe(size);
      process.stdout.write(
        JSON.stringify({
          mib,
          ...h.counters(),
          total,
          sha256: blob.sha256,
          ms: performance.now() - start,
          bufferGrowth: peakBuffers - memory.arrayBuffers,
          heapGrowth: peakHeap - memory.heapUsed,
          retainedBuffers: retained.arrayBuffers - memory.arrayBuffers,
          retainedHeap: retained.heapUsed - memory.heapUsed,
        }) + "\n",
      );
    },
    240_000,
  );
  it("rejects a decoded byte above 100 MiB without publication", async () => {
    const h = await harness({ size: RECEIVING_ATTACHMENT_BYTES + 1 });
    await expect(h.submit()).rejects.toThrow();
    expect((await row()).status).toBe("failed");
    expect(await readdir(path.join(storageRoot, "tmp"))).toEqual([]);
  }, 240_000);
  it.each([
    "uid",
    "part",
    "offset",
    "short",
    "truncated",
    "missing",
    "duplicate",
    "no-ok",
    "wrong-tag",
    "epoch",
  ])("rejects %s transfer evidence", async (corrupt) => {
    const h = await harness({
      size: 65536,
      corrupt,
      at: corrupt === "short" ? 32768 : 0,
    });
    await expect(h.submit()).rejects.toThrow();
    expect((await row()).status).not.toBe("ready");
  });
  it("coalesces concurrent requests and discovers durable work without a wake", async () => {
    const h = await harness({ automatic: true });
    await Promise.all(
      Array.from({ length: 8 }, () => service().request(attachment)),
    );
    await h.coordinator.dispatchAttachmentRequests();
    await until(async () => (await row()).status === "ready");
    expect(h.counters().connects).toBe(1);
  });
  it("cancels a partial stage and restarts the original durable intent", async () => {
    const entered = barrier(),
      release = barrier();
    let once = true;
    const h = await harness({
      size: 65536,
      beforeLiteral: async () => {
        if (once) {
          once = false;
          entered.release();
          await release.promise;
        }
      },
    });
    const controller = new AbortController(),
      pending = h.submit(controller.signal);
    void pending.catch(() => {});
    await entered.promise;
    controller.abort();
    release.release();
    await expect(pending).rejects.toThrow();
    expect(await readdir(path.join(storageRoot, "tmp"))).toEqual([]);
    await h.submit();
    expect((await row()).status).toBe("ready");
    expect((await row()).receiving_attempt.reads).toBe("2");
  });
  it.each(["base64", "quoted-printable", "7bit"])(
    "rejects malformed %s without a ready blob",
    async (encoding) => {
      const h = await harness({
        data: Buffer.from(
          encoding === "7bit" ? [255] : encoding === "base64" ? "QQ=Z" : "=X",
        ),
        encoding,
      });
      await expect(h.submit()).rejects.toThrow();
      expect((await row()).status).toBe("failed");
    },
  );
  it("fences a configuration change after socket retirement", async () => {
    const h = await harness({
      beforePublish: async () => {
        await reader`update mail_accounts set configuration_version=configuration_version+1 where id=${account}`;
      },
    });
    await expect(h.submit()).rejects.toThrow();
    expect((await row()).status).not.toBe("ready");
    await expect(service().downloadStream(attachment)).rejects.toThrow();
  });

  it.each(["claim", "result"])(
    "recovers a lost %s COMMIT under conflicting locks",
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
                ? "maildock_receiving_attachment_claim"
                : "maildock_receiving_attachment_result",
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
      const h = await harness();
      const pending = h.submit();
      void pending.catch(() => {});
      await until(
        async () =>
          (await row()).status === (phase === "claim" ? "fetching" : "ready"),
      );
      const held = await reader.reserve();
      await held`begin`;
      try {
        await held`select id from mailboxes where id=${source.mailbox} for update`;
        await until(
          async () =>
            (
              await reader`select exists(select from pg_stat_activity where datname='receiving_attachment' and wait_event_type='Lock' and query like '%maildock_receiving_attempt_recover%') as waiting`
            )[0].waiting === true,
        );
        expect(h.peer.peers.length).toBe(phase === "claim" ? 0 : 1);
      } finally {
        await held`commit`;
        held.release();
      }
      await pending;
      expect(once).toBe(false);
      expect(h.counters().connects).toBe(1);
      expect((await row()).status).toBe("ready");
      expect((await row()).receiving_attempt.reads).toBe("1");
    },
  );
  it("fences owner takeover before publication", async () => {
    const h = await harness({
      beforePublish: async () => {
        await reader`update receiving_coordinator set expires_at='-infinity'`;
        await reader`select maildock_receiving_acquire(${randomUUID()}::uuid,60000)`;
      },
    });
    await expect(h.submit()).rejects.toThrow();
    expect((await row()).status).not.toBe("ready");
  });
  it("atomically fills incoming draft references and preserves the snapshot after source loss", async () => {
    const h = await harness();
    const draft = randomUUID();
    await reader`insert into drafts(id,account_id,compose_mode) values(${draft},${account},'new')`;
    await reader`insert into draft_attachments(draft_id,id,kind,filename,content_type,position) values(${draft},${attachment},'incoming','payload.bin','application/octet-stream',0)`;
    await h.submit();
    const [reference] =
      await reader`select b.* from draft_attachments d join blobs b on b.id=d.blob_id where d.draft_id=${draft}`;
    expect(reference.storage_key).toBeTruthy();
    await reader`update mail_accounts set configuration_version=configuration_version+1 where id=${account}`;
    await expect(service().downloadStream(attachment)).rejects.toThrow();
    await verifyBlob(
      storage,
      {
        key: reference.storage_key,
        size: Number(reference.size),
        sha256: reference.sha256,
      },
      RECEIVING_ATTACHMENT_BYTES,
    );
  });
  it.each(["write", "disk-full"])(
    "does not publish on storage %s failure",
    async (fault) => {
      const failing = new (class extends LocalBlobStorage {
        async put(source: AsyncIterable<Uint8Array>, limit: number) {
          return super.put(
            (async function* () {
              for await (const chunk of source) {
                if (fault === "disk-full") yield chunk;
                throw Object.assign(new Error("Storage fault"), {
                  code: fault === "disk-full" ? "ENOSPC" : "EIO",
                });
              }
            })(),
            limit,
          );
        }
      })(storageRoot);
      // storageRoot is created by beforeAll before this test constructs the adapter.
      const h = await harness({ store: failing });
      await expect(h.submit()).rejects.toThrow();
      expect((await row()).status).toBe("failed");
      expect(await readdir(path.join(storageRoot, "tmp"))).toEqual([]);
    },
  );
  it("reclaims crash debris while all writers are quiescent and retains registered shared blobs", async () => {
    const h = await harness();
    await h.submit();
    await h.coordinator.stop();
    const registered = (
      await reader`select b.storage_key from blobs b join message_attachments a on a.blob_id=b.id where a.id=${attachment}`
    )[0].storage_key;
    const orphan = await storage.put(
      (async function* () {
        yield Buffer.from("unlinked finalization");
      })(),
      100,
    );
    const abandoned = randomUUID();
    await writeFile(path.join(storageRoot, "tmp", abandoned), "partial stage");
    const restarted = new LocalBlobStorage(storageRoot);
    const result = await restarted.reclaimWhileQuiescent(
      async (key) =>
        (
          await reader`select exists(select from blobs where storage_key=${key}) as registered`
        )[0].registered,
    );
    expect(result.temporary).toBe(1);
    expect(result.finalized).toBeGreaterThanOrEqual(1);
    expect(await restarted.exists(orphan.key)).toBe(false);
    expect(await restarted.exists(registered)).toBe(true);
    expect(await readdir(path.join(storageRoot, "tmp"))).toEqual([]);
  });
  it("serves the actual authenticated download route and rejects guessed IDs and stale sources", async () => {
    const h = await harness();
    await h.submit();
    apiPorts.download = service().downloadStream.bind(service());
    const get = (id = attachment) =>
      downloadGet(new Request("http://localhost/api"), {
        params: Promise.resolve({ attachmentId: id }),
      });
    apiPorts.denied = new Response(null, { status: 401 });
    expect((await get()).status).toBe(401);
    apiPorts.denied = null;
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("100");
    expect((await response.arrayBuffer()).byteLength).toBe(100);
    expect((await get(randomUUID())).status).toBe(409);
    // A registered blob ID is never an attachment authority.
    expect((await get((await row()).blob_id)).status).toBe(409);
    const before = h.counters();
    await reader`update mail_accounts set enabled=false where id=${account}`;
    expect((await get()).status).toBe(200);
    expect(h.counters()).toEqual(before);
    await reader`update mail_accounts set configuration_version=configuration_version+1 where id=${account}`;
    expect((await get()).status).toBe(409);
  });
  it("uses the same retrieval for CID rendering with sanitized references and isolated remote images", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYqkAAAAASUVORK5CYII=",
      "base64",
    );
    const h = await harness({ data: png });
    await h.submit();
    const resource = await service().inlineResource(
      message,
      attachment,
      "resource",
    );
    expect(resource.type).toBe("image/png");
    expect(resource.bytes).toEqual(png);
    await expect(
      service().inlineResource(randomUUID(), attachment, "resource"),
    ).rejects.toThrow();
    await expect(
      service().inlineResource(message, attachment, "guessed"),
    ).rejects.toThrow();
    await reader`select maildock_receiving_content_request(${account}::uuid,${source.mailbox}::uuid,${message}::uuid)`;
    const [state] =
      await reader`select revision from receiving_mailboxes where mailbox_id=${source.mailbox}`;
    const current = {
      ...source,
      state: { ...source.state, revision: BigInt(state.revision) },
    };
    const publication = new ReceivingPublication(executor);
    const claim = await publication.contentClaim(
      h.coordinator.snapshot.owner!,
      current,
      "content",
      message,
      budget(),
    );
    await publication.contentResult(
      h.coordinator.snapshot.owner!,
      {
        ...current,
        state: { ...current.state, revision: current.state.revision + 1n },
      },
      message,
      claim.id,
      {
        complete: true,
        taggedOk: true,
        streamComplete: true,
        decoded: true,
        eof: true,
        method: "BODY.PEEK",
        origin: 0,
        encodedBytes: 100n,
        epoch: 7n,
        uid: 1n,
        part: "TEXT",
        plainText: null,
        html: '<p>CID</p><img src="cid:resource"><img src="https://remote.test/x"><script>bad()</script>',
        searchText: "",
      },
      budget(),
    );
    const content = new MessageContentService(database.db);
    const detail = await content.detail(account, source.mailbox, message);
    expect(detail.content.sanitizedHtml).toContain("data-maildock-cid");
    const rendered = await new EmailRenderingService(
      database.db,
      content,
      service(),
    ).render(account, source.mailbox, message, {
      loadImages: false,
      trustSender: false,
    });
    expect(rendered.document).toContain("data:image/png;base64,");
    expect(rendered.document).not.toContain('src="https://remote.test/x"');
    expect(rendered.document).not.toContain("<script");
    expect(rendered.inlineFailures).toBe(0);
    await reader`update mail_accounts set configuration_version=configuration_version+1 where id=${account}`;
    await expect(
      service().inlineResource(message, attachment, "resource"),
    ).rejects.toThrow();
  });
  it("holds W=1 and C=1 through a real 20 MiB transfer, then admits flags and fresh/history work", async () => {
    const script = { uids: [1, 1024], uidNext: 1025, boundedMailbox: true };
    const metadata = await metadataPeer(script);
    cleanup.push(metadata.cleanup);
    const entered = barrier(),
      release = barrier();
    let once = true,
      fresh = 0,
      history = 0;
    const admissions: string[] = [];
    let maximumActive = 0;
    const h = await harness({
      size: 20 * 1024 * 1024,
      metadata,
      beforeLiteral: async () => {
        if (once) {
          once = false;
          entered.release();
          await release.promise;
        }
      },
      onAdmission: (a) => {
        maximumActive = Math.max(maximumActive, a.active);
        admissions.push(a.kind);
      },
      onTurn: (kind) => {
        if (kind === "fresh") {
          fresh++;
          script.uids.push(script.uidNext++);
        } else history++;
      },
    });
    const attachmentWork = h.submit();
    void attachmentWork.catch(() => {});
    await entered.promise;
    const commands = new MessageCommandService(
      database.db,
      async () => {},
      async () => {},
    );
    const command = await commands.create(
      account,
      source.mailbox,
      message,
      "mark_read",
    );
    const flags = h.coordinator.submit({
      kind: "store",
      pendingId: command.id,
      requestId: randomUUID(),
      deadline: performance.now() + 9000,
      identity: { account, mailbox: source.mailbox, configurationVersion: 1n },
    });
    void flags.catch(() => {});
    expect(metadata.observed.every((client) => !client.usable)).toBe(true);
    expect(h.peer.commands.some((c) => c.command.startsWith("UID STORE"))).toBe(
      false,
    );
    expect(executor.snapshot.executing).toBe(0);
    release.release();
    await Promise.all([attachmentWork, flags]);
    expect((await row()).status).toBe("ready");
    expect(admissions[0]).toBe("fresh");
    expect(maximumActive).toBe(1);
    await until(() => fresh > 1 && history > 0);
    expect(fresh).toBeGreaterThan(1);
    expect(history).toBeGreaterThan(0);
    expect(admissions.indexOf("attachment-slice")).toBeLessThan(
      admissions.indexOf("store"),
    );
  }, 60_000);
  it.each(["disabled", "removing"])(
    "rejects %s remote work before constructing a client",
    async (kind) => {
      const h = await harness();
      if (kind === "disabled")
        await reader`update mail_accounts set enabled=false where id=${account}`;
      else
        await reader.begin(async (tx) => {
          await tx`select set_config('maildock.account_removal_start',${account},true)`;
          await tx`update mail_accounts set enabled=false,removal_requested_at=clock_timestamp() where id=${account}`;
        });
      await expect(h.submit()).rejects.toThrow();
      expect(h.counters().connects).toBe(0);
    },
  );
  it.each(["partial", "finalized"])(
    "a replacement elected owner restarts a crashed %s stage from durable intent",
    async (phase) => {
      const h = await harness();
      const first = await new ReceivingPublication(executor).attachmentClaim(
        h.coordinator.snapshot.owner!,
        source,
        "attachment",
        attachment,
        budget(),
      );
      if (phase === "partial")
        await writeFile(
          path.join(storageRoot, "tmp", randomUUID()),
          "interrupted",
        );
      else
        await storage.put(
          (async function* () {
            yield Buffer.from("complete but not published");
          })(),
          100,
        );
      await h.coordinator.stop();
      await new LocalBlobStorage(storageRoot).reclaimWhileQuiescent(
        async (key) =>
          (
            await reader`select exists(select from blobs where storage_key=${key}) as registered`
          )[0].registered,
      );
      const connection = {
        host: h.peer.endpoint.host,
        port: h.peer.endpoint.port,
        security: "tls" as const,
        username: "fixture",
        credential: { kind: "password" as const, password: "fixture-only" },
      };
      const replacement = new ElectedReceivingCoordinator({
        executor,
        loadAccount: async (_db, candidate) => ({ ...candidate, connection }),
        loadOperationConnection: async () => connection,
        operationHandlers: { "attachment-slice": { attachment: storage } },
        createOperationClient: (options) =>
          new ImapFlow({ ...options, tls: { rejectUnauthorized: false } }),
      });
      cleanup.push(() => replacement.stop());
      expect(await replacement.elect()).toBe(true);
      await until(async () => (await row()).status === "ready");
      expect((await row()).receiving_attempt.previousAttempt).toBe(first.id);
      expect((await row()).receiving_attempt.reads).toBe("2");
      expect(h.peer.peers).toHaveLength(1);
    },
  );
  it.each(["size", "sha256"])(
    "rejects incorrect finalized %s evidence without registering a blob",
    async (field) => {
      const faulty = new (class extends LocalBlobStorage {
        async put(source: AsyncIterable<Uint8Array>, limit: number) {
          const blob = await super.put(source, limit);
          return field === "size"
            ? { ...blob, size: blob.size + 1 }
            : { ...blob, sha256: "0".repeat(64) };
        }
      })(storageRoot);
      const h = await harness({ store: faulty });
      await expect(h.submit()).rejects.toThrow();
      expect((await row()).status).toBe("failed");
      expect((await row()).blob_id).toBeNull();
    },
  );

  it.each([
    "missing",
    "no-ok",
    "uid",
    "offset",
    "overlong",
    "no",
    "duplicate-ok",
  ])(
    "rejects %s final-window evidence after an exact multiple",
    async (corrupt) => {
      const h = await harness({ size: 65536, corrupt, at: 65536 });
      await expect(h.submit()).rejects.toThrow();
      expect((await row()).status).not.toBe("ready");
    },
  );
  it("cancels a stalled attachment at its finite admitted deadline", async () => {
    const entered = barrier(),
      release = barrier();
    const h = await harness({
      lifetimeMs: 2500,
      beforeLiteral: async () => {
        entered.release();
        await release.promise;
      },
    });
    const pending = h.submit();
    void pending.catch(() => {});
    await entered.promise;
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      release.release();
    }
    expect((await row()).status).not.toBe("ready");
    expect(await readdir(path.join(storageRoot, "tmp"))).toEqual([]);
  });
});

describe("R12 continuous decoder boundaries", () => {
  it("keeps attachment deadlines and size independent of content/SQL budgets", () => {
    const base = {
      kind: "attachment-slice" as const,
      requestId: randomUUID(),
      pendingId: randomUUID(),
      identity: { account: randomUUID(), configurationVersion: 1n },
      offset: 0,
      maxBytes: RECEIVING_ATTACHMENT_BYTES,
      deadline: performance.now() + RECEIVING_ATTACHMENT_LIFETIME_MS - 1000,
    };
    expect(() => validateReceivingOperation(base)).not.toThrow();
    expect(() =>
      validateReceivingOperation({
        ...base,
        deadline: performance.now() + RECEIVING_ATTACHMENT_LIFETIME_MS + 1000,
      }),
    ).toThrow("envelope");
    expect(() =>
      validateReceivingOperation({
        ...base,
        maxBytes: RECEIVING_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow("unit budget");
    expect(() =>
      validateReceivingOperation({
        ...base,
        kind: "content-slice",
        deadline: performance.now() + 9000,
        maxBytes: 5 * 1024 * 1024 + 1,
      }),
    ).toThrow("unit budget");
  });
  it.each(["base64", "quoted-printable"])(
    "decodes %s across every split with bounded carry",
    (encoding) => {
      const data = encoding === "base64" ? "YWJjAP8=" : "abc=00=FF=\r\n";
      for (let split = 0; split <= data.length; split++) {
        const decoder = new AttachmentDecoder(encoding);
        const a = decoder.decode(Buffer.from(data.slice(0, split))),
          b = decoder.decode(Buffer.from(data.slice(split)));
        decoder.finish();
        expect(Buffer.concat([a, b])).toEqual(
          Buffer.from([97, 98, 99, 0, 255]),
        );
      }
    },
  );
});
