import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { GenericContainer, Wait } from "testcontainers";
import { expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  outgoingMessages,
} from "@/shared/infrastructure/database/schema";

it("forward migration preserves old accounts and outgoing mail as server / not_required", async () => {
  const container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "migration_test",
      POSTGRES_USER: "maildock",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  const db = createDatabase({
    databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/migration_test`,
    databasePoolSize: 2,
  });
  try {
    const migrations = readMigrationFiles({
      migrationsFolder: "db/migrations",
    });
    const apply = async (statements: string[]) => {
      await db.client.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
      });
    };
    for (const migration of migrations.slice(0, 13)) await apply(migration.sql);
    const id = randomUUID();
    await db.client`INSERT INTO mail_accounts (id,display_name,email,imap_host,imap_port,imap_security,imap_username,imap_password,smtp_host,smtp_port,smtp_security) VALUES (${id},'Legacy','owner@example.com','imap.example.com',993,'tls','owner','{}','smtp.example.com',465,'tls')`;
    await db.client`INSERT INTO outgoing_messages (id,account_id,"from","to",cc,bcc,subject,plain_text,message_id,mime_base64,status,smtp_accepted_at) VALUES (${randomUUID()},${id},'{"address":"owner@example.com"}','[{"address":"to@example.com"}]','[]','[]','Old','Body','<old@maildock.invalid>','b2xk','sent',now())`;
    await apply(migrations[13].sql);
    expect(
      (
        await db.db
          .select({ sentCopyPolicy: mailAccounts.sentCopyPolicy })
          .from(mailAccounts)
      )[0].sentCopyPolicy,
    ).toBe("server");
    expect(
      (
        await db.db
          .select({
            status: outgoingMessages.status,
            sentCopyPolicy: outgoingMessages.sentCopyPolicy,
            sentCopyStatus: outgoingMessages.sentCopyStatus,
            sentCopySyncPending: outgoingMessages.sentCopySyncPending,
          })
          .from(outgoingMessages)
      )[0],
    ).toMatchObject({
      status: "sent",
      sentCopyPolicy: "server",
      sentCopyStatus: "not_required",
      sentCopySyncPending: false,
    });
    await apply(migrations[14].sql);
    for (const migration of migrations.slice(15, -1))
      await apply(migration.sql);
    const [upgraded] = await db.db
      .select({
        inReplyTo: outgoingMessages.inReplyTo,
        references: outgoingMessages.references,
        status: outgoingMessages.status,
        mimeBase64: outgoingMessages.mimeBase64,
        messageId: outgoingMessages.messageId,
      })
      .from(outgoingMessages);
    expect(upgraded).toMatchObject({
      inReplyTo: null,
      references: [],
      status: "sent",
      mimeBase64: "b2xk",
      messageId: "<old@maildock.invalid>",
    });
    await expect(
      db.db
        .update(outgoingMessages)
        .set({ inReplyTo: "<changed@example.com>" }),
    ).rejects.toThrow();
  } finally {
    await db.client.end();
    await container.stop();
  }
});
