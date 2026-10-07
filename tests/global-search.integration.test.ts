import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailboxes,
  messages,
  mailboxMessages,
  messageContents,
} from "@/shared/infrastructure/database/schema";
import { SearchService } from "@/modules/mail/application/search-service";
import { initializeLocalSearchBodies } from "@/modules/mail/infrastructure/search-local-backfill";
import { searchBodyText } from "@/modules/mail/infrastructure/search-body-text";

describe("Phase 2I PostgreSQL global search", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let service: SearchService;
  const accounts = [randomUUID(), randomUUID()];
  const boxes = [randomUUID(), randomUUID(), randomUUID()];
  let uid = 0;
  let historical: string;
  let historicalPlain: string;
  async function add(
    subject: string,
    account = 0,
    body?: string,
    html?: string,
  ) {
    const id = randomUUID();
    await database.db.insert(messages).values({
      id,
      accountId: accounts[account],
      subject,
      internalDate: new Date("2026-05-01T12:00:00Z"),
      size: 100n,
      from: [{ name: "Mateusz Sender", address: "mateusz@example.com" }],
      to: [{ name: "Recipient Alice", address: "alice@contoso.test" }],
      cc: [{ name: "Copy Bob", address: "bob@ccdomain.test" }],
    });
    await placement(id, boxes[account]);
    if (body !== undefined || html !== undefined)
      await database.db.insert(messageContents).values({
        messageId: id,
        status: "ready",
        plainText: body ?? null,
        sanitizedHtml: html ?? null,
        searchText: searchBodyText(body ?? null, html ?? null),
      });
    return id;
  }
  async function placement(id: string, box: string) {
    await database.db.insert(mailboxMessages).values({
      id: randomUUID(),
      messageId: id,
      mailboxId: box,
      uid: BigInt(++uid),
      uidValidity: 1n,
      firstSynchronizedAt: new Date(),
      lastSynchronizedAt: new Date(),
      flags: ["\\Seen"],
    });
  }
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "search",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/search`,
      databasePoolSize: 5,
    });
    // Genuine pre-2I data, then forward-only SQL and local HTML initialization.
    const migrations = readMigrationFiles({
      migrationsFolder: "db/migrations",
    });
    for (const migration of migrations.slice(0, -1))
      await database.db.transaction(async (tx) => {
        for (const statement of migration.sql)
          await tx.execute(sql.raw(statement));
      });
    for (let i = 0; i < 2; i++) {
      // Use legacy columns while the final forward migration is pending.
      await database.client`INSERT INTO mail_accounts (id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) VALUES (${accounts[i]},${i ? "DPoczta" : "Hotmail"},${`owner${i}@example.com`},'imap.test',993,'tls','owner','{}','smtp.test',465,'tls')`;
      await database.db.insert(mailboxes).values({
        id: boxes[i],
        accountId: accounts[i],
        remotePath: i ? "Sent" : "INBOX",
        name: i ? "Sent" : "Inbox",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
    }
    await database.db.insert(mailboxes).values({
      id: boxes[2],
      accountId: accounts[0],
      remotePath: "Other",
      name: "Other",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    historical = randomUUID();
    await database.db.execute(
      sql`INSERT INTO messages(id, account_id, subject, internal_date, size) VALUES(${historical}, ${accounts[0]}, 'Historical metadata', now(), 1)`,
    );
    await database.db.execute(
      sql`INSERT INTO message_contents(message_id, status, sanitized_html) VALUES(${historical}, 'ready', '<p>historicalhtml &amp; faktura</p>')`,
    );
    await placement(historical, boxes[0]);
    historicalPlain = randomUUID();
    await database.db.execute(
      sql`INSERT INTO messages(id, account_id, subject, internal_date, size) VALUES(${historicalPlain}, ${accounts[1]}, 'Existing plain', now(), 1)`,
    );
    await database.db.execute(
      sql`INSERT INTO message_contents(message_id, status, plain_text) VALUES(${historicalPlain}, 'ready', 'historicalplainneedle')`,
    );
    await placement(historicalPlain, boxes[1]);
    await database.db.transaction(async (tx) => {
      for (const statement of migrations.at(-1)!.sql)
        await tx.execute(sql.raw(statement));
    });
    await initializeLocalSearchBodies(database.db);
    service = new SearchService(database.db);
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });

  it("initializes historical local HTML and metadata without account resync", async () => {
    expect(
      (await service.search("historicalhtml")).items.map((r) => r.id),
    ).toContain(historical);
    expect(
      (await service.search("historicalplainneedle")).items.map((r) => r.id),
    ).toContain(historicalPlain);
    expect(
      (await service.search("Historical metadata")).items.map((r) => r.id),
    ).toContain(historical);
    await initializeLocalSearchBodies(database.db);
  });
  it("is global, de-duplicates placements, prefers active selectable and returns reader context", async () => {
    const first = await add("globalscope windows insider", 0);
    const second = await add("globalscope windows insider", 1);
    await placement(first, boxes[2]);
    await database.db
      .update(mailboxes)
      .set({ lifecycleStatus: "missing" })
      .where(eq(mailboxes.id, boxes[0]));
    const page = await service.search("globalscope windows insider");
    expect(page.items.map((r) => r.id).sort()).toEqual([first, second].sort());
    expect(page.items.find((r) => r.id === first)?.mailboxId).toBe(boxes[2]);
    expect(page.items.find((r) => r.id === second)).toMatchObject({
      accountId: accounts[1],
      accountName: "DPoczta",
      mailboxName: "Sent",
      seen: true,
    });
    await database.db
      .update(mailboxes)
      .set({ lifecycleStatus: "active" })
      .where(eq(mailboxes.id, boxes[0]));
  });
  it("indexes identities, recipients, reference numbers, multilingual subject and email components", async () => {
    const id = await add("Faktura invoice 12345 sea of thieves");
    for (const query of [
      "Faktura",
      "invoice 12345",
      "sea of thieves",
      "Mateusz Sender",
      "mateusz@example.com",
      "example.com",
      "example",
      "mateusz",
      "Recipient Alice",
      "alice@contoso.test",
      "contoso.test",
      "contoso",
      "Copy Bob",
      "bob@ccdomain.test",
    ]) {
      expect(
        (await service.search(query)).items.map((r) => r.id),
        query,
      ).toContain(id);
    }
    const tokens = await database.db.execute(
      sql`SELECT to_tsvector('simple', 'mateusz@example.com')::text AS original, to_tsvector('simple', maildock_search_addresses('[{"address":"mateusz@example.com"}]'))::text AS expanded`,
    );
    expect(tokens[0].expanded).toContain("'mateusz'");
    expect(tokens[0].expanded).toContain("'example.com'");
  });
  it("searches only local bodies and naturally updates on later storage, refresh and deletion", async () => {
    const id = await add("metadataonly needlemetadata");
    expect(
      (await service.search("needlemetadata")).items.map((r) => r.id),
    ).toContain(id);
    expect((await service.search("uniquelocalbody")).items).toHaveLength(0);
    const before = await database.db.select().from(messageContents);
    await service.search("unfetchedremote");
    expect(await database.db.select().from(messageContents)).toEqual(before);
    await database.db.insert(messageContents).values({
      messageId: id,
      status: "ready",
      plainText: "uniquelocalbody",
      searchText: "uniquelocalbody",
    });
    expect(
      (await service.search("uniquelocalbody")).items.map((r) => r.id),
    ).toEqual([id]);
    await database.db
      .update(messageContents)
      .set({ plainText: "refreshedbody", searchText: "refreshedbody" })
      .where(eq(messageContents.messageId, id));
    expect((await service.search("uniquelocalbody")).items).toHaveLength(0);
    expect(
      (await service.search("refreshedbody")).items.map((r) => r.id),
    ).toEqual([id]);
    await database.db
      .delete(messageContents)
      .where(eq(messageContents.messageId, id));
    expect((await service.search("refreshedbody")).items).toHaveLength(0);
    await database.db
      .update(messages)
      .set({ subject: "changedmetadata" })
      .where(eq(messages.id, id));
    expect((await service.search("needlemetadata")).items).toHaveLength(0);
  });
  it("indexes HTML text without tags, CSS, hidden elements or resource/link attributes", async () => {
    const id = await add(
      "HTML only",
      1,
      undefined,
      `<style>.hide{display:none} p{color:red}</style><p>localhtmlneedle &amp; Łódź</p><div class="hide">hiddenneedle</div><script>activeneedle</script><img src="https://trackingneedle.test/pixel"><a href="https://linkneedle.test/">Visible</a><div style="display:none">inlineneedle</div>`,
    );
    expect((await service.search("localhtmlneedle")).items[0].id).toBe(id);
    expect((await service.search("Łódź")).items[0].snippet).toContain("&");
    for (const q of [
      "hiddenneedle",
      "activeneedle",
      "trackingneedle.test",
      "linkneedle.test",
      "inlineneedle",
    ])
      expect((await service.search(q)).items).toHaveLength(0);
  });
  it("weights subject above body, orders ties deterministically, and bounds hostile input", async () => {
    const subject = await add("rankingneedle");
    const body = await add("Unrelated", 1, "rankingneedle");
    expect(
      (await service.search("rankingneedle")).items.map((r) => r.id),
    ).toEqual([subject, body]);
    const ties = [await add("tiesneedle"), await add("tiesneedle")];
    expect((await service.search("tiesneedle")).items.map((r) => r.id)).toEqual(
      ties.sort().reverse(),
    );
    await database.db
      .update(messages)
      .set({ internalDate: new Date("2026-09-01T00:00:00Z") })
      .where(eq(messages.id, ties[1]));
    expect((await service.search("tiesneedle")).items[0].id).toBe(ties[1]);
    expect(await service.search("tiesneedle")).toEqual(
      await service.search("tiesneedle"),
    );
    for (const q of [
      "!!!",
      '"unfinished',
      "O'Reilly",
      "a & b | ! c :*",
      "'; DROP TABLE messages;--",
      "<script>alert(1)</script>",
    ])
      await expect(service.search(q)).resolves.toBeDefined();
    await expect(service.search("x".repeat(257))).rejects.toThrow(
      "Invalid search query",
    );
    await expect(service.search("mail\0text")).rejects.toThrow(
      "Invalid search query",
    );
    expect(await service.search("   ")).toEqual({ items: [], hasMore: false });
  });
  it("uses GIN on a 30,000 message dataset and keeps results bounded", async () => {
    // Isolate FTS seed cost from conversation graph construction in this disposable fixture.
    await database.db.execute(
      sql`ALTER TABLE messages DISABLE TRIGGER messages_conversation`,
    );
    try {
      await database.db
        .execute(sql`INSERT INTO messages(id, account_id, subject, internal_date, size)
      SELECT gen_random_uuid(), ${accounts[0]}::uuid, 'synthetic common ' || n || CASE WHEN n % 1000 = 0 THEN ' selectiveplanneedle' ELSE '' END, now(), 1 FROM generate_series(1,30000) n`);
    } finally {
      await database.db.execute(
        sql`ALTER TABLE messages ENABLE TRIGGER messages_conversation`,
      );
    }
    await database.db
      .execute(sql`INSERT INTO mailbox_messages(id, mailbox_id, message_id, uid_validity, uid, first_synchronized_at, last_synchronized_at)
      SELECT gen_random_uuid(), ${boxes[0]}::uuid, id, 2, row_number() OVER (), now(), now() FROM messages WHERE subject LIKE 'synthetic common %'`);
    await database.db.execute(sql`VACUUM ANALYZE messages`);
    await database.db.execute(sql`ANALYZE mailbox_messages`);
    const plan = await database.db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM messages WHERE search_vector @@ plainto_tsquery('simple', 'selectiveplanneedle')`,
    );
    expect(JSON.stringify(plan)).toContain("messages_search_gin_idx");
    const start = performance.now();
    const execute = vi.spyOn(database.db, "execute");
    expect((await service.search("selectiveplanneedle")).items).toHaveLength(
      30,
    );
    const actualQuery = execute.mock.calls[0][0];
    execute.mockRestore();
    const fullPlan = await database.db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${actualQuery}`,
    );
    expect(JSON.stringify(fullPlan)).toContain("messages_search_gin_idx");
    const rareMs = performance.now() - start;
    const commonStart = performance.now();
    const page = await service.search("synthetic common");
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    const commonMs = performance.now() - commonStart;
    const representativePlans: Record<string, unknown> = {};
    for (const query of [
      "mateusz@example.com",
      "localhtmlneedle",
      "synthetic common",
    ]) {
      const spy = vi.spyOn(database.db, "execute");
      await service.search(query);
      const statement = spy.mock.calls[0][0];
      spy.mockRestore();
      representativePlans[query] = await database.db.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
      );
    }
    await mkdir(".search-results", { recursive: true });
    await writeFile(
      ".search-results/performance.json",
      JSON.stringify(
        {
          syntheticMessages: 30000,
          ftsPlan: plan,
          endpointPlan: fullPlan,
          representativePlans,
          rareQueryAndExplainMs: rareMs,
          commonQueryMs: commonMs,
        },
        null,
        2,
      ),
    );
  });
  it("fresh disposable databases run the complete migration chain", async () => {
    await database.client`CREATE DATABASE search_fresh`;
    const fresh = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/search_fresh`,
      databasePoolSize: 1,
    });
    try {
      await migrate(fresh.db, { migrationsFolder: "db/migrations" });
      await initializeLocalSearchBodies(fresh.db);
    } finally {
      await fresh.client.end();
    }
  });
});
