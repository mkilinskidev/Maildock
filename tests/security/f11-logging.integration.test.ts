import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerMailboxDiscoveryWorker } from "@/modules/mail/infrastructure/mailbox-discovery-jobs";
import { registerOutgoingWorker } from "@/modules/mail/infrastructure/outgoing-jobs";
import type { MailboxDiscoveryService } from "@/modules/mail/application/mailbox-discovery-service";
import type { OutgoingMessageService } from "@/modules/mail/application/outgoing-message-service";
import { DrizzleQueryError } from "drizzle-orm/errors";

describe("F11 real disposable PostgreSQL, Better Auth and pg-boss canaries", () => {
  let container: StartedTestContainer;
  let connectionString: string;
  let boss: PgBoss;
  let directory: string;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "f11",
        POSTGRES_USER: "synthetic",
        POSTGRES_PASSWORD: "synthetic",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    connectionString = `postgresql://synthetic:synthetic@${container.getHost()}:${container.getMappedPort(5432)}/f11`;
    directory = await mkdtemp(path.join(tmpdir(), "maildock-f11-regression-"));
  });
  afterAll(async () => {
    await boss?.stop();
    await container?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("actual child stdout/stderr rejects session/URL canaries and records only committed ceremony events", async () => {
    const resultFile = path.join(directory, "results.json");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/security/f11-process.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          F11_DATABASE_URL: connectionString,
          F11_RESULT_FILE: resultFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    // Optional local evidence is external to the repository and contains synthetic output only.
    if (process.env.F11_CAPTURE_DIRECTORY) {
      await writeFile(
        path.join(process.env.F11_CAPTURE_DIRECTORY, "auth-stdout.log"),
        stdout,
      );
      await writeFile(
        path.join(process.env.F11_CAPTURE_DIRECTORY, "auth-stderr.log"),
        stderr,
      );
    }
    expect(exit, "synthetic child completed").toBe(0);
    const { results, secrets } = JSON.parse(
      await readFile(resultFile, "utf8"),
    ) as {
      results: Record<
        string,
        { status: number; startedAt: number; finishedAt: number }
      >;
      secrets: string[];
    };
    for (const secret of secrets)
      expect(stdout + stderr, "synthetic secret absent").not.toContain(secret);
    expect(stdout + stderr).not.toMatch(
      /Failed query:|params:|DrizzleQueryError|FORGED_LINE/,
    );
    expect(results["session-db-failure"].status).toBe(500);
    expect(results["callback-rejection"].status).toBe(403);
    const sections: Record<string, string[]> = {};
    for (const line of stdout.trim().split(/\r?\n/)) {
      const entry = JSON.parse(line); // every physical line must be a single valid JSON record
      if (!entry.harness) {
        const match = Object.entries(results).find(
          ([, result]) =>
            entry.time >= result.startedAt && entry.time <= result.finishedAt,
        );
        if (match) (sections[match[0]] ??= []).push(entry.event);
      }
    }
    expect(sections["session-db-failure"]).toContain("auth.dependency_error");
    expect(sections["callback-rejection"]).toContain("auth.dependency_error");
    const expected = {
      setup: ["setup_completed"],
      enrollment: ["mfa_enrollment_completed"],
      "mfa-login": ["mfa_login_completed", "recovery_code_consumed"],
      regeneration: ["recovery_codes_regenerated", "recovery_code_consumed"],
      "replacement-start": [
        "authenticator_replacement_started",
        "recovery_code_consumed",
      ],
      "replacement-complete": ["authenticator_replacement_completed"],
    };
    for (const [name, events] of Object.entries(expected)) {
      expect(results[name].status).toBe(200);
      for (const event of events)
        expect(sections[name]).toContain(`security.${event}`);
      expect(results[`${name}-rollback`].status).toBeGreaterThanOrEqual(400);
      for (const event of events)
        expect(sections[`${name}-rollback`] ?? []).not.toContain(
          `security.${event}`,
        );
    }
    expect(stdout).toContain("security.proof_rejected");
    expect(stdout).toContain("security.admission_rejected");
    expect(stdout).toContain("security.session_failed");
    expect(stdout).toContain("security.invariant_rejected");
    expect(sections.coalescing ?? []).not.toContain(
      "security.invariant_rejected",
    );
    expect(stdout.match(/"event":"security.invariant_rejected"/g)).toHaveLength(
      1,
    );
    expect(stderr).toBe("");
  });

  it("real application handlers preserve retry/terminal failure while pg-boss output excludes sensitive raw errors", async () => {
    boss = new PgBoss({ connectionString });
    boss.on("error", () => {
      /* parent tests inspect handler failure separately */
    });
    await boss.start();
    const markers = [
      "F11_JOB_MAIL_SUBJECT_CANARY",
      "F11_JOB_CREDENTIAL_CANARY",
      "F11_JOB_BODY_CANARY",
    ];
    const fail = async () => {
      throw new DrizzleQueryError(
        "insert into synthetic_mail values ($1,$2,$3)",
        markers,
        new Error(markers.join(" ")),
      );
    };
    await registerMailboxDiscoveryWorker(
      boss,
      { run: fail } as unknown as MailboxDiscoveryService,
      1,
    );
    await registerOutgoingWorker(boss, {
      run: fail,
    } as unknown as OutgoingMessageService);
    for (const [queue, data, state, operation] of [
      [
        "mailbox-discovery-v1",
        { version: 1, accountId: randomUUID() },
        "retry",
        "mailbox-discovery",
      ],
      [
        "outgoing-message-v1",
        { outgoingMessageId: randomUUID() },
        "failed",
        "outgoing",
      ],
    ] as const) {
      const id = await boss.send(queue, data);
      let job;
      const deadline = Date.now() + 20000;
      do {
        job = await boss.getJobById(queue, id!);
        if (job?.state === state) break;
        await delay(50);
      } while (Date.now() < deadline);
      expect(job?.state).toBe(state);
      expect(job?.data).toEqual(data);
      const output = JSON.stringify(job?.output);
      for (const marker of markers) expect(output).not.toContain(marker);
      expect(job?.output).toEqual({
        name: "SafeJobFailure",
        message: `Maildock job failed: ${operation}`,
        category: "internal_error",
        operation,
      });
      if (state === "retry") {
        expect(job?.retryLimit).toBe(4);
        expect(job?.retryCount).toBe(0);
      }
      if (process.env.F11_CAPTURE_DIRECTORY)
        await writeFile(
          path.join(
            process.env.F11_CAPTURE_DIRECTORY,
            `${operation}-job-output.json`,
          ),
          JSON.stringify({ state: job?.state, output: job?.output }, null, 2),
        );
    }
  });
});
