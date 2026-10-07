import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { symmetricEncrypt, symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from "testcontainers";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import { validateDatabaseAuthority } from "@/shared/infrastructure/database/database-authority";
import {
  verifyRecoverySchema,
  verifyRecoveryState,
  verifyMaintenance,
  RecoveryError,
} from "@/shared/infrastructure/database/restore-verification";
import {
  restoreSecurityState,
  restoreReviewReason,
} from "@/modules/auth/application/restore-security-state";
import { initializeOwner } from "@/modules/auth/application/instance-auth";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { getValidBusinessSession } from "@/modules/auth/application/session-validation";
import { verifyMfaLogin } from "@/modules/auth/application/mfa-login";
import {
  startAuthenticatorReplacement,
  completeAuthenticatorReplacement,
} from "@/modules/auth/application/mfa-management";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import * as s from "@/shared/infrastructure/database/schema";
import { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";
import { SentCopyService } from "@/modules/mail/application/sent-copy-service";
import { MessageCommandService } from "@/modules/mail/application/message-command-service";

const origin = "http://localhost:3000",
  password = "synthetic recovery owner password";
const bootstrapSecret = Buffer.alloc(32, 7).toString("base64");
const secret = "JBSWY3DPEHPK3PXP";
const oldCodes = ["ABCDE-12345", "FGHIJ-67890"];
const containers: StartedTestContainer[] = [],
  networks: StartedNetwork[] = [];
let db: ReturnType<typeof createDatabase>,
  config: AppConfig,
  root: string,
  owner: string;
let auth: ReturnType<typeof createAuth>;
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
const headers = (value = "") => new Headers({ Origin: origin, cookie: value });
async function login(method: "totp" | "recovery" = "totp", code?: string) {
  const challenge = await auth.api.signInUsername({
    headers: headers(),
    body: { username: "owner-01", password },
    asResponse: true,
  });
  expect(challenge.status).toBe(200);
  return verifyMfaLogin(
    db.db,
    config,
    headers(cookie(challenge)),
    code ?? (await createOTP(secret).totp()),
    method,
  );
}
async function start(hardened = true) {
  const network = await new Network().start();
  networks.push(network);
  const container = await new GenericContainer("postgres:18.6-bookworm")
    .withNetwork(network)
    .withNetworkAliases("postgres")
    .withEnvironment({
      POSTGRES_USER: "maildock",
      POSTGRES_DB: "maildock",
      POSTGRES_PASSWORD: "synthetic",
    })
    .withExposedPorts(5432)
    .withCopyFilesToContainer([
      {
        source: path.resolve("scripts/postgres/99-maildock-authority.sql"),
        target: hardened
          ? "/docker-entrypoint-initdb.d/99-maildock-authority.sql"
          : "/unused-authority.sql",
      },
      {
        source: path.resolve(
          "scripts/postgres/maildock-restore-compatibility.sh",
        ),
        target: "/helper.sh",
      },
    ])
    .withCopyDirectoriesToContainer([
      {
        source: path.resolve("scripts/postgres/recovery"),
        target: "/usr/local/share/maildock-recovery",
      },
    ])
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  containers.push(container);
  const config = parseConfig({
    MAILDOCK_ENV: "test",
    APP_ORIGIN: origin,
    DATABASE_URL: `postgresql://maildock:synthetic@${container.getHost()}:${container.getMappedPort(5432)}/maildock`,
    AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    MAILDOCK_BOOTSTRAP_SECRET: bootstrapSecret,
    ATTACHMENTS_PATH: root,
    LOG_LEVEL: "fatal",
  });
  return { container, config, database: createDatabase(config) };
}
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "maildock-recovery-tests-"));
  const fixture = await start();
  db = fixture.database;
  config = fixture.config;
  await migrate(db.db, { migrationsFolder: "db/migrations" });
  await validateDatabaseAuthority(db.client);
});
beforeEach(async () => {
  await db.client`truncate public.recovery_maintenance, public.instance_state, public."user", public.mail_accounts, public.blobs, public.verification, public.auth_admission, public.login_throttle, public.rate_limit, public.oauth_authorization_states cascade`;
  await db.db.insert(s.instanceState).values({ id: 1 });
  await initializeOwner(
    db.db,
    { bootstrapSecret, username: "owner-01", password },
    config,
  );
  owner = (await db.db.select().from(s.user))[0].id;
  await db.db.insert(s.twoFactor).values({
    id: randomUUID(),
    userId: owner,
    secret: await symmetricEncrypt({ key: config.authSecret, data: secret }),
    backupCodes: await symmetricEncrypt({
      key: config.authSecret,
      data: JSON.stringify(oldCodes),
    }),
    verified: true,
    failedVerificationCount: 2,
  });
  await db.db
    .update(s.user)
    .set({ twoFactorEnabled: true })
    .where(eq(s.user.id, owner));
  auth = createAuth(config, db.db);
});
afterAll(async () => {
  await db?.client.end();
  for (const container of containers.reverse()) await container.stop();
  for (const network of networks.reverse()) await network.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("F12-05 offline recovery", () => {
  it("refuses unsafe bootstrap authority without provisioning a privileged helper", async () => {
    const unsafe = await start(false);
    try {
      await expect(
        validateDatabaseAuthority(unsafe.database.client),
      ).rejects.toMatchObject({ category: "database_authority" });
      const result = await unsafe.container.exec([
        "sh",
        "/helper.sh",
        "--check-fresh-destination",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("recovery_archive_refused");
      const roles =
        await db.client`select rolname from pg_roles where rolname like 'maildock%' order by rolname`;
      expect(roles.map((r) => r.rolname)).toEqual([
        "maildock",
        "maildock_bootstrap",
      ]);
    } finally {
      await unsafe.database.client.end();
    }
  });

  it("fails closed for unknown legacy TOC, function bodies/signatures, migration and PostgreSQL version", async () => {
    const source = await start(),
      destination = await start();
    const baseline = path.join(root, "negative-baseline");
    await cp("db/migrations", baseline, { recursive: true });
    const journal = JSON.parse(
      await readFile(path.join(baseline, "meta/_journal.json"), "utf8"),
    );
    journal.entries.pop();
    await writeFile(
      path.join(baseline, "meta/_journal.json"),
      JSON.stringify(journal),
    );
    const dump = async () => {
      expect(
        (
          await source.container.exec([
            "sh",
            "-c",
            'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U maildock -d maildock -Fc --no-acl -f /tmp/negative.dump',
          ])
        ).exitCode,
      ).toBe(0);
      await destination.container.copyArchiveToContainer(
        (await source.container.copyArchiveFromContainer(
          "/tmp/negative.dump",
        )) as Readable,
        "/tmp",
      );
    };
    const refuse = async (stage: string) => {
      const result = await destination.container.exec([
        "sh",
        "/helper.sh",
        "--fresh-destination-writers-stopped",
        "/tmp/negative.dump",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`(${stage})`);
      expect(
        await destination.database
          .client`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`,
      ).toEqual([]);
    };
    try {
      await migrate(source.database.db, { migrationsFolder: baseline });
      await source.database
        .client`create table public.unexpected_archive_table(id integer)`;
      await dump();
      await refuse("archive_tables");
      await source.database.client`drop table public.unexpected_archive_table`;
      await source.database
        .client`create function public.maildock_search_addresses(text) returns text language sql immutable as 'select $1'`;
      await dump();
      await refuse("function_signatures");
      await source.database
        .client`drop function public.maildock_search_addresses(text)`;
      await source.database
        .client`create or replace function public.maildock_search_addresses(addresses jsonb) returns text language sql immutable parallel safe as 'select ''unexpected-body-canary'''`;
      await dump();
      await refuse("function_definitions");
      const legacyFunctions = await readFile(
        "scripts/postgres/recovery/legacy-functions.sql",
        "utf8",
      );
      await source.database.client.unsafe(
        legacyFunctions.replaceAll(
          "CREATE FUNCTION",
          "CREATE OR REPLACE FUNCTION",
        ),
      );
      const originalHistory = await source.database.client<
        { id: number; hash: string; created_at: string }[]
      >`select id, hash, created_at from drizzle.__drizzle_migrations order by created_at`;
      const deployed = (
        await readFile(
          "scripts/postgres/recovery/legacy-migrations.txt",
          "utf8",
        )
      )
        .trimEnd()
        .split("\n");
      // A mixture of individually known hashes is not a reviewed release.
      const changed = originalHistory.findIndex(
        (row, i) => row.hash !== deployed[i].split("\t")[0],
      );
      expect(changed).toBeGreaterThanOrEqual(0);
      await source.database
        .client`update drizzle.__drizzle_migrations set hash=${deployed[changed].split("\t")[0]} where id=${originalHistory[changed].id}`;
      await dump();
      await refuse("archive_migrations");
      await source.database
        .client`update drizzle.__drizzle_migrations set hash=${originalHistory[changed].hash} where id=${originalHistory[changed].id}`;
      await source.database
        .client`update drizzle.__drizzle_migrations set created_at=created_at+1 where id=1`;
      await dump();
      await refuse("archive_migrations");
      await source.database
        .client`update drizzle.__drizzle_migrations set created_at=${originalHistory[0].created_at} where id=1`;
      const last = originalHistory.at(-1)!;
      await source.database
        .client`delete from drizzle.__drizzle_migrations where id=${last.id}`;
      await dump();
      await refuse("archive_migrations");
      await source.database
        .client`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${last.id}, ${last.hash}, ${last.created_at})`;
      await source.database
        .client`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${last.id + 1}, ${last.hash}, ${Number(last.created_at) + 1})`;
      await dump();
      await refuse("archive_migrations");
      await source.database
        .client`delete from drizzle.__drizzle_migrations where id=${last.id + 1}`;
      await source.database
        .client`update drizzle.__drizzle_migrations set hash='unknown-release' where id=1`;
      await dump();
      await refuse("archive_migrations");
      // Same-length header corruption, leaving a valid custom container whose
      // declared source PostgreSQL version is outside the reviewed contract.
      const encoded = await source.container.exec([
        "base64",
        "-w0",
        "/tmp/negative.dump",
      ]);
      const archive = Buffer.from(encoded.output, "base64"),
        position = archive.indexOf(Buffer.from("18.6"));
      expect(position).toBeGreaterThan(0);
      archive.write("19.6", position, "ascii");
      await destination.container.copyContentToContainer([
        { content: archive, target: "/tmp/negative.dump" },
      ]);
      await refuse("archive_version");
    } finally {
      await source.database.client.end();
      await destination.database.client.end();
    }
  });

  it("revokes a real restored session and old codes while preserving password, factor, owner and budgets", async () => {
    const signedIn = await login();
    expect(signedIn.status).toBe(200);
    const restoredHeaders = headers(cookie(signedIn));
    expect(await getValidBusinessSession(auth, restoredHeaders)).not.toBeNull();
    await db.db.update(s.twoFactor).set({
      failedVerificationCount: 3,
      lockedUntil: new Date(Date.now() - 1000),
    });
    await db.db.insert(s.loginThrottle).values({
      key: "restore-throttle",
      failureCount: 2,
      blockedUntil: new Date(Date.now() + 60000),
    });
    await db.db.insert(s.verification).values({
      id: randomUUID(),
      identifier: "restore-challenge",
      value: owner,
      expiresAt: new Date(Date.now() + 60000),
    });
    await db.db.insert(s.authAdmission).values({
      key: "manage:password",
      count: 3,
      expiresAt: new Date(Date.now() + 60000),
    });
    const [before] = await db.db.select().from(s.twoFactor);
    const [credential] = await db.db.select().from(s.account);
    const result = await restoreSecurityState(db.db, config, owner, "maintain");
    expect(result.status).toBe("verified");
    expect(result.recoveryCodes).toHaveLength(10);
    const [preserved] = await db.db.select().from(s.twoFactor);
    expect(preserved.failedVerificationCount).toBe(
      before.failedVerificationCount,
    );
    expect(preserved.lockedUntil).toEqual(before.lockedUntil);
    expect((await db.db.select().from(s.loginThrottle))[0].failureCount).toBe(
      2,
    );
    expect(await getValidBusinessSession(auth, restoredHeaders)).toBeNull();
    expect((await login("recovery", oldCodes[0])).status).not.toBe(200);
    expect((await login("recovery", result.recoveryCodes[0])).status).toBe(200);
    expect((await login()).status).toBe(200);
    const [after] = await db.db.select().from(s.twoFactor);
    expect(after.secret).toBe(before.secret);
    expect(after.verified).toBe(true);
    expect((await db.db.select().from(s.account))[0].password).toBe(
      credential.password,
    );
    expect((await db.db.select().from(s.instanceState))[0].ownerUserId).toBe(
      owner,
    );
    expect(
      (await db.db.select().from(s.authAdmission)).find(
        (r) => r.key === "manage:password",
      )?.count,
    ).toBe(3);
    const again = await restoreSecurityState(db.db, config, owner, "maintain");
    expect(again.recoveryCodes).not.toEqual(result.recoveryCodes);
    await expect(
      verifyMaintenance(db.db, config, owner, result.receiptId),
    ).rejects.toMatchObject({ category: "recovery_incomplete" });
    expect(await verifyMaintenance(db.db, config, owner, again.receiptId)).toBe(
      "verified",
    );
    expect(
      (await db.db.select().from(s.twoFactor))[0].failedVerificationCount,
    ).toBe(after.failedVerificationCount);
  });

  it("retains pending replacement, revokes its token, and requires password AND pending TOTP", async () => {
    const signedIn = await login();
    const replacement = await startAuthenticatorReplacement(
      db.db,
      config,
      headers(cookie(signedIn)),
      {
        password,
        proofType: "totp",
        proofCode: await createOTP(secret).totp(),
      },
    );
    expect(replacement).toBeInstanceOf(Response);
    const replacementHeaders = headers(cookie(replacement as Response));
    // Exercise the installed generator's complete alphabet deterministically.
    await db.db.update(s.twoFactor).set({
      secret: await symmetricEncrypt({
        key: config.authSecret,
        data: "pending_secret-with-dashes_123456",
      }),
    });
    const [pending] = await db.db.select().from(s.twoFactor);
    const pendingSecret = await symmetricDecrypt({
      key: config.authSecret,
      data: pending.secret,
    });
    const [guard] = await db.db.select().from(s.mfaReplacement);
    const result = await restoreSecurityState(db.db, config, owner, "maintain");
    expect(result.status).toBe("pending_mfa");
    expect(result.recoveryCodes).toEqual([]);
    expect(await isInstanceReady(db.db)).toBe(false);
    const [revoked] = await db.db.select().from(s.mfaReplacement);
    expect(revoked.tokenDigest).not.toBe(guard.tokenDigest);
    expect(revoked.factorId).toBe(guard.factorId);
    expect(
      (
        await completeAuthenticatorReplacement(
          db.db,
          config,
          replacementHeaders,
          await createOTP(pendingSecret).totp(),
        )
      ).status,
    ).toBe(403);
    await expect(
      restoreSecurityState(db.db, config, owner, "complete-mfa", { password }),
    ).rejects.toMatchObject({ category: "recovery_proof" });
    await expect(
      restoreSecurityState(db.db, config, owner, "complete-mfa", {
        password: "incorrect",
        code: await createOTP(pendingSecret).totp(),
      }),
    ).rejects.toMatchObject({ category: "recovery_proof" });
    const code = await createOTP(pendingSecret).totp();
    await expect(
      restoreSecurityState(db.db, config, owner, "complete-mfa", {
        password,
        code: code === "000000" ? "000001" : "000000",
      }),
    ).rejects.toMatchObject({ category: "recovery_proof" });
    const resumed = await restoreSecurityState(
      db.db,
      config,
      owner,
      "resume-mfa",
      { password },
    );
    expect(resumed.totpURI).toContain("otpauth://");
    expect(await isInstanceReady(db.db)).toBe(false);
    const completed = await restoreSecurityState(
      db.db,
      config,
      owner,
      "complete-mfa",
      { password, code: await createOTP(pendingSecret).totp() },
    );
    expect(completed.recoveryCodes).toHaveLength(10);
    expect(await isInstanceReady(db.db, owner)).toBe(true);
    expect(await db.db.select().from(s.mfaReplacement)).toEqual([]);
    expect((await db.db.select().from(s.twoFactor))[0].secret).toBe(
      pending.secret,
    );
    expect(await db.db.select().from(s.user)).toHaveLength(1);
    await expect(
      initializeOwner(
        db.db,
        { bootstrapSecret, username: "other-owner", password },
        config,
      ),
    ).rejects.toThrow();
    expect((await login("recovery", completed.recoveryCodes[0])).status).toBe(
      200,
    );
  });

  it("refuses unknown, unfinished provisioning, wrong owner, and mandatory-MFA inconsistency unchanged", async () => {
    const initializedAt = (await db.db.select().from(s.instanceState))[0]
      .initializedAt;
    await db.client`update public.instance_state set initialized_at='infinity'::timestamptz`;
    await expect(
      restoreSecurityState(db.db, config, owner, "maintain"),
    ).rejects.toMatchObject({ category: "recovery_owner" });
    await db.db.update(s.instanceState).set({ initializedAt });
    await expect(
      restoreSecurityState(db.db, config, "another-owner", "maintain"),
    ).rejects.toMatchObject({ category: "recovery_owner" });
    await db.db.update(s.user).set({ twoFactorEnabled: false });
    const factor = JSON.stringify(await db.db.select().from(s.twoFactor));
    await expect(
      restoreSecurityState(db.db, config, owner, "maintain"),
    ).rejects.toMatchObject({ category: "recovery_owner" });
    expect(JSON.stringify(await db.db.select().from(s.twoFactor))).toBe(factor);
    await db.db.update(s.twoFactor).set({ verified: false });
    await expect(
      restoreSecurityState(db.db, config, owner, "maintain"),
    ).rejects.toMatchObject({ category: "recovery_owner" });
    expect(await db.db.select().from(s.recoveryMaintenance)).toEqual([]);
  });

  it("rolls back invalidation/code rotation on transaction failure and reruns safely", async () => {
    const signedIn = await login(),
      sessionHeaders = headers(cookie(signedIn));
    const [before] = await db.db.select().from(s.twoFactor);
    const transaction = db.db.transaction.bind(db.db);
    const injected = vi
      .spyOn(db.db, "transaction")
      .mockImplementationOnce((fn, options) =>
        transaction(async (tx) => {
          await fn(tx);
          throw Error("synthetic commit interruption");
        }, options),
      );
    try {
      await expect(
        restoreSecurityState(db.db, config, owner, "maintain"),
      ).rejects.toThrow("synthetic commit interruption");
    } finally {
      injected.mockRestore();
    }
    expect((await db.db.select().from(s.twoFactor))[0].backupCodes).toBe(
      before.backupCodes,
    );
    expect(await getValidBusinessSession(auth, sessionHeaders)).not.toBeNull();
    expect(await db.db.select().from(s.recoveryMaintenance)).toEqual([]);
    const result = await restoreSecurityState(db.db, config, owner, "maintain");
    expect(
      await verifyMaintenance(db.db, config, owner, result.receiptId),
    ).toBe("verified");
    expect(await getValidBusinessSession(auth, sessionHeaders)).toBeNull();
  });

  it("decrypts required envelopes and rejects missing/corrupt blobs and keys BEFORE mutation", async () => {
    const accountId = randomUUID();
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    await db.db.insert(s.mailAccounts).values({
      id: accountId,
      displayName: "Synthetic",
      email: "owner@example.invalid",
      enabled: false,
      imapHost: "imap.invalid",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      imapPassword: encryption.encrypt(
        "credential-canary",
        `maildock:account-credential:v1:${accountId}:imap`,
      ),
      smtpHost: "smtp.invalid",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    const storage = new LocalBlobStorage(root);
    const bytes = Buffer.from("known attachment bytes");
    const stored = await storage.put(Readable.from([bytes]), 1000);
    const blobId = randomUUID();
    await db.db.insert(s.blobs).values({
      id: blobId,
      storageKey: stored.key,
      size: stored.size,
      sha256: stored.sha256,
    });
    await db.db.insert(s.stagedAttachments).values({
      id: randomUUID(),
      blobId,
      filename: "fixture.txt",
      contentType: "text/plain",
      expiresAt: new Date(Date.now() + 60000),
    });
    expect((await verifyRecoveryState(db.db, config, owner)).status).toBe(
      "verified",
    );
    await expect(
      restoreSecurityState(
        db.db,
        { ...config, authSecret: "wrong-auth-secret-canary-value-32bytes" },
        owner,
        "maintain",
      ),
    ).rejects.toMatchObject({ category: "recovery_keys" });
    await expect(
      restoreSecurityState(
        db.db,
        {
          ...config,
          credentialsEncryption: {
            activeKeyId: "v2",
            keys: { v2: Buffer.alloc(32, 9).toString("base64") },
          },
        },
        owner,
        "maintain",
      ),
    ).rejects.toMatchObject({ category: "recovery_keys" });
    const file = path.join(root, "blobs", stored.key.slice(0, 2), stored.key);
    await writeFile(file, Buffer.alloc(bytes.length, 33));
    await expect(
      restoreSecurityState(db.db, config, owner, "maintain"),
    ).rejects.toMatchObject({ category: "recovery_blobs" });
    await writeFile(file, bytes.subarray(1));
    await expect(
      restoreSecurityState(db.db, config, owner, "maintain"),
    ).rejects.toMatchObject({ category: "recovery_blobs" });
    await rm(file);
    await expect(
      restoreSecurityState(db.db, config, owner, "maintain"),
    ).rejects.toMatchObject({ category: "recovery_blobs" });
    expect(await db.db.select().from(s.recoveryMaintenance)).toEqual([]);
    const message = new RecoveryError("recovery_keys").toString();
    expect(message).not.toContain("canary");
  });

  it("fences all remote states and obsolete worker jobs cannot reach a provider", async () => {
    const accountId = randomUUID(),
      mailboxId = randomUUID(),
      messageId = randomUUID();
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    await db.db.insert(s.mailAccounts).values({
      id: accountId,
      displayName: "Synthetic",
      email: "owner@example.invalid",
      enabled: false,
      imapHost: "imap.invalid",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      imapPassword: encryption.encrypt(
        "synthetic",
        `maildock:account-credential:v1:${accountId}:imap`,
      ),
      smtpHost: "smtp.invalid",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    await db.db.insert(s.mailboxes).values({
      id: mailboxId,
      accountId,
      remotePath: "INBOX",
      name: "INBOX",
      delimiter: "/",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await db.db.insert(s.messages).values({
      id: messageId,
      accountId,
      subject: "Fixture",
      size: 10n,
      internalDate: new Date(),
    });
    const outgoingIds: string[] = [];
    for (const status of ["queued", "sending", "pending", "saving"]) {
      const id = randomUUID();
      outgoingIds.push(id);
      await db.db.insert(s.outgoingMessages).values({
        id,
        accountId,
        from: { name: "", address: "owner@example.invalid" },
        to: [{ name: "", address: "to@example.invalid" }],
        cc: [],
        bcc: [],
        subject: "fixture",
        plainText: "fixture",
        messageId: `${id}@invalid`,
        mimeBase64: "c3ludGhldGlj",
        status: ["pending", "saving"].includes(status) ? "sent" : status,
        sentCopyPolicy: ["pending", "saving"].includes(status)
          ? "maildock"
          : "server",
        sentCopyStatus: ["pending", "saving"].includes(status)
          ? status
          : "not_required",
      });
    }
    const commandIds: string[] = [];
    for (const status of ["pending", "executing"]) {
      const id = randomUUID();
      commandIds.push(id);
      await db.db.insert(s.messageCommands).values({
        id,
        accountId,
        mailboxId,
        messageId,
        status,
        action: "mark_read",
        sourcePath: "INBOX",
        sourceUidValidity: 1n,
        sourceUid: 1n,
      });
    }
    const result = await restoreSecurityState(db.db, config, owner, "maintain");
    expect(
      await verifyMaintenance(db.db, config, owner, result.receiptId),
    ).toBe("verified");
    const rows = await db.db.select().from(s.outgoingMessages);
    expect(rows.filter((r) => r.status === "uncertain")).toHaveLength(2);
    expect(rows.filter((r) => r.sentCopyStatus === "uncertain")).toHaveLength(
      2,
    );
    expect(rows.every((r) => r.mimeBase64 === "c3ludGhldGlj")).toBe(true);
    expect(
      (await db.db.select().from(s.messageCommands)).every(
        (r) => r.status === "failed" && r.error === restoreReviewReason,
      ),
    ).toBe(true);
    // Real existing handlers, with provider/account resolution canaries.
    const accounts = {
      getProviderSmtpAccountForWork: vi.fn(() => {
        throw Error("remote call");
      }),
      getProviderImapAccountForWork: vi.fn(() => {
        throw Error("remote call");
      }),
    };
    const provider = {
      deliverMessage: vi.fn(),
      mutateMessage: vi.fn(),
      appendSentMessage: vi.fn(),
    };
    const lock = async (_id: string, fn: (tx: typeof db.db) => Promise<void>) =>
      fn(db.db);
    const outgoing = new OutgoingMessageService(
      db.db,
      vi.fn(),
      accounts as never,
      provider as never,
      lock,
    );
    const sent = new SentCopyService(
      db.db,
      accounts as never,
      provider as never,
      lock,
      vi.fn(),
      vi.fn(),
    );
    const commands = new MessageCommandService(
      db.db,
      vi.fn(),
      vi.fn(),
      accounts as never,
      provider as never,
    );
    for (const id of outgoingIds) {
      await outgoing.run(id);
      await sent.run(id);
    }
    for (const id of commandIds) await commands.run(id);
    expect(accounts.getProviderSmtpAccountForWork).not.toHaveBeenCalled();
    expect(accounts.getProviderImapAccountForWork).not.toHaveBeenCalled();
    expect(provider.deliverMessage).not.toHaveBeenCalled();
    expect(provider.mutateMessage).not.toHaveBeenCalled();
  });

  it("restores a current custom archive normally and migrates/verifies with ordinary authority", async () => {
    const source = containers[0];
    expect(
      (
        await source.exec([
          "sh",
          "-c",
          'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U maildock -d maildock -Fc --no-acl -f /tmp/current.dump',
        ])
      ).exitCode,
    ).toBe(0);
    const destination = await start();
    try {
      await destination.container.copyArchiveToContainer(
        (await source.copyArchiveFromContainer(
          "/tmp/current.dump",
        )) as Readable,
        "/tmp",
      );
      expect(
        (
          await destination.container.exec([
            "sh",
            "-c",
            'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h postgres -U maildock -d maildock --no-owner --no-acl --exit-on-error --single-transaction /tmp/current.dump',
          ])
        ).exitCode,
      ).toBe(0);
      await validateDatabaseAuthority(destination.database.client);
      await migrate(destination.database.db, {
        migrationsFolder: "db/migrations",
      });
      await verifyRecoverySchema(destination.database.db);
      expect(
        (
          await verifyRecoveryState(
            destination.database.db,
            destination.config,
            owner,
          )
        ).status,
      ).toBe("verified");
    } finally {
      await destination.database.client.end();
    }
  });

  it.each(["lf", "deployed"] as const)(
    "bridges the exact %s baseline archive and preserves hashes/vector semantics/OIDs without rebuilding",
    async (variant) => {
      const source = await start(),
        destination = await start();
      const baseline = path.join(root, "baseline-migrations");
      await cp("db/migrations", baseline, { recursive: true });
      const journal = JSON.parse(
        await readFile(path.join(baseline, "meta/_journal.json"), "utf8"),
      );
      journal.entries.pop();
      const manifest = (
        await readFile(
          `scripts/postgres/recovery/legacy-migrations${variant === "lf" ? "-lf" : ""}.txt`,
          "utf8",
        )
      )
        .trimEnd()
        .split("\n");
      expect(journal.entries).toHaveLength(manifest.length);
      for (const [i, entry] of journal.entries.entries()) {
        const file = path.join(baseline, `${entry.tag}.sql`);
        const bytes = await readFile(file, "utf8");
        const [hash, timestamp] = manifest[i].split("\t");
        expect(String(entry.when)).toBe(timestamp);
        const digest = (text: string) =>
          createHash("sha256").update(text).digest("hex");
        // Reconstruct only the pinned historical newline bytes in a disposable fixture.
        // Fail rather than synthesizing or accepting any other migration content.
        if (digest(bytes) !== hash) {
          expect(variant).toBe("deployed");
          const historicalBytes = bytes.replace(/\r?\n/g, "\r\n");
          expect(digest(historicalBytes)).toBe(hash);
          await writeFile(file, historicalBytes);
        }
        expect(digest(await readFile(file, "utf8"))).toBe(hash);
      }
      await writeFile(
        path.join(baseline, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      try {
        await migrate(source.database.db, { migrationsFolder: baseline });
        const originalHistory = await source.database.client<
          { hash: string; created_at: string }[]
        >`select hash, created_at from drizzle.__drizzle_migrations order by created_at`;
        const vector = (database: typeof db) =>
          database.client`select public.maildock_search_vector('Subject Łódź', '[{"name":"Owner","address":"first.last@example.invalid"}]'::jsonb, '[]'::jsonb, '[{"address":"to@sample.invalid"}]'::jsonb, '[]'::jsonb, 'body token')::text as vector`;
        const before = await vector(source.database);
        const ids = await source.database
          .client`select 'public.messages'::regclass::oid as table_oid, 'public.messages_search_gin_idx'::regclass::oid as index_oid, 'public.maildock_search_vector(text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure::oid as function_oid`;
        expect(
          (
            await source.container.exec([
              "sh",
              "-c",
              'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U maildock -d maildock -Fc --no-acl -f /tmp/legacy.dump',
            ])
          ).exitCode,
        ).toBe(0);
        await destination.container.copyArchiveToContainer(
          (await source.container.copyArchiveFromContainer(
            "/tmp/legacy.dump",
          )) as Readable,
          "/tmp",
        );
        const bridge = await destination.container.exec([
          "sh",
          "/helper.sh",
          "--fresh-destination-writers-stopped",
          "/tmp/legacy.dump",
        ]);
        expect(bridge.output).toContain("recovery_archive_restored");
        expect(bridge.exitCode).toBe(0);
        await migrate(destination.database.db, {
          migrationsFolder: "db/migrations",
        });
        await validateDatabaseAuthority(destination.database.client);
        await verifyRecoverySchema(destination.database.db);
        const restoredHistory = await destination.database.client<
          { hash: string; created_at: string }[]
        >`select hash, created_at from drizzle.__drizzle_migrations order by created_at`;
        expect(restoredHistory.slice(0, originalHistory.length)).toEqual(
          originalHistory,
        );
        // Complete known histories remain mandatory for schema verification too.
        const current = readMigrationFiles({
          migrationsFolder: "db/migrations",
        });
        const changed = current.findIndex(
          (row, i) => row.hash !== restoredHistory[i].hash,
        );
        if (variant === "deployed") {
          expect(changed).toBeGreaterThanOrEqual(0);
          await destination.database
            .client`update drizzle.__drizzle_migrations set hash=${current[changed].hash} where created_at=${restoredHistory[changed].created_at}`;
          await expect(
            verifyRecoverySchema(destination.database.db),
          ).rejects.toMatchObject({ category: "recovery_schema" });
          await destination.database
            .client`update drizzle.__drizzle_migrations set hash=${restoredHistory[changed].hash} where created_at=${restoredHistory[changed].created_at}`;
        }
        await destination.database
          .client`update drizzle.__drizzle_migrations set hash='unknown-release' where created_at=${restoredHistory[0].created_at}`;
        await expect(
          verifyRecoverySchema(destination.database.db),
        ).rejects.toMatchObject({ category: "recovery_schema" });
        await destination.database
          .client`update drizzle.__drizzle_migrations set hash=${restoredHistory[0].hash} where created_at=${restoredHistory[0].created_at}`;
        const tail = restoredHistory.at(-1)!;
        await destination.database
          .client`update drizzle.__drizzle_migrations set created_at=created_at+1 where created_at=${tail.created_at}`;
        await expect(
          verifyRecoverySchema(destination.database.db),
        ).rejects.toMatchObject({ category: "recovery_schema" });
        await destination.database
          .client`update drizzle.__drizzle_migrations set created_at=${tail.created_at} where created_at=${Number(tail.created_at) + 1}`;
        await verifyRecoverySchema(destination.database.db);
        expect(await vector(destination.database)).toEqual(before);
        await migrate(source.database.db, {
          migrationsFolder: "db/migrations",
        });
        expect(await vector(source.database)).toEqual(before);
        expect(
          await source.database
            .client`select 'public.messages'::regclass::oid as table_oid, 'public.messages_search_gin_idx'::regclass::oid as index_oid, 'public.maildock_search_vector(text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure::oid as function_oid`,
        ).toEqual(ids);
        await source.database.client`set search_path=''`;
        expect(await vector(source.database)).toEqual(before);
        // Already populated/uncertain target is always refused.
        expect(
          (
            await destination.container.exec([
              "sh",
              "/helper.sh",
              "--fresh-destination-writers-stopped",
              "/tmp/legacy.dump",
            ])
          ).exitCode,
        ).toBe(1);
      } finally {
        await source.database.client.end();
        await destination.database.client.end();
      }
    },
  );
});
