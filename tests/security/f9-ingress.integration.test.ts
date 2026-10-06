import { spawn } from "node:child_process";
import { GenericContainer, Wait } from "testcontainers";
import { expect, it } from "vitest";

it("F9 production address headers share HTTP buckets and empty session metadata", async () => {
  const container = await new GenericContainer("postgres:18.6-bookworm")
    .withEnvironment({
      POSTGRES_DB: "f9",
      POSTGRES_USER: "maildock",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "tests/security/f9-process.ts"],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            TEST: "false",
            F9_TEST_DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/f9`,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
        },
      );
      let result: unknown;
      let errors = "";
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
      child.on("message", (message) => {
        result = message;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(result);
        else
          reject(new Error(`F9 production child failed (${code}): ${errors}`));
      });
    });
    expect(result).toEqual({
      status: "pass",
      scenarios: 10,
      keys: expect.arrayContaining([
        "no-trusted-ip|/get-session",
        "no-trusted-ip|/sign-in/username",
      ]),
      sessionIp: "",
      denied: 10,
    });
  } finally {
    await container.stop();
  }
});
