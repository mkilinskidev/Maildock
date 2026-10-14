import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import type { ReceivingOwner } from "@/shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import {
  ReceivingPublication,
  type IntentKind,
  type PublicationSource,
} from "@/modules/mail/application/receiving-publication";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { runReceivingOperation } from "@/modules/mail/application/receiving-operation";

const budget = () => ({ deadline: performance.now() + 5000 });
describe("R04 operation-specific receiving publication", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let publication: ReceivingPublication;
  let owner: ReceivingOwner;
  let source: PublicationSource;
  let account: string, message: string, command: string, attachment: string;
  let url: string;
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
    await root`create database receiving_publication owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_publication`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 2);
    publication = new ReceivingPublication(executor);
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    owner = { actor, generation: BigInt(lease.generation) };
    account = randomUUID();
    const mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Publication fixture",
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
      name: "INBOX",
      remotePath: "INBOX",
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
            flags: [],
            hasAttachments: true,
            envelope: {
              messageId: `<${account}@example.test>`,
              subject: "Fixture",
              from: [],
              sender: [],
              replyTo: [],
              to: [],
              cc: [],
              bcc: [],
            },
            mimeStructure: {
              part: "1",
              type: "application/pdf",
              disposition: "attachment",
              filename: "fixture.pdf",
              encoding: "base64",
              size: "10",
              contentId: null,
              parameters: {},
              dispositionParameters: {},
              children: [],
            },
          },
        ],
      },
      budget(),
    );
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
    const [placement] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    message = placement.message_id;
    command = randomUUID();
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding)
      values(${command},${account},${mailbox},${placement.id},${message},'mark_read','INBOX',7,1,1)`;
    await reader`select maildock_receiving_content_request(${account}::uuid,${mailbox}::uuid,${message}::uuid)`;
    const [descriptor] =
      await reader`select id from message_attachments where message_id=${message}`;
    attachment = descriptor.id;
    await reader`select maildock_receiving_attachment_request(${account}::uuid,${attachment}::uuid)`;
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const intent = (kind: IntentKind) =>
    kind === "command" ? command : kind === "content" ? message : attachment;
  const next = () => ({
    ...source,
    state: { ...source.state, revision: source.state.revision + 1n },
  });
  async function facts() {
    const [row] = await reader`select to_jsonb(s) as state,
      (select jsonb_agg(to_jsonb(p) order by id) from mailbox_messages p where mailbox_id=${source.mailbox}) as placements,
      (select to_jsonb(m) from messages m where id=${message}) as message
      from receiving_mailboxes s where mailbox_id=${source.mailbox}`;
    return row;
  }
  for (const kind of ["command", "content", "attachment"] as const) {
    it(`${kind}: concurrent claims execute once and preserve F/E/R`, async () => {
      const before = await facts();
      const results = await Promise.allSettled([
        publication.claim(owner, source, kind, intent(kind), budget()),
        publication.claim(owner, source, kind, intent(kind), budget()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const after = await facts();
      expect(after.placements).toEqual(before.placements);
      expect(after.message).toEqual(before.message);
      expect(after.state).toEqual({ ...before.state, revision: 2 });
    });
    it(`${kind}: exact matching failure settles atomically; duplicate callback fails`, async () => {
      const attempt = await publication.claim(
        owner,
        source,
        kind,
        intent(kind),
        budget(),
      );
      source = next();
      await publication.fail(
        owner,
        source,
        kind,
        intent(kind),
        attempt.id,
        "failed_before_execution",
        budget(),
      );
      source = next();
      await expect(
        publication.fail(
          owner,
          source,
          kind,
          intent(kind),
          attempt.id,
          "failed_before_execution",
          budget(),
        ),
      ).rejects.toThrow();
      const recovered = await publication.recover(
        owner,
        source,
        kind,
        intent(kind),
        budget(),
      );
      expect(recovered.intent.status).toBe("failed");
      expect(recovered.state).toEqual(source.state);
    });
    it(`${kind}: wrong attempt and mixed writes roll back`, async () => {
      const attempt = await publication.claim(
        owner,
        source,
        kind,
        intent(kind),
        budget(),
      );
      source = next();
      const before = await facts();
      await expect(
        publication.fail(
          owner,
          source,
          kind,
          intent(kind),
          randomUUID(),
          "failed_before_execution",
          budget(),
        ),
      ).rejects.toThrow();
      await expect(
        executor.transaction(async (db) => {
          const expected = JSON.stringify(source.state, (_, value) =>
            typeof value === "bigint" ? String(value) : value,
          );
          await db.execute(
            sql`select maildock_receiving_attempt_failure(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${expected}::jsonb,1::bigint,${kind},${intent(kind)}::uuid,${attempt.id}::uuid,'failed_before_execution')`,
          );
          await db.execute(
            sql`update messages set subject='forbidden' where id=${message}::uuid`,
          );
        }, budget()),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  }
  it("rejects wrong actor, term, revision, epoch, configuration and forged kind", async () => {
    const before = await facts();
    for (const [candidate, scoped, kind] of [
      [{ ...owner, actor: randomUUID() }, source, "content"],
      [{ ...owner, generation: owner.generation + 1n }, source, "content"],
      [
        owner,
        { ...source, state: { ...source.state, revision: 0n } },
        "content",
      ],
      [owner, { ...source, state: { ...source.state, epoch: 8n } }, "content"],
      [owner, { ...source, configuration: 2n }, "content"],
      [owner, source, "metadata"],
    ] as const) {
      await expect(
        publication.claim(
          candidate,
          scoped,
          kind as IntentKind,
          message,
          budget(),
        ),
      ).rejects.toThrow();
    }
    expect(await facts()).toEqual(before);
  });
  it("late callback cannot settle a newer content attempt", async () => {
    const first = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    await publication.fail(
      owner,
      source,
      "content",
      message,
      first.id,
      "failed_remote_read",
      budget(),
    );
    source = next();
    await reader`select maildock_receiving_content_request(${account}::uuid,${source.mailbox}::uuid,${message}::uuid)`;
    const second = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    expect(second.id).not.toBe(first.id);
    await expect(
      publication.fail(
        owner,
        source,
        "content",
        message,
        first.id,
        "failed_remote_read",
        budget(),
      ),
    ).rejects.toThrow();
    expect(
      (await publication.recover(owner, source, "content", message, budget()))
        .intent.status,
    ).toBe("fetching");
  });
  it("expired lease and changed account configuration cannot publish", async () => {
    const attempt = await publication.claim(
      owner,
      source,
      "command",
      command,
      budget(),
    );
    source = next();
    await reader`update mail_accounts set imap_host='replacement.invalid' where id=${account}`;
    await expect(
      publication.fail(
        owner,
        source,
        "command",
        command,
        attempt.id,
        "uncertain_remote_execution",
        budget(),
      ),
    ).rejects.toThrow();
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await expect(
      publication.claim(owner, source, "content", message, budget()),
    ).rejects.toThrow();
  });
  it("disable/re-enable ABA fences a claimed attempt", async () => {
    const attempt = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    await reader`update mail_accounts set enabled=false where id=${account}`;
    await reader`update mail_accounts set enabled=true where id=${account}`;
    const before = await facts();
    await expect(
      publication.fail(
        owner,
        source,
        "content",
        message,
        attempt.id,
        "failed_remote_read",
        budget(),
      ),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("expiry before L rolls a successful claim back", async () => {
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const expected = JSON.stringify(source.state, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    await reader`update receiving_coordinator set expires_at=clock_timestamp()+interval '500 milliseconds'`;
    const before = await facts();
    const pending = executor
      .transaction(async (db) => {
        await db.execute(
          sql`select maildock_receiving_attempt_claim(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${expected}::jsonb,1::bigint,'content',${message}::uuid,${randomUUID()}::uuid)`,
        );
        entered();
        await barrier;
      }, budget())
      .catch((error) => error);
    try {
      await ready;
      const end = performance.now() + 2000;
      while (performance.now() < end) {
        const [r] =
          await reader`select expires_at<=clock_timestamp() as expired from receiving_coordinator`;
        if (r.expired) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(await facts()).toEqual(before);
  });
  it("uncertain command records repair demand without canonical rollback", async () => {
    const attempt = await publication.claim(
      owner,
      source,
      "command",
      command,
      budget(),
    );
    source = next();
    const before = await facts();
    await publication.fail(
      owner,
      source,
      "command",
      command,
      attempt.id,
      "uncertain_remote_execution",
      budget(),
    );
    const after = await facts();
    expect(after.placements).toEqual(before.placements);
    expect(after.message).toEqual(before.message);
    const [row] =
      await reader`select error,receiving_attempt from message_commands where id=${command}`;
    expect(row.error).toBe("uncertain_remote_execution");
    expect(row.receiving_attempt.phase).toBe("uncertain_remote_execution");
  });
  it("STORE result validates desired flag evidence and preserves coverage", async () => {
    const attempt = await publication.claim(
      owner,
      source,
      "command",
      command,
      budget(),
    );
    source = next();
    const before = await facts();
    await expect(
      publication.commandResult(
        owner,
        source,
        command,
        attempt.id,
        { complete: true, epoch: 7n, uid: 1n, flags: [], modseq: 3n },
        budget(),
      ),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
    await publication.commandResult(
      owner,
      source,
      command,
      attempt.id,
      {
        complete: true,
        epoch: 7n,
        uid: 1n,
        flags: ["\\Seen", "custom"],
        modseq: 3n,
      },
      budget(),
    );
    source = next();
    const recovered = await publication.recover(
      owner,
      source,
      "command",
      command,
      budget(),
    );
    expect(recovered.intent.status).toBe("succeeded");
    expect(recovered.state).toEqual(source.state);
    const [p] =
      await reader`select flags,modseq from mailbox_messages where mailbox_id=${source.mailbox}`;
    expect(p.flags).toEqual(["\\Seen", "custom"]);
    expect(p.modseq).toBe("3");
  });
  it("lost COMMIT acknowledgment is recovered under conflicting locks", async () => {
    const relay = await receivingResponseRelay(url, (bytes) => {
      if (bytes.includes(Buffer.from("commit\0"))) relay.control.drop = true;
    });
    const lossy = new ReceivingExecutor(relay.url, 1);
    try {
      await expect(
        new ReceivingPublication(lossy).claim(
          owner,
          source,
          "content",
          message,
          { deadline: performance.now() + 700 },
        ),
      ).rejects.toThrow();
      const recovered = await publication.recover(
        owner,
        source,
        "content",
        message,
        budget(),
      );
      expect(recovered.intent.status).toBe("fetching");
      expect(recovered.state.revision).toBe(2n);
      source = { ...source, state: recovered.state };
      await expect(
        publication.claim(owner, source, "content", message, budget()),
      ).rejects.toThrow();
    } finally {
      await lossy.stop();
      await relay.close();
    }
  });
  it("BLOCKER: R03 cannot durably claim before wire execution through its owned context", async () => {
    const expected = JSON.stringify(source.state, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    const attempt = randomUUID();
    let entered = false;
    await runReceivingOperation(
      {
        kind: "store",
        requestId: randomUUID(),
        pendingId: command,
        identity: {
          account,
          mailbox: source.mailbox,
          configurationVersion: 1n,
        },
        deadline: performance.now() + 5000,
      },
      {
        owner,
        executor,
        assertCurrent: () => {},
        validate: async () => {
          await executor.transaction(async (db) => {
            const [r] = await db.execute(
              sql`select maildock_receiving_validate(${owner.actor}::uuid,${owner.generation}::bigint) as valid`,
            );
            expect(r.valid).toBe(true);
          }, budget());
          return {
            host: "invalid.test",
            port: 993,
            security: "tls",
            username: "fixture",
            credential: { kind: "password", password: "fixture-only" },
          };
        },
      },
      async (_operation, context) => {
        entered = true;
        // Use the real installed client and real owned SQL executor. No network
        // connection or remote mutation is needed to expose the phase conflict.
        expect(() =>
          context.transaction(async (db) => {
            await db.execute(
              sql`select maildock_receiving_attempt_claim(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${expected}::jsonb,1::bigint,'command',${command}::uuid,${attempt}::uuid)`,
            );
          }),
        ).toThrow("Receiving SQL requires retired socket and serial scope");
        const [pending] =
          await reader`select status from message_commands where id=${command}`;
        expect(pending.status).toBe("pending");
        await context.retireSocket();
        await context.transaction(async (db) => {
          await db.execute(
            sql`select maildock_receiving_attempt_claim(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${expected}::jsonb,1::bigint,'command',${command}::uuid,${attempt}::uuid)`,
          );
        });
        const [claimed] =
          await reader`select status,receiving_attempt from message_commands where id=${command}`;
        expect(claimed.status).toBe("executing");
        expect(claimed.receiving_attempt.id).toBe(attempt);
        expect(() =>
          context.client.messageFlagsAdd("1", ["\\Seen"], { uid: true }),
        ).toThrow("Owned socket is retired");
        expect(() => context.client.connect()).toThrow(
          "Owned socket is retired",
        );
      },
      new AbortController().signal,
    );
    expect(entered).toBe(true);
  });
});
