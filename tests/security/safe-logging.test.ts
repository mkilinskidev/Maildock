import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { createLogger } from "@/shared/infrastructure/logging/logger";
import {
  failureDiagnostic,
  logFailure,
  safeJobHandler,
} from "@/shared/infrastructure/logging/diagnostics";
import { betterAuthLogger } from "@/modules/auth/infrastructure/auth-logger";
import { JobRuntime } from "@/modules/jobs/infrastructure/job-runtime";
import {
  parseConfig,
  ConfigurationError,
} from "@/shared/infrastructure/config/config";
import {
  routeBoundary,
  pageBoundary,
} from "@/shared/infrastructure/logging/web-boundary";
import { registerMailboxDiscoveryWorker } from "@/modules/mail/infrastructure/mailbox-discovery-jobs";
import { registerRecentSyncWorker } from "@/modules/mail/infrastructure/recent-sync-jobs";
import { registerDeltaWorker } from "@/modules/mail/infrastructure/delta-sync-jobs";
import { registerBackfillWorker } from "@/modules/mail/infrastructure/backfill-sync-jobs";
import { registerContentWorker } from "@/modules/mail/infrastructure/content-jobs";
import { registerAttachmentWorker } from "@/modules/mail/infrastructure/attachment-jobs";
import { registerMessageCommandWorker } from "@/modules/mail/infrastructure/message-command-jobs";
import { registerOutgoingWorker } from "@/modules/mail/infrastructure/outgoing-jobs";
import { registerSentCopyWorker } from "@/modules/mail/infrastructure/sent-copy-jobs";
import type { PgBoss } from "pg-boss";

const marker = "F11_RAW_SECRET_MAIL_SQL_CANARY";
const raw = () =>
  Object.assign(new Error(marker, { cause: new Error(marker) }), {
    query: marker,
    params: [marker],
    response: marker,
    credentials: marker,
  });
function capture() {
  let output = "";
  return {
    logger: createLogger(
      { logLevel: "info" },
      {
        write: (chunk) => {
          output += chunk;
        },
      },
    ),
    output: () => output,
  };
}

describe("F11 allowlisted diagnostics and fallback redaction contract", () => {
  it("censors supported root/shallow keys and explicit request header shapes", () => {
    const fields = [
      "password",
      "Password",
      "authorization",
      "Authorization",
      "cookie",
      "Cookie",
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "clientSecret",
      "client_secret",
      "imapPassword",
      "smtpPassword",
      "sessionToken",
      "proofCode",
      "recoveryCodes",
      "bootstrapSecret",
      "credentialsEncryptionKey",
    ];
    const { logger, output } = capture();
    for (const key of fields)
      logger.info(
        { [key]: marker, context: { [key]: marker } },
        "Fallback contract probe",
      );
    logger.info(
      {
        auth: { pass: marker },
        req: {
          headers: {
            authorization: marker,
            Authorization: marker,
            cookie: marker,
            Cookie: marker,
          },
        },
      },
      "Fallback contract probe",
    );
    expect(output()).not.toContain(marker);
    expect(output()).toContain("[REDACTED]");
  });
  it("explicitly does NOT sanitize deep objects, arrays, Error text, SQL, JSON strings or URL queries", () => {
    const { logger, output } = capture();
    for (const object of [
      { a: { b: { accessToken: marker } } },
      { items: [{ accessToken: marker }] },
      { err: raw() },
      { query: marker, params: [marker] },
      { text: JSON.stringify({ accessToken: marker }) },
      { url: `https://example.test/?code=${marker}` },
    ])
      logger.info(object, "Unsupported input probe");
    const lines = output().trim().split("\n");
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line).toContain(marker);
  });
  it("Better Auth discards arbitrary message/arguments and does not inspect Error getters", () => {
    const { logger, output } = capture();
    const boundary = betterAuthLogger(logger);
    const poison = Object.defineProperty({}, "message", {
      get() {
        throw new Error(marker);
      },
    });
    Reflect.apply(boundary.log, boundary, [
      "error",
      `${marker}\nFORGED_LINE`,
      raw(),
      poison,
    ]);
    Reflect.apply(boundary.log, boundary, ["warn", marker, poison]);
    expect(output()).not.toContain(marker);
    expect(output()).not.toContain("FORGED_LINE");
    expect(
      output()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual(["auth.dependency_error", "auth.dependency_warning"]);
  });
  it("normalizes each worker-owned operational failure and runtime EventEmitter error", () => {
    const { logger, output } = capture();
    for (const operation of ["startup", "shutdown"] as const)
      logFailure(logger, raw(), "worker", operation);
    const runtime = new JobRuntime(
      { databaseUrl: "postgresql://synthetic:synthetic@localhost/disposable" },
      logger,
    );
    runtime.boss.emit("error", raw());
    expect(output()).not.toContain(marker);
    expect(output()).toContain("worker.startup_failed");
    expect(output()).toContain("worker.shutdown_failed");
    expect(output()).toContain("jobs.runtime_failed");
  });
  it("malformed APP_ORIGIN has sanitized configuration/error/process diagnostics", () => {
    let failure: unknown;
    try {
      parseConfig({
        MAILDOCK_ENV: "test",
        APP_ORIGIN: marker,
        DATABASE_URL: "postgresql://test:test@localhost/test",
        AUTH_SECRET: Buffer.alloc(32, 2).toString("base64"),
        CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
        ATTACHMENTS_PATH: process.cwd(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(inspect(failure)).toContain("APP_ORIGIN");
    expect(inspect(failure)).not.toContain(marker);
    expect(failureDiagnostic(failure, "worker", "startup")).toMatchObject({
      category: "configuration",
      configurationField: "APP_ORIGIN",
    });
  });
  it("web route/page boundaries normalize raw failures before Next sinks", async () => {
    const response = await routeBoundary(async () => {
      throw raw();
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(marker);
    await expect(
      pageBoundary(async () => {
        throw raw();
      }),
    ).rejects.toThrow("Maildock page could not be loaded.");
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    await expect(
      pageBoundary(async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
  });
  it("logging output failures do not replace operational outcomes", async () => {
    const logger = {
      error: () => {
        throw raw();
      },
      fatal: () => {
        throw raw();
      },
    };
    expect(() => logFailure(logger, raw(), "worker", "shutdown")).not.toThrow();
    await expect(
      safeJobHandler("delta-sync", async () => {
        throw raw();
      })([]),
    ).rejects.toMatchObject({
      name: "SafeJobFailure",
      category: "internal_error",
      operation: "delta-sync",
      stack: undefined,
    });
  });
});

describe("F11 every registered Maildock job handler", () => {
  const registrations = [
    registerMailboxDiscoveryWorker,
    registerRecentSyncWorker,
    registerDeltaWorker,
    registerBackfillWorker,
    registerContentWorker,
    registerAttachmentWorker,
    registerMessageCommandWorker,
    registerOutgoingWorker,
    registerSentCopyWorker,
  ];
  it.each(registrations)(
    "%s normalizes malformed payload exceptions before durable serialization",
    async (register) => {
      let handler!: (batch: unknown[]) => Promise<unknown>;
      const boss = {
        getDb: () => ({
          executeSql: async () => ({
            rows: [
              {
                provider_type: "imap_smtp",
                auth_method: "password",
                oauth_provider_id: null,
                oauth_status: null,
                enabled: true,
                work_revision: "1",
              },
            ],
          }),
        }),
        createQueue: vi.fn(),
        findJobs: vi.fn(async () => []),
        work: vi.fn(async (_queue, _options, work) => {
          handler = work;
        }),
      } as unknown as PgBoss;
      const dependencyInvoked = vi.fn();
      const service = new Proxy(
        {},
        {
          get: () => async () => {
            dependencyInvoked();
            throw raw();
          },
        },
      );
      // Signatures differ; runtime registration is exercised without changing queues.
      await Reflect.apply(register, undefined, [
        boss,
        service,
        register === registerBackfillWorker ||
        register === registerMessageCommandWorker
          ? async (_id: string, work: () => Promise<void>) => work()
          : 1,
        async (_id: string, work: () => Promise<void>) => work(),
      ]);
      try {
        await handler([
          {
            data: {
              version: 1,
              accountId: marker,
              mailboxId: marker,
              attachmentId: marker,
              outgoingMessageId: marker,
              commandId: marker,
            },
          },
        ]);
        throw new Error("Expected failure");
      } catch (error) {
        expect(error).toMatchObject({
          name: "SafeJobFailure",
          category: "internal_error",
        });
        expect(inspect(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
      }
      const id = "00000000-0000-4000-8000-000000000011";
      const data =
        register === registerAttachmentWorker
          ? { attachmentId: id, accountId: id, accountRevision: "1" }
          : register === registerMessageCommandWorker
            ? { commandId: id }
            : register === registerOutgoingWorker ||
                register === registerSentCopyWorker
              ? { outgoingMessageId: id }
              : register === registerMailboxDiscoveryWorker
                ? { version: 1, accountId: id, accountRevision: "1" }
                : register === registerContentWorker
                  ? {
                      version: 1,
                      accountId: id,
                      mailboxId: id,
                      messageId: id,
                      accountRevision: "1",
                    }
                  : register === registerDeltaWorker
                    ? {
                        version: 1,
                        accountId: id,
                        mailboxId: id,
                        reason: "poll",
                        accountRevision: "1",
                      }
                    : {
                        version: 1,
                        accountId: id,
                        mailboxId: id,
                        accountRevision: "1",
                      };
      try {
        await handler([
          {
            data,
            retryCount: 0,
            startedOn: new Date(),
            startAfter: new Date(),
            createdOn: new Date(),
          },
        ]);
        throw new Error("Expected underlying failure");
      } catch (error) {
        expect(error).toMatchObject({
          name: "SafeJobFailure",
          category: "internal_error",
        });
        expect(inspect(error)).not.toContain(marker);
      }
      expect(dependencyInvoked).toHaveBeenCalledOnce();
    },
  );
});
