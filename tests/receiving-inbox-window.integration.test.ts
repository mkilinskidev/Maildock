import { randomUUID } from "node:crypto";
import postgres from "postgres";
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
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import {
  ReceivingExecutor,
  ReceivingUnresolvedError,
} from "@/shared/infrastructure/database/receiving-executor";
import {
  claimReceiving,
  recoverReceiving,
} from "@/shared/infrastructure/database/receiving-authority";
import { sql } from "drizzle-orm";
import { persistMessageMetadata } from "@/modules/mail/application/message-metadata-persistence";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { receiveInboxWindow } from "@/modules/mail/application/receiving-inbox-window";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { delay } from "../experiments/imap-transport/fixture";

const budget = (ms = 5000) => ({ deadline: performance.now() + ms });
describe("isolated INBOX wire evidence into Stage 1 PostgreSQL", () => {
  let container: StartedTestContainer;
  let url: string;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let actor: string, generation: bigint, mailbox: string;
  const cleanup: (() => Promise<unknown>)[] = [];
  const owner = () => ({ actor, generation });
  beforeAll(async () => {
    // Always disposable; deliberately ignores TEST_DATABASE_URL.
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
    await root`create database stage2 owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/stage2`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    actor = randomUUID();
    const [term] =
      await reader`select maildock_receiving_takeover(${actor},60000) as generation`;
    generation = BigInt(term.generation);
    const account = randomUUID();
    mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Stage2 fixture",
      email: "fixture@example.test",
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
      remotePath: "INBOX",
      name: "INBOX",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const executor = (address = url) => {
    const exec = new ReceivingExecutor(address, 1);
    cleanup.push(() => exec.stop());
    return exec;
  };
  const state = async () =>
    (
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`
    )[0];
  const count = async () =>
    Number(
      (
        await reader`select count(*) from mailbox_messages where mailbox_id=${mailbox}`
      )[0].count,
    );
  async function wire(config: WindowPeerOptions = {}) {
    const peer = await metadataPeer(config);
    cleanup.push(peer.cleanup);
    return peer;
  }
  async function initialize(exec: ReceivingExecutor) {
    await new ReceivingPersistence(exec).initialize(
      owner(),
      mailbox,
      { complete: true, epoch: 7n, uidNext: 257n },
      budget(),
    );
  }
  const options = () => ({ ...budget(9000), assertCurrent: () => {} });

  it.each([
    { uids: Array.from({ length: 128 }, (_, i) => i + 129) },
    { uids: [129, 211, 256] },
    { uids: [] },
  ])("atomic first window %j", async (config) => {
    const peer = await wire(config),
      exec = executor();
    const result = await receiveInboxWindow(
      {
        connection: peer.connection,
        executor: exec,
        owner: owner(),
        mailbox,
        initialized: false,
        options: options(),
      },
      peer.createClient,
    );
    expect(result.count).toBe(config.uids.length);
    expect(await count()).toBe(config.uids.length);
    const saved = await state();
    expect(BigInt(saved.epoch)).toBe(7n);
    expect(BigInt(saved.history_before)).toBe(129n);
    expect(BigInt(saved.fresh_through)).toBe(256n);
    expect(BigInt(saved.reconcile_after)).toBe(0n);
    expect(BigInt(saved.revision)).toBe(1n);
    const messages =
      await reader`select m.subject, m.mime_structure, m.references from messages m join mailbox_messages p on p.message_id=m.id where p.mailbox_id=${mailbox}`;
    expect(
      messages.every(
        (m) =>
          m.subject.startsWith("Fixture ") &&
          m.mime_structure &&
          m.references === "<parent@example.test>",
      ),
    ).toBe(true);
    expect(
      Number(
        (
          await reader`select count(*) from notification_events where mailbox_id=${mailbox}`
        )[0].count,
      ),
    ).toBe(0);
  });
  it("saved E/revision are used for the next explicitly invoked window", async () => {
    const first = await wire({ uids: [] }),
      exec = executor();
    await receiveInboxWindow(
      {
        connection: first.connection,
        executor: exec,
        owner: owner(),
        mailbox,
        initialized: false,
        options: options(),
      },
      first.createClient,
    );
    const second = await wire({
      uids: [1, 128],
      uidNext: 500,
      staleStatus: true,
    });
    const result = await receiveInboxWindow(
      {
        connection: second.connection,
        executor: exec,
        owner: owner(),
        mailbox,
        initialized: true,
        options: options(),
      },
      second.createClient,
    );
    expect(result.state.historyBefore).toBe(1n);
    expect(result.state.freshThrough).toBe(256n);
    expect(result.state.revision).toBe(2n);
    expect(
      second.commands.find((c) => c.command.startsWith("UID SEARCH"))?.command,
    ).toBe("UID SEARCH UID 1:128");
    expect(second.commands.some((c) => c.command.startsWith("STATUS"))).toBe(
      false,
    );
  });
  it("persists MIME attachment descriptors while leaving content unavailable", async () => {
    const peer = await wire({ uids: [129], attachment: true }),
      exec = executor();
    await receiveInboxWindow(
      {
        connection: peer.connection,
        executor: exec,
        owner: owner(),
        mailbox,
        initialized: false,
        options: options(),
      },
      peer.createClient,
    );
    const [part] =
      await reader`select * from message_attachments where source_mailbox_id=${mailbox}`;
    expect(part.filename).toBe("fixture.pdf");
    expect(part.part_id).toBe("2");
    expect(part.content_type).toBe("application/pdf");
    expect(part.blob_id).toBeNull();
    expect(
      peer.commands.filter((c) => c.command.startsWith("UID FETCH")),
    ).toHaveLength(1);
    expect(
      peer.commands.find((c) => c.command.startsWith("UID FETCH"))?.command,
    ).toContain("BODY.PEEK[HEADER.FIELDS");
  });
  it("retains a legal last BODYSTRUCTURE disposition and filename", async () => {
    const peer = await wire({ uids: [129], minimalDisposition: true }),
      exec = executor();
    await receiveInboxWindow(
      {
        connection: peer.connection,
        executor: exec,
        owner: owner(),
        mailbox,
        initialized: false,
        options: options(),
      },
      peer.createClient,
    );
    const [part] =
      await reader`select * from message_attachments where source_mailbox_id=${mailbox}`;
    expect(part.filename).toBe("fixture.pdf");
    expect(part.disposition).toBe("attachment");
  });
  it("UIDNEXT=1 initializes an exhausted empty mailbox without a reversed interval", async () => {
    const peer = await wire({ uidNext: 1, uids: [] }),
      exec = executor();
    const result = await receiveInboxWindow(
      {
        connection: peer.connection,
        executor: exec,
        owner: owner(),
        mailbox,
        initialized: false,
        options: options(),
      },
      peer.createClient,
    );
    expect(result).toMatchObject({
      count: 0,
      exhausted: true,
      state: { historyBefore: 1n, freshThrough: 0n, revision: 0n },
    });
    expect(peer.commands.some((c) => c.command.startsWith("UID SEARCH"))).toBe(
      false,
    );
  });
  it.each([
    { fetch: "missing" },
    { search: "absent" },
    { epoch: 8 },
    { fetch: "hung" },
  ] as WindowPeerOptions[])(
    "aborted wire %j leaves metadata/frontier unchanged",
    async (config) => {
      const peer = await wire(config),
        exec = executor();
      await initialize(exec);
      await expect(
        receiveInboxWindow(
          {
            connection: peer.connection,
            executor: exec,
            owner: owner(),
            mailbox,
            initialized: true,
            options: { ...budget(500), assertCurrent: () => {} },
          },
          peer.createClient,
        ),
      ).rejects.toThrow();
      expect(BigInt((await state()).history_before)).toBe(257n);
      expect(BigInt((await state()).revision)).toBe(0n);
      expect(await count()).toBe(0);
    },
  );
  it("failed new-mailbox wire operation does not initialize receiving", async () => {
    const peer = await wire({ fetch: "missing" }),
      exec = executor();
    await expect(
      receiveInboxWindow(
        {
          connection: peer.connection,
          executor: exec,
          owner: owner(),
          mailbox,
          initialized: false,
          options: options(),
        },
        peer.createClient,
      ),
    ).rejects.toThrow();
    expect(await state()).toBeUndefined();
    expect(await count()).toBe(0);
  });
  it("revoked turn after complete FETCH cannot initialize/publish", async () => {
    const peer = await wire(),
      exec = executor();
    await expect(
      receiveInboxWindow(
        {
          connection: peer.connection,
          executor: exec,
          owner: owner(),
          mailbox,
          initialized: false,
          options: {
            ...budget(9000),
            assertCurrent: () => {
              if (peer.observed[0]?.isClosed)
                throw new Error("Turn invalidated before publication");
            },
          },
        },
        peer.createClient,
      ),
    ).rejects.toThrow("Turn invalidated");
    expect(await state()).toBeUndefined();
    expect(await count()).toBe(0);
  });
  it("bounded placement prefetch preserves existing identity and newer flags", async () => {
    const exec = executor();
    await initialize(exec);
    const initial = await recoverReceiving(exec, owner(), mailbox, budget());
    const [folder] =
      await reader`select account_id from mailboxes where id=${mailbox}`;
    const remote = {
      uid: "129",
      modseq: "9",
      internalDate: "2026-01-01T00:00:00Z",
      size: "100",
      flags: ["\\Answered"],
      hasAttachments: false,
      envelope: {
        messageId: "<existing@example.test>",
        from: [],
        sender: [],
        replyTo: [],
        to: [],
        cc: [],
        bcc: [],
      },
    };
    await exec.transaction(async (db) => {
      await claimReceiving(db, owner(), mailbox, initial);
      await persistMessageMetadata(
        db,
        folder.account_id,
        mailbox,
        7n,
        [remote],
        false,
        false,
      );
      await db.execute(
        sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${mailbox}::uuid`,
      );
    }, budget());
    const [before] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    const expected = await recoverReceiving(exec, owner(), mailbox, budget());
    await new ReceivingPersistence(exec).persist(
      owner(),
      mailbox,
      expected,
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 129n,
          high: 256n,
          searched: [129n],
          confirmedAbsent: [],
        },
        metadata: [{ ...remote, modseq: "2", flags: ["\\Seen"] }],
      },
      budget(2000),
    );
    const [after] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    expect(after.id).toBe(before.id);
    expect(after.message_id).toBe(before.message_id);
    expect(after.flags).toEqual(["\\Answered"]);
    expect(BigInt(after.modseq)).toBe(9n);
    expect(await count()).toBe(1);
    expect(BigInt((await state()).history_before)).toBe(129n);
  });
  it("actual lost COMMIT reply is unresolved, then recovered under Stage 1 locks", async () => {
    const exec = executor();
    await initialize(exec);
    await reader.unsafe(
      `CREATE FUNCTION stage2_hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.revision=1 THEN PERFORM pg_advisory_xact_lock(818237); END IF; RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER zzz_stage2_hold AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stage2_hold_commit();`,
    );
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(818237)`;
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const lossy = executor(relay.url),
      peer = await wire();
    const pending = receiveInboxWindow(
      {
        connection: peer.connection,
        executor: lossy,
        owner: owner(),
        mailbox,
        initialized: true,
        options: options(),
      },
      peer.createClient,
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(
      ReceivingUnresolvedError,
    );
    try {
      const end = performance.now() + 1500;
      while (
        !(
          await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
        ).length
      ) {
        if (performance.now() >= end)
          throw new Error("COMMIT barrier not reached");
        await delay(5);
      }
      relay.control.drop = true;
      await blocker`select pg_advisory_unlock(818237)`;
      await rejected;
      const recovered = await recoverReceiving(
        exec,
        owner(),
        mailbox,
        budget(),
      );
      expect(recovered.historyBefore).toBe(129n);
      expect(recovered.revision).toBe(1n);
      expect(await count()).toBe(2);
    } finally {
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_stage2_hold ON receiving_mailboxes; DROP FUNCTION stage2_hold_commit();",
      );
    }
  });
});
