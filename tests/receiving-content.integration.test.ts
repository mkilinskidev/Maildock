import * as diagnostics from "@/shared/infrastructure/logging/receiving-diagnostics";
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
import {
  ReceivingPublication,
  type PublicationSource,
} from "@/modules/mail/application/receiving-publication";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import type { ReceivingCoordinatorConfig } from "@/modules/mail/application/receiving-coordinator";
import type { ReceivingAdmission } from "@/modules/mail/application/receiving-scheduler";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { fixture } from "../experiments/imap-transport/fixture";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { metadataPeer } from "./fixtures/imap-metadata-peer";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import { SearchService } from "@/modules/mail/application/search-service";
import { DISPLAY_CONTENT_BYTES } from "@/modules/mail/domain/display-content-limits";

type Body = {
  type: "plain" | "html";
  value: Buffer;
  encoding?: string;
  charset?: string;
  flowed?: boolean;
};
const plain = (text = "uniquebodytoken Zażółć gęślą jaźń"): Body => ({
  type: "plain",
  value: Buffer.from(text),
});

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

describe("R11 owned content retrieval", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let url: string, account: string, message: string;
  let source: PublicationSource;
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
    await root`create database receiving_content owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_content`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 4 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 2);
  });
  beforeEach(async (context) => {
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
      ...(context.task.name.startsWith("OAuth blockage")
        ? {
            authMethod: "oauth2",
            oauthProviderId: "google",
            oauthStatus: "connected",
            imapPassword: null,
            oauthCache: {
              version: 1 as const,
              algorithm: "AES-256-GCM" as const,
              keyId: "fixture",
              iv: "fixture",
              ciphertext: "fixture",
              authTag: "fixture",
            },
          }
        : {}),
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
            hasAttachments: false,
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
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const service = () =>
    new MessageContentService(
      database.db,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {},
    );
  const request = () => service().request(account, source.mailbox, message);
  async function contentRow() {
    return (
      await reader`select * from message_contents where message_id=${message}`
    )[0];
  }
  async function inbox(uidNext: bigint) {
    const id = randomUUID();
    await database.db.insert(mailboxes).values({
      id,
      accountId: account,
      name: "INBOX",
      remotePath: "INBOX",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const [lease] =
      await reader`select owner,generation from receiving_coordinator`;
    await new ReceivingPersistence(executor).initialize(
      { actor: lease.owner, generation: BigInt(lease.generation) },
      id,
      { complete: true, epoch: 7n, uidNext },
      budget(),
    );
  }
  async function harness(
    input: {
      bodies?: Body[];
      mixed?: boolean;
      nested?: boolean;
      gmailBodyFirst?: boolean;
      automatic?: boolean;
      maxBytes?: number;
      sliceDelayMs?: number;
      corruptAtOffset?: number;
      epoch?: number;
      structureOverride?: string;
      corrupt?:
        | "uid"
        | "part"
        | "offset"
        | "short"
        | "truncated"
        | "no-ok"
        | "duplicate"
        | "structure"
        | "disappear";
      beforeClient?: () => Promise<void>;
      beforeLiteral?: () => Promise<void>;
      beforePublish?: () => Promise<void>;
      metadata?: Awaited<ReturnType<typeof metadataPeer>>;
      onTurn?: ReceivingCoordinatorConfig["onTurn"];
      onAdmission?: (admission: ReceivingAdmission) => void;
    } = {},
  ) {
    const bodies = input.bodies ?? [plain()];
    const leaf = (body: Body) =>
      `("TEXT" "${body.type.toUpperCase()}" ("CHARSET" "${body.charset ?? "utf-8"}"${body.flowed ? ' "FORMAT" "flowed"' : ""}) NIL NIL "${body.encoding ?? "8bit"}" ${body.value.length} 1 NIL NIL NIL NIL)`;
    let structure =
      bodies.length === 1
        ? leaf(bodies[0])
        : `(${bodies.map(leaf).join(" ")} "ALTERNATIVE" NIL NIL NIL NIL)`;
    if (input.nested) structure = `(${structure} "RELATED" NIL NIL NIL NIL)`;
    if (input.mixed)
      structure = `(${structure} ("APPLICATION" "OCTET-STREAM" ("NAME" "large.bin") NIL NIL "BASE64" 50000000 NIL ("ATTACHMENT" ("FILENAME" "large.bin")) NIL NIL) "MIXED" NIL NIL NIL NIL)`;
    structure = input.structureOverride ?? structure;
    const rootSingle = bodies.length === 1 && !input.mixed && !input.nested;
    const prefix = `${input.mixed ? "1." : ""}${input.nested ? "1." : ""}`;
    const partMap = new Map(
      bodies.map((body, i) => [
        rootSingle
          ? "TEXT"
          : `${prefix}${bodies.length === 1 ? "1" : i + 1}`.replace(
              /\.1$/,
              bodies.length === 1 ? "" : ".1",
            ),
        body,
      ]),
    );
    // A single leaf nested once is part 1; mixed/related contributes one extra level.
    if (bodies.length === 1 && !rootSingle) {
      partMap.clear();
      partMap.set(
        [...(input.mixed ? [1] : []), ...(input.nested ? [1] : [])].join("."),
        bodies[0],
      );
    }
    let reads = 0,
      stores = 0,
      bytes = 0,
      committedBeforeClient = false;
    const flags = new Set(["\\Answered", "$Custom"]);
    const peer = await fixture(
      (p, c) => {
        if (/^(LOGIN|AUTHENTICATE)/.test(c.command)) {
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("EXAMINE") || c.command.startsWith("SELECT")) {
          p.send(
            `* 1 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY ${input.epoch ?? 7}] Epoch\r\n* OK [UIDNEXT 2] Next\r\n`,
            c,
          );
          p.ok(
            c,
            c.command.startsWith("EXAMINE")
              ? "OK [READ-ONLY] Selected"
              : "OK [READ-WRITE] Selected",
          );
          return true;
        }
        if (c.command.startsWith("UID STORE")) {
          stores++;
          const flag = c.command.includes("\\Seen") ? "\\Seen" : "\\Flagged";
          if (c.command.includes("+FLAGS")) flags.add(flag);
          else flags.delete(flag);
          p.ok(c);
          return true;
        }
        if (c.command.startsWith("UID FETCH")) {
          if (c.command.includes("FLAGS")) {
            p.send(`* 1 FETCH (UID 1 FLAGS (${[...flags].join(" ")}))\r\n`, c);
            p.ok(c);
            return true;
          }
          reads++;
          void (async () => {
            expect(executor.snapshot.executing).toBe(0);
            if (input.corrupt === "disappear") {
              p.ok(c);
              return;
            }
            if (c.command.includes("BODYSTRUCTURE")) {
              p.send(
                `* 1 FETCH (UID ${input.corrupt === "uid" ? 99 : 1} BODYSTRUCTURE ${input.corrupt === "structure" ? '("TEXT" "PLAIN" NIL NIL NIL "8bit")' : structure})\r\n`,
                c,
              );
              p.ok(c);
              return;
            }
            await input.beforeLiteral?.();
            if (input.sliceDelayMs)
              await new Promise((resolve) =>
                setTimeout(resolve, input.sliceDelayMs),
              );
            const matches = [
              ...c.command.matchAll(
                /BODY\.PEEK\[([^\]]+)\](?:<(\d+)\.(\d+)>)?/g,
              ),
            ];
            if (input.gmailBodyFirst)
              matches.sort(
                (a, b) =>
                  Number(/HEADER|\.MIME/i.test(a[1])) -
                  Number(/HEADER|\.MIME/i.test(b[1])),
              );
            expect(matches.length).toBeGreaterThan(0);
            p.send(
              `* 1 FETCH (${input.gmailBodyFirst ? "X-GM-MSGID 1234567890123456789 " : ""}UID ${input.corrupt === "uid" ? 99 : 1} RFC822.SIZE 99999999`,
              c,
            );
            for (const match of matches) {
              const section = match[1].toUpperCase();
              const isHeader =
                section === "HEADER" || section.endsWith(".MIME");
              const body = partMap.get(
                isHeader
                  ? section === "HEADER"
                    ? "TEXT"
                    : section.slice(0, -5)
                  : section,
              );
              if (!body)
                throw new Error(
                  `Unexpected requested section ${section}; ${[...partMap.keys()]}`,
                );
              const offset = Number(match[2] ?? 0),
                length = Number(match[3] ?? 0);
              const corrupt =
                offset >= (input.corruptAtOffset ?? 0)
                  ? input.corrupt
                  : undefined;
              const header = Buffer.from(
                `Content-Type: text/${body.type}; charset=${body.charset ?? "utf-8"}${body.flowed ? "; format=flowed" : ""}\r\nContent-Transfer-Encoding: ${body.encoding ?? "8bit"}\r\n\r\n`,
              );
              let chunk = isHeader
                ? header
                : body.value.subarray(offset, offset + length);
              if (!isHeader && corrupt === "short")
                chunk = chunk.subarray(0, Math.max(0, chunk.length - 1));
              bytes += chunk.length;
              const returnedSection =
                !isHeader && corrupt === "part" ? "99" : section;
              p.send(
                ` BODY[${returnedSection}]${isHeader ? "" : `<${corrupt === "offset" ? offset + 1 : offset}>`} {${chunk.length}}\r\n`,
                c,
              );
              if (!isHeader && corrupt === "truncated") {
                p.send(chunk.subarray(0, 2), c);
                p.socket.destroy();
                return;
              }
              p.send(chunk, c);
            }
            p.send(")\r\n", c);
            if (input.corrupt === "duplicate")
              p.send("* 1 FETCH (UID 1)\r\n", c);
            if (input.corrupt === "no-ok") p.socket.destroy();
            else p.ok(c);
          })().catch((error) => {
            p.socket.destroy(error);
          });
          return true;
        }
        return false;
      },
      {},
      "OK",
      `IMAP4rev1 AUTH=PLAIN BINARY${input.gmailBodyFirst ? " X-GM-EXT-1" : ""}`,
    );
    cleanup.push(async () => {
      if (input.maxBytes === DISPLAY_CONTENT_BYTES)
        process.stdout.write("large-content-cleanup peer start\n");
      await peer.cleanup();
      if (input.maxBytes === DISPLAY_CONTENT_BYTES)
        process.stdout.write("large-content-cleanup peer complete\n");
    });
    const connection = {
      host: peer.endpoint.host,
      port: peer.endpoint.port,
      security: "tls" as const,
      username: "fixture",
      credential: { kind: "password" as const, password: "fixture-only" },
    };
    const coordinator = new ElectedReceivingCoordinator({
      executor,
      tuning: { workers: 2, historyWaitMs: 1, historyTurnMs: 1000 },
      onAdmission: input.onAdmission,
      loadAccount: async (_db, candidate) => ({
        ...candidate,
        connection: input.metadata?.connection ?? connection,
        createClient: input.metadata?.createClient,
        onTurn: input.onTurn,
        timing: input.onTurn ? { pollMs: 1 } : undefined,
      }),
      loadOperationConnection: async () => {
        await input.beforeClient?.();
        return connection;
      },
      operationHandlers: {
        "content-slice": { content: true },
        store: { flags: true },
        "exact-lookup": { flags: true },
      },
      createOperationClient: (options) => {
        if (input.metadata)
          expect(
            input.metadata.observed.every((client) => !client.usable),
          ).toBe(true);
        // This read starts at construction; SELECT/literal also independently checks SQL state below.
        const client = new ImapFlow({
          ...options,
          tls: { rejectUnauthorized: false },
        });
        const connect = client.connect.bind(client);
        client.connect = async () => {
          const row = await contentRow();
          committedBeforeClient =
            row.status === "fetching" &&
            row.receiving_attempt.phase === "claimed";
          expect(committedBeforeClient || row.status === "ready").toBe(true);
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
    if (!input.automatic) coordinator.dispatchContentRequests = async () => {};
    coordinator.dispatchFlagCommands = async () => {};
    cleanup.push(async () => {
      if (input.maxBytes === DISPLAY_CONTENT_BYTES)
        process.stdout.write("large-content-cleanup coordinator start\n");
      await coordinator.stop();
      if (input.maxBytes === DISPLAY_CONTENT_BYTES)
        process.stdout.write("large-content-cleanup coordinator complete\n");
    });
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    expect(await coordinator.elect()).toBe(true);
    const submit = (signal?: AbortSignal) =>
      coordinator.submit({
        kind: "content-slice",
        pendingId: message,
        offset: 0,
        maxBytes: input.maxBytes ?? 256 * 1024,
        requestId: randomUUID(),
        deadline: performance.now() + 9000,
        signal,
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: 1n,
        },
      });
    return {
      coordinator,
      submit,
      peer,
      counters: () => ({ reads, stores, bytes, committedBeforeClient }),
    };
  }

  it.each([100, 40000])(
    "accepts Gmail body-before-header FETCH ordering for %i bytes",
    async (length) => {
      await request();
      const h = await harness({
        gmailBodyFirst: true,
        bodies: [plain("x".repeat(length))],
      });
      await h.submit();
      expect(await contentRow()).toMatchObject({
        status: "ready",
        plain_text: "x".repeat(length),
      });
      expect(h.counters().stores).toBe(0);
    },
  );

  it.each(["plain", "html", "alternative", "mixed", "nested"])(
    "retrieves %s through durable intent and the established reader API",
    async (kind) => {
      const bodies: Body[] =
        kind === "plain"
          ? [plain()]
          : kind === "html"
            ? [
                {
                  type: "html",
                  value: Buffer.from(
                    '<p>uniquebodytoken</p><script>bad()</script><img src="https://remote.test/x"><img src="cid:later">',
                  ),
                },
              ]
            : [
                plain(),
                { type: "html", value: Buffer.from("<b>HTML alternative</b>") },
              ];
      await request();
      const h = await harness({
        bodies,
        mixed: kind === "mixed",
        nested: kind === "nested",
      });
      await h.submit();
      const row = await contentRow();
      expect(row.status).toBe("ready");
      expect(row.receiving_attempt.phase).toBe("succeeded");
      expect(h.counters().committedBeforeClient).toBe(true);
      const detail = await service().detail(account, source.mailbox, message);
      expect(detail.content.status).toBe("ready");
      if (kind === "html") {
        expect(detail.content.sanitizedHtml).not.toContain("<script");
        expect(detail.content.remoteContentBlocked).toBe(true);
        expect(detail.content.sanitizedHtml).toContain(
          'data-maildock-cid="later"',
        );
      } else expect(detail.content.plainText).toContain("uniquebodytoken");
      expect(
        (
          await new SearchService(database.db).search("uniquebodytoken")
        ).items.some((m) => m.id === message),
      ).toBe(true);
      expect(
        h.peer.commands.some((c) =>
          /STORE|BINARY\.PEEK|BODY\.PEEK\[\]/.test(c.command),
        ),
      ).toBe(false);
      expect(
        h.peer.commands
          .filter((c) => c.command.startsWith("UID FETCH"))
          .every((c) => c.command.startsWith("UID FETCH 1 ")),
      ).toBe(true);
      expect(h.counters().bytes).toBeLessThan(2048);
      const [placement] =
        await reader`select flags from mailbox_messages where message_id=${message}`;
      expect(placement.flags).not.toContain("\\Seen");
    },
  );
  it.each([
    { type: "plain", value: Buffer.from("Y2Fmw6k=\r\n"), encoding: "base64" },
    {
      type: "plain",
      value: Buffer.from("caf=C3=A9"),
      encoding: "quoted-printable",
    },
    {
      type: "plain",
      value: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      charset: "iso-8859-1",
    },
  ] satisfies Body[])(
    "decodes $encoding $charset using the installed MIME pipeline",
    async (body) => {
      await request();
      const h = await harness({ bodies: [body] });
      await h.submit();
      expect((await contentRow()).plain_text).toBe("café");
    },
  );
  it.each(["rejected_grant", "exchange_unknown"])(
    "OAuth blockage %s retains content/STORE demand without claims or sockets",
    async (category) => {
      await request();
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
      const [before] =
        await reader`select * from receiving_mailboxes where mailbox_id=${source.mailbox}`;
      await reader`update mail_accounts set oauth_status='reconnect_required',oauth_failure_category=${category},oauth_refresh_attempt=${randomUUID()} where id=${account}`;
      const h = await harness({ bodies: [plain()], automatic: true });
      for (let opportunity = 0; opportunity < 3; opportunity++) {
        await h.coordinator.refreshMembership();
        await h.coordinator.dispatchContentRequests();
        await expect(h.submit()).rejects.toThrow();
        await expect(
          h.coordinator.submit({
            kind: "store",
            pendingId: command.id,
            requestId: randomUUID(),
            deadline: performance.now() + 5000,
            identity: {
              account,
              mailbox: source.mailbox,
              configurationVersion: 1n,
            },
          }),
        ).rejects.toThrow();
      }
      expect(h.peer.commands).toHaveLength(0);
      expect(h.counters()).toMatchObject({ reads: 0, stores: 0 });
      expect(await contentRow()).toMatchObject({
        status: "pending",
        receiving_attempt: null,
      });
      const [intent] =
        await reader`select status,receiving_attempt from message_commands where id=${command.id}`;
      expect(intent).toMatchObject({
        status: "pending",
        receiving_attempt: null,
      });
      const [after] =
        await reader`select * from receiving_mailboxes where mailbox_id=${source.mailbox}`;
      expect(after).toEqual(before);
      const detail = await service().detail(account, source.mailbox, message);
      expect(detail.credentialAvailability?.state).toBe("reconnect_required");
      expect(detail.credentialAvailability?.message.includes("rejected")).toBe(
        category === "rejected_grant",
      );
    },
  );

  it("streams chunks across transfer encoding boundaries and requires a final empty EOF", async () => {
    const value = "a".repeat((3 * 32768) / 4);
    const encoded = Buffer.from(value).toString("base64");
    await request();
    const h = await harness({
      bodies: [
        { type: "plain", value: Buffer.from(encoded), encoding: "base64" },
      ],
    });
    await h.submit();
    expect((await contentRow()).plain_text).toBe(value);
    expect(
      h.peer.commands.some((c) => c.command.includes("<32768.32768>")),
    ).toBe(true);
  });
  it.each([
    "uid",
    "part",
    "offset",
    "short",
    "truncated",
    "no-ok",
    "duplicate",
    "structure",
    "disappear",
  ] as const)("rejects %s evidence without ready bytes", async (corrupt) => {
    const events = vi.spyOn(diagnostics, "receivingDiagnostic");
    await request();
    const h = await harness({ corrupt });
    await expect(h.submit()).rejects.toThrow();
    const row = await contentRow();
    expect(row.status).not.toBe("ready");
    expect(row.plain_text).toBeNull();
    expect(
      events.mock.calls.some(
        ([event]) =>
          event.event === "receiving.operation" &&
          event.category === "remote_stage_failed" &&
          event.stage !== "before_claim",
      ),
    ).toBe(true);
    expect(
      events.mock.calls.some(
        ([event]) =>
          event.event === "receiving.publication" &&
          event.category === "published",
      ),
    ).toBe(true);
    expect(JSON.stringify(events.mock.calls)).not.toContain("uniquebodytoken");
  });
  it.each([
    {
      type: "plain",
      value: Buffer.from("bad=QZ"),
      encoding: "quoted-printable",
    },
    { type: "plain", value: Buffer.from("YWJj!"), encoding: "base64" },
    { type: "plain", value: Buffer.from("hello"), encoding: "x-unknown" },
    { type: "plain", value: Buffer.from("hello"), charset: "x-unknown" },
    { type: "plain", value: Buffer.from([0xc3, 0x28]) },
    { type: "plain", value: Buffer.alloc(256 * 1024 + 1, 97) },
    { type: "plain", value: Buffer.alloc(150000, 0xe9), charset: "iso-8859-1" },
  ] satisfies Body[])(
    "rejects malformed, unsupported or excessive decoded content %#",
    async (body) => {
      await request();
      const h = await harness({ bodies: [body] });
      await expect(h.submit()).rejects.toThrow();
      expect((await contentRow()).status).not.toBe("ready");
      expect(h.counters().bytes).toBeLessThan(320 * 1024);
    },
  );
  it("coalesces concurrent reader requests and discovers durable demand after wake loss", async () => {
    expect(
      (await Promise.all([request(), request(), request()])).filter(Boolean),
    ).toHaveLength(1);
    const h = await harness({ automatic: true });
    await until(async () => (await contentRow()).status === "ready");
    expect(h.peer.peers).toHaveLength(1);
    expect(await request()).toBe(false);
  });
  it("rejects changed UIDVALIDITY before downloading", async () => {
    await request();
    const h = await harness({ epoch: 8 });
    await expect(h.submit()).rejects.toThrow();
    expect(h.counters().reads).toBe(0);
  });
  it("fences configuration replacement after retrieval", async () => {
    await request();
    const h = await harness({
      beforePublish: async () => {
        await reader`update mail_accounts set imap_host='replacement.test' where id=${account}`;
      },
    });
    await expect(h.submit()).rejects.toThrow();
    expect((await contentRow()).status).not.toBe("ready");
    expect(
      (
        await new SearchService(database.db).search("uniquebodytoken")
      ).items.some((m) => m.id === message),
    ).toBe(false);
  });
  it("cancellation retains a non-ready claim and the next admission restarts the exact source", async () => {
    await request();
    const gate = barrier(),
      reached = barrier();
    let first = true;
    const h = await harness({
      beforeLiteral: async () => {
        if (first) {
          first = false;
          reached.release();
          await gate.promise;
        }
      },
    });
    const abort = new AbortController();
    const task = h.submit(abort.signal);
    void task.catch(() => {});
    await reached.promise;
    abort.abort();
    gate.release();
    await expect(task).rejects.toThrow();
    expect((await contentRow()).status).toBe("fetching");
    const firstAttempt = (await contentRow()).receiving_attempt.id;
    await h.submit();
    const row = await contentRow();
    expect(row.status).toBe("ready");
    expect(row.receiving_attempt.previousAttempt).toBe(firstAttempt);
    expect(row.receiving_attempt.reads).toBe("2");
  });
  it.each(["claim", "result"] as const)(
    "recovers lost %s COMMIT under conflicting locks without another fetch",
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
                ? "maildock_receiving_content_claim"
                : "maildock_receiving_content_result",
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
      await request();
      const h = await harness();
      const pending = h.submit();
      void pending.catch(() => {});
      await until(
        async () =>
          (await contentRow()).status ===
          (phase === "claim" ? "fetching" : "ready"),
      );
      const held = await reader.reserve();
      await held`begin`;
      try {
        await held`select id from mailboxes where id=${source.mailbox} for update`;
        await until(
          async () =>
            (
              await reader`select exists(select from pg_stat_activity where datname='receiving_content' and wait_event_type='Lock' and query like '%maildock_receiving_attempt_recover%') as waiting`
            )[0].waiting === true,
        );
        if (phase === "claim") expect(h.peer.peers).toHaveLength(0);
        else expect(h.peer.peers).toHaveLength(1);
      } finally {
        await held`commit`;
        held.release();
      }
      await pending;
      expect(once).toBe(false);
      expect((await contentRow()).status).toBe("ready");
      expect((await contentRow()).receiving_attempt.reads).toBe("1");
      expect(h.peer.peers).toHaveLength(1);
    },
  );
  it("a terminal ready claim refuses any additional client", async () => {
    await request();
    const h = await harness();
    await new ReceivingPublication(executor).contentClaim(
      h.coordinator.snapshot.owner!,
      source,
      "content",
      message,
      budget(),
    );
    await h.submit();
    expect(h.peer.peers).toHaveLength(1);
    await expect(h.submit()).rejects.toThrow();
    expect(h.peer.peers).toHaveLength(1);
  });
  it("owner takeover fences old bytes and a new owner restarts a crashed read", async () => {
    await request();
    const reached = barrier(),
      release = barrier();
    const h = await harness({
      beforePublish: async () => {
        reached.release();
        await release.promise;
      },
    });
    const pending = h.submit();
    const rejection = expect(pending).rejects.toThrow();
    await reached.promise;
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`select maildock_receiving_acquire(${randomUUID()}::uuid,60000)`;
    release.release();
    await rejection;
    expect((await contentRow()).status).toBe("fetching");
    await h.coordinator.stop();
    const next = await harness();
    await next.submit();
    expect((await contentRow()).status).toBe("ready");
    expect((await contentRow()).receiving_attempt.reads).toBe("2");
  });
  it("three interrupted attempts exhaust restart admission without opening another socket", async () => {
    await request();
    const h = await harness();
    const owner = h.coordinator.snapshot.owner!;
    for (let i = 0; i < 3; i++) {
      const recovered = await new ReceivingPublication(executor).recover(
        owner,
        source,
        "content",
        message,
        budget(),
      );
      await new ReceivingPublication(executor).contentClaim(
        owner,
        { ...source, state: recovered.state },
        "content",
        message,
        budget(),
      );
    }
    await expect(h.submit()).rejects.toThrow();
    expect(h.peer.peers).toHaveLength(0);
    expect((await contentRow()).status).toBe("fetching");
  });
  it("content, flag commands and actual metadata share C=1 and preserve fresh/history fairness", async () => {
    await inbox(1025n);
    const script = { uids: [1, 1024], uidNext: 1025, boundedMailbox: true };
    const metadata = await metadataPeer(script);
    cleanup.push(metadata.cleanup);
    const admissions: string[] = [];
    let fresh = 0,
      history = 0;
    await request();
    const h = await harness({
      metadata,
      onAdmission: (a) => admissions.push(a.kind),
      onTurn: (kind) => {
        if (kind === "fresh") {
          fresh++;
          script.uids.push(script.uidNext++);
        } else history++;
      },
    });
    await h.submit();
    const commands = new MessageCommandService(
      database.db,
      async () => {
        throw new Error("Legacy enqueue forbidden");
      },
      async () => {},
    );
    for (let i = 0; i < 6; i++) {
      const command = await commands.create(
        account,
        source.mailbox,
        message,
        i === 0 ? "mark_read" : i % 2 ? "flag" : "unflag",
      );
      await h.coordinator.submit({
        kind: "store",
        pendingId: command.id,
        requestId: randomUUID(),
        deadline: performance.now() + 9000,
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: 1n,
        },
      });
    }
    expect(admissions[0]).toBe("fresh");
    expect(fresh).toBeGreaterThan(1);
    expect(history).toBeGreaterThan(0);
    expect(admissions.indexOf("history")).toBeLessThan(
      admissions.lastIndexOf("store"),
    );
    expect(admissions.filter((k) => k === "content-slice")).toHaveLength(1);
    expect(h.counters().stores).toBe(6);
    expect((await contentRow()).status).toBe("ready");
    const [placement] =
      await reader`select flags from mailbox_messages where message_id=${message}`;
    expect(placement.flags).toContain("\\Seen");
    expect(metadata.observed.every((client) => !client.usable)).toBe(true);
  });
  it.each(["base64", "quoted-printable"])(
    "preserves decoder state across split %s tokens",
    async (encoding) => {
      const value =
        encoding === "base64"
          ? Buffer.from("ż".repeat(20000))
              .toString("base64")
              .match(/.{1,76}/g)!
              .join("\r\n")
          : "a".repeat(32767) + "=C3=\r\n=B3";
      await request();
      const h = await harness({
        bodies: [{ type: "plain", encoding, value: Buffer.from(value) }],
      });
      await h.submit();
      expect((await contentRow()).plain_text).toBe(
        encoding === "base64" ? "ż".repeat(20000) : "a".repeat(32767) + "ó",
      );
    },
  );
  it("timeout retires a blocked literal and retains a recoverable claim", async () => {
    await request();
    const entered = barrier(),
      release = barrier();
    const h = await harness({
      beforeLiteral: async () => {
        entered.release();
        await release.promise;
      },
    });
    const pending = h.coordinator.submit({
      kind: "content-slice",
      pendingId: message,
      offset: 0,
      maxBytes: 256 * 1024,
      requestId: randomUUID(),
      deadline: performance.now() + 2000,
      identity: { account, mailbox: source.mailbox, configurationVersion: 1n },
    });
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    await rejection;
    release.release();
    expect((await contentRow()).status).toBe("fetching");
  });
  it.each([
    '("APPLICATION" "OCTET-STREAM" NIL NIL NIL "8BIT" 100 NIL NIL NIL NIL)',
    '("TEXT" "PLAIN" ("CHARSET" "utf-8" "CHARSET" "windows-1250") NIL NIL "8bit" 1 1 NIL NIL NIL NIL)',
  ])(
    "rejects missing or ambiguous display structure before downloading %#",
    async (structureOverride) => {
      await request();
      const h = await harness({ structureOverride });
      await expect(h.submit()).rejects.toThrow();
      expect(h.counters().bytes).toBe(0);
      expect((await contentRow()).status).toBe("failed");
    },
  );
  it("epoch replacement after complete transfer fences publication and hides old search text", async () => {
    await request();
    const h = await harness({
      beforePublish: async () => {
        const [state] =
          await reader`select revision from receiving_mailboxes where mailbox_id=${source.mailbox}`;
        await new ReceivingPersistence(executor).persist(
          h.coordinator.snapshot.owner!,
          source.mailbox,
          { ...source.state, revision: BigInt(state.revision) },
          { kind: "epoch", complete: true, epoch: 8n, uidNext: 2n },
          budget(),
        );
      },
    });
    await expect(h.submit()).rejects.toThrow();
    expect((await contentRow()).status).not.toBe("ready");
    expect(
      (
        await new SearchService(database.db).search("uniquebodytoken")
      ).items.some((m) => m.id === message),
    ).toBe(false);
  });
  it("content and flags wait behind an actual owned metadata socket at C=1", async () => {
    await inbox(1n);
    const entered = barrier(),
      release = barrier();
    const metadata = await metadataPeer({
      uids: [],
      uidNext: 1,
      boundedMailbox: true,
      onCommand: (p, c) => {
        if (c.command.startsWith("SELECT")) {
          entered.release();
          void release.promise.then(() => {
            p.send(
              "* 0 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT 1] Next\r\n",
              c,
            );
            p.ok(c, "OK [READ-WRITE] Selected");
          });
          return true;
        }
      },
    });
    cleanup.push(metadata.cleanup);
    await request();
    const h = await harness({ metadata });
    await entered.promise;
    const content = h.submit();
    const command = await new MessageCommandService(
      database.db,
      async () => {
        throw new Error("Legacy enqueue forbidden");
      },
      async () => {},
    ).create(account, source.mailbox, message, "mark_read");
    const flags = h.coordinator.submit({
      kind: "store",
      pendingId: command.id,
      requestId: randomUUID(),
      deadline: performance.now() + 9000,
      identity: { account, mailbox: source.mailbox, configurationVersion: 1n },
    });
    await until(() => h.coordinator.snapshot.scheduler?.pending === 2);
    expect(h.peer.peers).toHaveLength(0);
    release.release();
    await Promise.all([content, flags]);
    expect((await contentRow()).status).toBe("ready");
    expect(h.counters().stores).toBe(1);
    expect(
      (
        await reader`select status from message_commands where id=${command.id}`
      )[0].status,
    ).toBe("succeeded");
  });
  it("rejects excessive aggregate alternative output without caching a partial body", async () => {
    await request();
    const h = await harness({
      bodies: [
        {
          type: "plain",
          charset: "iso-8859-1",
          value: Buffer.alloc(100000, 0xe9),
        },
        {
          type: "html",
          charset: "iso-8859-1",
          value: Buffer.alloc(100000, 0xe9),
        },
      ],
    });
    await expect(h.submit()).rejects.toThrow();
    const row = await contentRow();
    expect(row.status).toBe("failed");
    expect(row.plain_text).toBeNull();
    expect(row.sanitized_html).toBeNull();
    expect(h.counters().bytes).toBeLessThan(320 * 1024);
  });
  it("retains complete flowed input when decoding shrinks a later alternative", async () => {
    await request();
    const h = await harness({
      bodies: [
        {
          type: "plain",
          charset: "iso-8859-1",
          value: Buffer.alloc(130000, 0xe9),
        },
        {
          type: "html",
          flowed: true,
          value: Buffer.from("x \r\n".repeat(750) + "ENDMARKER"),
        },
      ],
    });
    await h.submit();
    const row = await contentRow();
    expect(row.status).toBe("ready");
    expect(row.plain_text.length).toBe(130000);
    expect(row.sanitized_html).toContain("ENDMARKER");
  });
  it("accepts literal MIME strings while keeping numeric identity validation strict", async () => {
    await request();
    const body = plain();
    const h = await harness({
      bodies: [body],
      structureOverride: `("TEXT" "PLAIN" ("CHARSET" {5}\r\nutf-8) NIL NIL "8bit" ${body.value.length} 1 NIL NIL NIL NIL)`,
    });
    await h.submit();
    expect((await contentRow()).status).toBe("ready");
    expect((await contentRow()).plain_text).toBe(body.value.toString());
  });
  it("plain empty text is a complete display result", async () => {
    await request();
    const h = await harness({ bodies: [plain("")] });
    await h.submit();
    expect((await contentRow()).plain_text).toBe("");
    expect((await contentRow()).status).toBe("ready");
  });

  it.each([
    { name: "300 KiB plain", plainBytes: 300 * 1024, htmlBytes: 0 },
    { name: "2 MiB HTML", plainBytes: 0, htmlBytes: 2 * 1024 * 1024 },
    {
      name: "nested 4.5 MiB alternatives",
      plainBytes: 2 * 1024 * 1024,
      htmlBytes: 2.5 * 1024 * 1024,
      nested: true,
    },
    { name: "exact 5 MiB", plainBytes: DISPLAY_CONTENT_BYTES, htmlBytes: 0 },
    {
      name: "exact 5 MiB alternatives",
      plainBytes: 3 * 1024 * 1024,
      htmlBytes: 2 * 1024 * 1024,
    },
  ])(
    "fetches and atomically publishes $name within the unchanged deadline",
    async ({ plainBytes, htmlBytes, nested }) => {
      const bodies: Body[] = [];
      global.gc?.();
      const initialMemory = process.memoryUsage();
      let sampledBuffers = initialMemory.arrayBuffers;
      let sampledHeap = initialMemory.heapUsed;
      const sampleMemory = () => {
        const memory = process.memoryUsage();
        sampledBuffers = Math.max(sampledBuffers, memory.arrayBuffers);
        sampledHeap = Math.max(sampledHeap, memory.heapUsed);
      };
      const token = "largecontenttoken ";
      if (plainBytes)
        bodies.push(plain(token + "a".repeat(plainBytes - token.length)));
      if (htmlBytes)
        bodies.push({
          type: "html",
          value: Buffer.from(
            "<p>" + token + "b".repeat(htmlBytes - token.length - 7) + "</p>",
          ),
        });
      await request();
      const h = await harness({
        bodies,
        nested,
        mixed: true,
        maxBytes: DISPLAY_CONTENT_BYTES,
        sliceDelayMs: 2,
        beforeLiteral: async () => sampleMemory(),
        beforePublish: async () => {
          sampleMemory();
          expect(
            (await service().detail(account, source.mailbox, message)).content
              .status,
          ).not.toBe("ready");
          expect(
            (
              await new SearchService(database.db).search("largecontenttoken")
            ).items.some((item) => item.id === message),
          ).toBe(false);
        },
      });
      const started = performance.now();
      await h.submit();
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(9000);
      const row = await contentRow();
      sampleMemory();
      expect(sampledBuffers - initialMemory.arrayBuffers).toBeLessThan(
        96 * 1024 * 1024,
      );
      // Peak heap includes transient DOMs and GC scheduling. Check retained
      // memory after collection, and report the sampled transient peak separately.
      await new Promise<void>((resolve) => setImmediate(resolve));
      global.gc?.();
      const retainedMemory = process.memoryUsage();
      if (global.gc)
        expect(retainedMemory.heapUsed - initialMemory.heapUsed).toBeLessThan(
          128 * 1024 * 1024,
        );
      expect(row.status).toBe("ready");
      expect(Buffer.byteLength(row.plain_text ?? "")).toBe(plainBytes);
      expect(Buffer.byteLength(row.sanitized_html ?? "")).toBe(htmlBytes);
      expect(
        (await service().detail(account, source.mailbox, message)).content
          .status,
      ).toBe("ready");
      expect(
        (
          await new SearchService(database.db).search("largecontenttoken")
        ).items.some((item) => item.id === message),
      ).toBe(true);
      const fetches = h.peer.commands.filter((c) =>
        c.command.startsWith("UID FETCH"),
      );
      expect(fetches.every((c) => c.command.startsWith("UID FETCH 1 "))).toBe(
        true,
      );
      expect(
        h.peer.commands.some((c) =>
          /STORE|RFC822(?!\.SIZE)|BODY\.PEEK\[\]|BODY\.PEEK\[2(?:\]|\.)/.test(
            c.command,
          ),
        ),
      ).toBe(false);
      expect(h.counters().bytes).toBeGreaterThanOrEqual(plainBytes + htmlBytes);
      expect(h.counters().bytes).toBeLessThan(
        plainBytes + htmlBytes + 2 * 16384,
      );
      for (const c of fetches)
        for (const m of c.command.matchAll(/<(\d+)\.(\d+)>/g))
          expect(Number(m[2])).toBe(32768);
      process.stdout.write(
        "large-content-evidence " +
          JSON.stringify({
            plainBytes,
            htmlBytes,
            elapsed,
            transferred: h.counters().bytes,
            fetches: fetches.length,
            sampledBufferGrowth: sampledBuffers - initialMemory.arrayBuffers,
            sampledHeapGrowth: sampledHeap - initialMemory.heapUsed,
            retainedHeapGrowth:
              retainedMemory.heapUsed - initialMemory.heapUsed,
          }) +
          "\n",
      );
    },
  );

  it("automatically discovers and publishes more than 2 MiB without a manual maxBytes override", async () => {
    await request();
    const h = await harness({
      automatic: true,
      bodies: [plain("a".repeat(3 * 1024 * 1024))],
    });
    await until(async () => (await contentRow()).status === "ready");
    expect((await contentRow()).plain_text.length).toBe(3 * 1024 * 1024);
    expect(h.peer.peers).toHaveLength(1);
  });

  it.each(["encoded", "decoded", "aggregate"])(
    "rejects a group exceeding 5 MiB %s without partial publication",
    async (kind) => {
      await request();
      const bodies: Body[] =
        kind === "encoded"
          ? [plain("a".repeat(DISPLAY_CONTENT_BYTES + 1))]
          : kind === "decoded"
            ? [
                {
                  type: "plain",
                  value: Buffer.alloc(DISPLAY_CONTENT_BYTES / 2 + 1, 0xe9),
                  charset: "iso-8859-1",
                },
              ]
            : [
                plain("a".repeat(3 * 1024 * 1024)),
                { type: "html", value: Buffer.alloc(3 * 1024 * 1024, 98) },
              ];
      const h = await harness({ bodies, maxBytes: DISPLAY_CONTENT_BYTES });
      await expect(h.submit()).rejects.toThrow();
      const row = await contentRow();
      expect(row.status).toBe("failed");
      expect(
        (await service().detail(account, source.mailbox, message)).content
          .error,
      ).toContain("5 MiB");
      expect(row.plain_text).toBeNull();
      expect(row.sanitized_html).toBeNull();
      expect(h.counters().bytes).toBeLessThan(DISPLAY_CONTENT_BYTES + 32768);
      if (kind === "encoded") expect(h.counters().bytes).toBe(0);
    },
  );

  it.each(["base64", "quoted-printable", "utf8", "legacy", "flowed"])(
    "decodes large %s across partial windows without losing the trailing marker",
    async (kind) => {
      const text =
        (kind === "legacy" ? "café " : "Zażółć ").repeat(45000) + "ENDMARKER";
      const body: Body =
        kind === "base64"
          ? {
              type: "plain",
              encoding: "base64",
              value: Buffer.from(Buffer.from(text).toString("base64")),
            }
          : kind === "quoted-printable"
            ? {
                type: "plain",
                encoding: "quoted-printable",
                value: Buffer.from(
                  Buffer.from(text)
                    .toString("hex")
                    .replace(/../g, (hex) => "=" + hex),
                ),
              }
            : kind === "legacy"
              ? {
                  type: "plain",
                  charset: "iso-8859-1",
                  value: Buffer.from(text, "latin1"),
                }
              : kind === "flowed"
                ? {
                    type: "plain",
                    flowed: true,
                    value: Buffer.from("x \r\n".repeat(90000) + "ENDMARKER"),
                  }
                : plain(text);
      await request();
      const h = await harness({
        bodies: [body],
        maxBytes: DISPLAY_CONTENT_BYTES,
      });
      await h.submit();
      const row = await contentRow();
      expect(row.status).toBe("ready");
      expect(row.plain_text).toContain("ENDMARKER");
      if (kind !== "flowed") expect(row.plain_text).toBe(text);
    },
  );

  it.each(["truncated", "short", "part", "offset"] as const)(
    "rejects a large transfer with %s final slice",
    async (corrupt) => {
      await request();
      const h = await harness({
        bodies: [plain("a".repeat(3 * 1024 * 1024 + 17))],
        maxBytes: DISPLAY_CONTENT_BYTES,
        corrupt,
        corruptAtOffset: 3 * 1024 * 1024,
      });
      await expect(h.submit()).rejects.toThrow();
      expect((await contentRow()).status).not.toBe("ready");
      expect((await contentRow()).plain_text).toBeNull();
    },
  );

  it.each(["cancel", "configuration", "epoch"])(
    "fences %s during a large transfer after multiple slices",
    async (kind) => {
      await request();
      const abort = new AbortController();
      let slices = 0;
      const h = await harness({
        bodies: [plain("a".repeat(3 * 1024 * 1024))],
        maxBytes: DISPLAY_CONTENT_BYTES,
        beforeLiteral: async () => {
          if (++slices !== 5) return;
          if (kind === "cancel") abort.abort();
          else if (kind === "configuration")
            await reader`update mail_accounts set imap_host='replacement.test' where id=${account}`;
          else {
            const [s] =
              await reader`select * from receiving_mailboxes where mailbox_id=${source.mailbox}`;
            await new ReceivingPersistence(executor).persist(
              h.coordinator.snapshot.owner!,
              source.mailbox,
              {
                epoch: BigInt(s.epoch),
                revision: BigInt(s.revision),
                freshThrough: BigInt(s.fresh_through),
                historyBefore: BigInt(s.history_before),
                reconcileAfter: BigInt(s.reconcile_after),
              },
              { kind: "epoch", complete: true, epoch: 8n, uidNext: 2n },
              budget(),
            );
          }
        },
      });
      await expect(h.submit(abort.signal)).rejects.toThrow();
      expect(slices).toBeGreaterThanOrEqual(5);
      expect((await contentRow()).status).not.toBe("ready");
      expect(h.peer.peers.every((p) => p.socket.destroyed)).toBe(true);
    },
  );
});
