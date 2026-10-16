import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { GenericContainer, Wait } from "testcontainers";
import { expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import {
  initializeOwnerFixture,
  setReadyFixture,
} from "./security/mfa-fixture";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";

async function until(
  check: () => Promise<boolean> | boolean,
  timeout = 30_000,
) {
  const end = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= end)
      throw new Error("Production worker barrier timed out");
    await delay(20);
  }
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

it("normal worker processes gate MFA, elect once, receive, reconcile, convert old jobs, and retire before takeover", async () => {
  const container = await new GenericContainer("postgres:17.6-alpine")
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
  await root`create database production_fixture owner lane`;
  await root.end();
  const url = `postgresql://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/production_fixture`;
  const directory = await mkdtemp(path.join(tmpdir(), "maildock-r16-process-"));
  const env = {
    ...process.env,
    MAILDOCK_ENV: "test",
    APP_ORIGIN: "http://localhost:3000",
    DATABASE_URL: url,
    AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    ATTACHMENTS_PATH: directory,
    NODE_EXTRA_CA_CERTS: path.resolve(
      "experiments/imap-transport/localhost-cert.pem",
    ),
    LOG_LEVEL: "info",
  };
  const config = parseConfig(env);
  const database = createDatabase(config);
  const reader = postgres(url);
  const children: { child: ChildProcess; output: string }[] = [];
  const resources: unknown[] = [];
  let stage = "startup";
  const sampler = setInterval(() => {
    for (const record of children)
      if (record.child.connected) record.child.send("resources");
  }, 500);
  const options: WindowPeerOptions = {
    boundedMailbox: true,
    uids: Array.from({ length: 130 }, (_, i) => i + 1),
    uidNext: 131,
    flags: ["\\Seen"],
    onCommand: (p, c) => {
      if (c.command.startsWith('LIST "" "*"')) {
        p.send(
          '* LIST () "/" "INBOX"\r\n* LIST (\\Archive) "/" "Archive"\r\n',
          c,
        );
        p.ok(c);
        return true;
      }
      if (c.command.startsWith("SELECT ")) {
        p.send(
          `* ${options.uids!.length} EXISTS\r\n* FLAGS (\\Seen \\Flagged)\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT 131] Next\r\n`,
          c,
        );
        p.ok(c, "OK [READ-WRITE] Selected");
        return true;
      }
      if (c.command.startsWith("UID STORE")) {
        options.flags = ["\\Seen"];
        p.ok(c);
        return true;
      }
      if (
        c.command.startsWith("UID FETCH") &&
        c.command.includes("FLAGS") &&
        !c.command.includes("ENVELOPE")
      ) {
        const uid = c.command.split(" ")[2];
        p.send(
          `* 1 FETCH (UID ${uid} FLAGS (${options.flags!.join(" ")}))\r\n`,
          c,
        );
        p.ok(c);
        return true;
      }
    },
  };
  const peer = await metadataPeer(options);
  const spawn = async () => {
    const endpoint = `http://127.0.0.1:${await port()}`;
    const record = {
      endpoint,
      child: fork(
        path.resolve("tests/fixtures/receiving-production-process.ts"),
        [],
        {
          execArgv: ["--import", "tsx"],
          env: {
            ...env,
            MAILDOCK_DIAGNOSTIC_ENDPOINT: endpoint,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      ),
      output: "",
    };
    record.child.stdout!.on("data", (data) => {
      record.output += String(data);
    });
    record.child.stderr!.on("data", (data) => {
      record.output += String(data);
    });
    record.child.on("message", (sample) =>
      resources.push({
        stage,
        at: performance.now(),
        pid: record.child.pid,
        sample,
      }),
    );
    children.push(record);
    return record;
  };
  const stop = async (record: (typeof children)[number]) => {
    if (record.child.exitCode !== null || record.child.signalCode !== null)
      return;
    record.child.send("stop");
    await until(
      () => record.child.exitCode !== null || record.child.signalCode !== null,
    );
    expect(record.child.exitCode).toBe(0);
  };
  try {
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await initializeOwnerFixture(database.db, {
      username: "r16-owner",
      password: "r16 fixture owner password",
      bootstrapSecret: Buffer.alloc(32, 7).toString("base64"),
    });
    const first = await spawn();
    // The process's listener is ready while MFA still refuses all IMAP admission.
    await until(async () => {
      try {
        return (await fetch(first.endpoint)).status === 404;
      } catch {
        return false;
      }
    });
    expect(
      (
        await reader`select expires_at<=clock_timestamp() as retired from receiving_coordinator`
      )[0].retired,
    ).toBe(true);
    expect(peer.peers).toHaveLength(0);
    await setReadyFixture(database.db);
    await until(() => first.output.includes('"event":"receiving.owner"'));
    const second = await spawn();
    await until(() => second.output.includes('"event":"jobs.started"'));
    const generation = String(
      (await reader`select generation from receiving_coordinator`)[0]
        .generation,
    );
    const accounts = new AccountsService(
      database.db,
      new AesGcmSecretEncryption("v1", { v1: env.CREDENTIALS_ENCRYPTION_KEY }),
      {} as MailProvider,
    );
    const id = randomUUID();
    await accounts.create({
      id,
      displayName: "R16 fixture",
      email: "fixture@example.test",
      providerType: "imap_smtp",
      enabled: true,
      imap: {
        host: "127.0.0.1",
        port: peer.endpoint.port,
        security: "tls",
        username: "fixture",
        password: "fixture-only",
      },
      smtp: {
        host: "127.0.0.1",
        port: 465,
        security: "tls",
        useImapCredentials: true,
      },
    });
    stage = "history";
    await until(
      async () =>
        Number(
          (
            await reader`select count(*) from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${id} and b.remote_path='INBOX'`
          )[0].count,
        ) === 130,
    );
    await until(
      async () =>
        (
          await reader`select mailbox_discovery_status from mail_accounts where id=${id}`
        )[0].mailbox_discovery_status === "success",
    );
    const [state] =
      await reader`select s.*,b.id from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.account_id=${id} and b.remote_path='INBOX'`;
    expect(
      (
        await reader`select imap_capabilities from mail_accounts where id=${id}`
      )[0].imap_capabilities,
    ).toContain("IMAP4rev1");
    expect(String(state.history_before)).toBe("1");
    expect(String(state.fresh_through)).toBe("130");
    options.flags = [];
    stage = "quiet-reconciliation";
    options.uids!.splice(options.uids!.indexOf(1), 1);
    await until(
      async () =>
        Number(
          (
            await reader`select count(*) from mailbox_messages where mailbox_id=${state.id} and uid=1`
          )[0].count,
        ) === 0,
      45_000,
    );
    await until(
      async () =>
        (
          await reader`select flags from mailbox_messages where mailbox_id=${state.id} and uid=2`
        )[0].flags.length === 0,
      45_000,
    );
    const [source] =
      await reader`select message_id from mailbox_messages where mailbox_id=${state.id} and uid=2`;
    const command = await new MessageCommandService(
      database.db,
      async () => {
        throw new Error("Legacy execution is forbidden");
      },
      async () => {},
    ).create(id, state.id, source.message_id, "mark_read");
    await until(
      async () =>
        (
          await reader`select status from message_commands where id=${command.id}`
        )[0].status === "succeeded",
    );
    expect(
      (
        await reader`select flags from mailbox_messages where mailbox_id=${state.id} and uid=2`
      )[0].flags,
    ).toContain("\\Seen");
    // A pre-cutover job retains demand; only the elected worker synchronizes it.
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss(url);
    await boss.start();
    try {
      const [secondary] =
        await reader`select id,receiving_request_generation from mailboxes where account_id=${id} and remote_path='Archive'`;
      const secondaryWake = await boss.send("mailbox-recent-sync-v1", {
        version: 1,
        accountId: id,
        mailboxId: secondary.id,
      });
      await until(
        async () =>
          (
            await reader`select state from pgboss.job where id=${secondaryWake}`
          )[0]?.state === "completed",
      );
      const [retained] =
        await reader`select receiving_request_generation,recent_sync_status from mailboxes where id=${secondary.id}`;
      expect(BigInt(retained.receiving_request_generation)).toBeGreaterThan(
        BigInt(secondary.receiving_request_generation),
      );
      expect(retained.recent_sync_status).toBe("not_started");
      await until(async () => {
        const [row] =
          await reader`select s.history_before,(select count(*) from receiving_current_placements p where p.mailbox_id=${secondary.id})::integer as count
          from receiving_mailboxes s where s.mailbox_id=${secondary.id}`;
        return (
          row?.history_before === "1" && row.count === options.uids!.length
        );
      });
      const [secondaryPlacement] =
        await reader`select message_id from receiving_current_placements where mailbox_id=${secondary.id} and uid=2`;
      expect(secondaryPlacement.message_id).not.toBe(source.message_id);
      const foreignAccount = randomUUID(),
        foreignMailbox = randomUUID();
      await accounts.create({
        id: foreignAccount,
        displayName: "Disabled fixture",
        email: "disabled@example.test",
        providerType: "imap_smtp",
        enabled: false,
        imap: {
          host: "127.0.0.1",
          port: peer.endpoint.port,
          security: "tls",
          username: "fixture",
          password: "fixture-only",
        },
        smtp: {
          host: "127.0.0.1",
          port: 465,
          security: "tls",
          useImapCredentials: true,
        },
      });
      await reader`insert into mailboxes(id,account_id,remote_path,name,selectable,first_discovered_at,last_discovered_at) values(${foreignMailbox},${foreignAccount},'INBOX','INBOX',true,now(),now())`;
      const invalid = await boss.send("mailbox-recent-sync-v1", {
        version: 1,
        accountId: id,
        mailboxId: foreignMailbox,
      });
      await until(async () =>
        ["retry", "failed"].includes(
          (await reader`select state from pgboss.job where id=${invalid}`)[0]
            ?.state,
        ),
      );
      const job = await boss.send("mailbox-recent-sync-v1", {
        version: 1,
        accountId: id,
        mailboxId: state.id,
      });
      await until(
        async () =>
          (await reader`select state from pgboss.job where id=${job}`)[0]
            ?.state === "completed",
      );
    } finally {
      await boss.stop();
    }
    expect(
      String(
        (await reader`select generation from receiving_coordinator`)[0]
          .generation,
      ),
    ).toBe(generation);
    await stop(first);
    stage = "takeover";
    await until(() => second.output.includes('"event":"receiving.owner"'));
    expect(
      BigInt(
        (await reader`select generation from receiving_coordinator`)[0]
          .generation,
      ),
    ).toBeGreaterThan(BigInt(generation));
    await stop(second);
    await until(() => peer.peers.every((p) => p.socket.destroyed));
    expect(
      (
        await reader`select expires_at<=clock_timestamp() as retired from receiving_coordinator`
      )[0].retired,
    ).toBe(true);
    let active = 0,
      maximum = 0;
    for (const event of peer.events) {
      if (event.event === "server-open") maximum = Math.max(maximum, ++active);
      if (event.event === "server-close") active--;
    }
    expect(maximum).toBe(1);
    expect(
      peer.commands.filter((c) => /^(IDLE|UID MOVE|APPEND)/.test(c.command)),
    ).toHaveLength(0);
    expect(
      peer.commands.filter((c) => c.command.startsWith("UID STORE")),
    ).toHaveLength(1);
  } finally {
    clearInterval(sampler);
    for (const record of children) {
      if (record.child.exitCode === null && record.child.signalCode === null) {
        record.child.kill();
        await new Promise<void>((resolve) =>
          record.child.once("exit", () => resolve()),
        );
      }
    }
    await writeFile(
      path.join(directory, "worker-output.log"),
      children.map((r) => r.output).join("\n"),
    );
    await writeFile(
      path.join(directory, "resources.json"),
      JSON.stringify(resources, null, 2),
    );
    console.log("R16 process evidence", directory);
    await peer.cleanup();
    await reader.end({ timeout: 0 });
    await database.client.end({ timeout: 0 });
    await container.stop();
  }
});
