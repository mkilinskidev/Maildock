// Disposable synthetic fixture only. Never invoked by the production entrypoint.
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { parseConfig } from "./dist-worker/shared/infrastructure/config/config.js";
import { createWorkerDatabase } from "./dist-worker/shared/infrastructure/database/database-worker.js";
import { validateDatabaseAuthority } from "./dist-worker/shared/infrastructure/database/database-authority.js";
import {
  verifyRecoveryState,
  verifyMaintenance,
} from "./dist-worker/shared/infrastructure/database/restore-verification.js";
import { AesGcmSecretEncryption } from "./dist-worker/shared/infrastructure/crypto/aes-gcm-secret-encryption.js";
import { LocalBlobStorage } from "./dist-worker/shared/infrastructure/storage/local-blob-storage.js";
import * as s from "./dist-worker/shared/infrastructure/database/schema.js";

const config = parseConfig(process.env),
  db = createWorkerDatabase(config);
const owner = "d7afb047-b000-4b7d-bff7-450de57c5800";
const accountId = "b7afb047-b000-4b7d-bff7-450de57c5800";
const mailboxId = "c7afb047-b000-4b7d-bff7-450de57c5800";
const messageId = "e7afb047-b000-4b7d-bff7-450de57c5800";
const password = "Synthetic recovery password 2026!",
  secret = "JBSWY3DPEHPK3PXP",
  oldCode = "ABCDE-12345";
const bytes = Buffer.alloc(36864, 93),
  hashValue = createHash("sha256").update(bytes).digest("hex");
const cookies = (r) =>
  r.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
async function post(path, body, cookie = "") {
  return fetch("http://127.0.0.1:3000" + path, {
    method: "POST",
    headers: {
      Origin: config.appOrigin,
      "Content-Type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
}
async function login(method = "totp", code) {
  const challenge = await post("/api/auth/sign-in/username", {
    username: "owner-01",
    password,
  });
  assert.equal(challenge.status, 200);
  const factor = await post(
    `/api/auth/mfa/${method === "totp" ? "totp" : "recovery"}`,
    { code: code ?? (await createOTP(secret).totp()) },
    cookies(challenge),
  );
  return factor;
}
try {
  await validateDatabaseAuthority(db.client);
  switch (process.argv[2]) {
    case "seed": {
      const parameters = {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
        outputLen: 32,
      };
      await db.db.insert(s.user).values({
        id: owner,
        name: "owner-01",
        email: "owner@localhost.invalid",
        username: "owner-01",
        displayUsername: "owner-01",
        emailVerified: true,
        twoFactorEnabled: true,
      });
      await db.db.insert(s.account).values({
        id: randomUUID(),
        accountId: owner,
        providerId: "credential",
        userId: owner,
        password: await hash(password, { ...parameters, algorithm: 2 }),
      });
      await db.db.update(s.instanceState).set({
        initializedAt: new Date(),
        ownerUserId: owner,
        bootstrapSecretDigest: null,
        bootstrapExpiresAt: null,
        passwordAlgorithm: "argon2id",
        passwordParameters: parameters,
      });
      await db.db.insert(s.twoFactor).values({
        id: randomUUID(),
        userId: owner,
        secret: await symmetricEncrypt({
          key: config.authSecret,
          data: secret,
        }),
        backupCodes: await symmetricEncrypt({
          key: config.authSecret,
          data: JSON.stringify([oldCode, "FGHIJ-67890"]),
        }),
        verified: true,
      });
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
          "synthetic credential",
          `maildock:account-credential:v1:${accountId}:imap`,
        ),
        smtpHost: "smtp.invalid",
        smtpPort: 465,
        smtpSecurity: "tls",
      });
      await db.db.insert(s.mailboxes).values({
        id: mailboxId,
        accountId,
        name: "INBOX",
        remotePath: "INBOX",
        delimiter: "/",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
      await db.db.insert(s.messages).values({
        id: messageId,
        accountId,
        subject: "Synthetic recovery message",
        internalDate: new Date(),
        size: 36864n,
      });
      await db.db.insert(s.messageContents).values({
        messageId,
        plainText: "Synthetic recovery content",
        searchText: "Synthetic recovery content",
      });
      const storage = new LocalBlobStorage(config.attachmentsPath),
        blob = await storage.put(Readable.from([bytes]), 100000),
        blobId = randomUUID();
      await db.db.insert(s.blobs).values({
        id: blobId,
        storageKey: blob.key,
        size: blob.size,
        sha256: blob.sha256,
      });
      const draftId = randomUUID();
      await db.db.insert(s.drafts).values({
        id: draftId,
        accountId,
        composeMode: "new",
        subject: "Synthetic draft",
      });
      await db.db.insert(s.stagedAttachments).values({
        id: randomUUID(),
        draftId,
        blobId,
        filename: "fixture.bin",
        contentType: "application/octet-stream",
        expiresAt: new Date(Date.now() + 86400000),
      });
      for (const status of ["queued", "sending", "pending", "saving"]) {
        const id = randomUUID();
        await db.db.insert(s.outgoingMessages).values({
          id,
          accountId,
          from: { name: "", address: "owner@example.invalid" },
          to: [{ name: "", address: "to@example.invalid" }],
          cc: [],
          bcc: [],
          subject: "Synthetic outgoing",
          plainText: "Synthetic body",
          messageId: `${id}@invalid`,
          mimeBlobId: blobId,
          status: ["pending", "saving"].includes(status) ? "sent" : status,
          sentCopyPolicy: ["pending", "saving"].includes(status)
            ? "maildock"
            : "server",
          sentCopyStatus: ["pending", "saving"].includes(status)
            ? status
            : "not_required",
        });
      }
      for (const status of ["pending", "executing"])
        await db.db.insert(s.messageCommands).values({
          id: randomUUID(),
          accountId,
          mailboxId,
          messageId,
          status,
          action: "mark_read",
          sourcePath: "INBOX",
          sourceUidValidity: 1n,
          sourceUid: 1n,
        });
      const boss = new PgBoss(config.databaseUrl);
      await boss.start();
      await boss.createQueue("f125-synthetic");
      await boss.send(
        "f125-synthetic",
        { synthetic: true },
        { startAfter: 3600 },
      );
      await boss.stop();
      assert.equal(blob.sha256, hashValue);
      break;
    }
    case "login": {
      const response = await login();
      assert.equal(response.status, 200);
      const cookie = cookies(response);
      assert.equal(
        (
          await fetch("http://127.0.0.1:3000/api/accounts", {
            headers: { cookie },
          })
        ).status,
        200,
      );
      await writeFile(
        "/operator/stale-session.json",
        JSON.stringify({ cookie }),
        { mode: 0o600 },
      );
      break;
    }
    case "prepare-backup": {
      // Recreate representative rollback intent only while source writers stop.
      const rows = await db.db.select().from(s.outgoingMessages);
      let i = 0;
      for (const row of rows)
        if (row.sentCopyPolicy === "server")
          await db.db
            .update(s.outgoingMessages)
            .set({ status: i++ === 0 ? "queued" : "sending" })
            .where(eq(s.outgoingMessages.id, row.id));
      i = 0;
      for (const row of rows)
        if (row.sentCopyPolicy === "maildock")
          await db.db
            .update(s.outgoingMessages)
            .set({
              sentCopyStatus: i++ === 0 ? "pending" : "saving",
              sentCopySyncPending: false,
            })
            .where(eq(s.outgoingMessages.id, row.id));
      i = 0;
      for (const row of await db.db.select().from(s.messageCommands))
        await db.db
          .update(s.messageCommands)
          .set({ status: i++ === 0 ? "pending" : "executing" })
          .where(eq(s.messageCommands.id, row.id));
      assert.ok((await db.db.select().from(s.session)).length > 0);
      break;
    }
    case "revoke-source-session":
      await db.db.delete(s.session);
      break;
    case "verify-restored-not-maintained": {
      assert.ok((await db.db.select().from(s.session)).length > 0);
      assert.equal(
        (await db.db.select().from(s.recoveryMaintenance)).length,
        0,
      );
      break;
    }
    case "verify-offline": {
      const receipt = JSON.parse(
        await readFile("/operator/recovery.json", "utf8"),
      );
      assert.equal(
        await verifyMaintenance(db.db, config, owner, receipt.receiptId),
        "verified",
      );
      assert.equal((await stat("/operator/recovery.json")).mode & 0o777, 0o600);
      const state = await verifyRecoveryState(db.db, config, owner);
      assert.equal(state.owner.id, owner);
      assert.equal(
        (await db.db.select().from(s.messages))[0].searchBody,
        "Synthetic recovery content",
      );
      assert.equal((await db.db.select().from(s.blobs))[0].sha256, hashValue);
      assert.ok(
        (await db.client`select * from pgboss.job where name='f125-synthetic'`)
          .length > 0,
      );
      break;
    }
    case "verify-http": {
      const { cookie } = JSON.parse(
        await readFile("/operator/stale-session.json", "utf8"),
      );
      assert.equal(
        (
          await fetch("http://127.0.0.1:3000/api/accounts", {
            headers: { cookie },
          })
        ).status,
        401,
      );
      assert.notEqual((await login("recovery", oldCode)).status, 200);
      assert.equal((await login()).status, 200);
      const receipt = JSON.parse(
        await readFile("/operator/recovery.json", "utf8"),
      );
      assert.equal(
        (await login("recovery", receipt.recoveryCodes[0])).status,
        200,
      );
      assert.equal(
        (await fetch("http://127.0.0.1:3000/api/health/ready")).status,
        200,
      );
      const states = await db.db.select().from(s.outgoingMessages);
      assert.equal(states.filter((r) => r.status === "uncertain").length, 2);
      assert.equal(
        states.filter((r) => r.sentCopyStatus === "uncertain").length,
        2,
      );
      break;
    }
    default:
      throw Error("Unknown disposable fixture operation");
  }
  console.log("Disposable recovery fixture assertion passed.");
} finally {
  await db.client.end();
}
