import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Preserved negative evidence: end() does NOT mean backend settlement. This is
// a driver observation, not the acceptance contract of the production executor.
// No TEST_DATABASE_URL escape hatch: faults run only against disposable fixtures.
describe("receiving lane public end() retirement prerequisite", () => {
  let container: StartedTestContainer;
  let url: string;
  let reader: postgres.Sql;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_DB: "receiving_retirement_gate",
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "disposable-fixture-only",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    url = `postgres://fixture:disposable-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_retirement_gate`;
    reader = postgres(url, { max: 1 });
    await reader`create role receiving login password 'disposable-lane-only'`;
  });

  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await container?.stop();
  });

  it.each([1, 2])(
    "preserves the counterexample: backend survives forced end (pool %i)",
    async (max) => {
      const laneUrl = new URL(url);
      laneUrl.username = "receiving";
      laneUrl.password = "disposable-lane-only";
      const lane = postgres(laneUrl.toString(), { max });
      let pid: number | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const reserved = await lane.reserve();
        [{ pid }] = await reserved<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        await reserved`begin`;
        // Keep server execution alive long enough to observe the retirement result.
        pending = reserved`select pg_sleep(5)`.then(
          () => undefined,
          () => undefined,
        );
        const deadline = performance.now() + 2000;
        let executing = false;
        while (performance.now() < deadline) {
          const [state] =
            await reader`select wait_event from pg_stat_activity where pid=${pid}`;
          if (state?.wait_event === "PgSleep") {
            executing = true;
            break;
          }
          await delay(10);
        }
        expect(
          executing,
          "fixture must observe real server execution before retirement",
        ).toBe(true);
        await lane.end({ timeout: 0 });
        // Independent application transactions must remain valid.
        expect((await reader`select 32 as answer`)[0].answer).toBe(32);
        const backends =
          await reader`select state, wait_event from pg_stat_activity where pid=${pid}`;
        expect(
          backends,
          "end resolved while the old backend can still execute",
        ).toEqual([{ state: "active", wait_event: "PgSleep" }]);
      } finally {
        // Admin cleanup is fixture-only, never a proposed production cancellation API.
        if (pid !== undefined)
          await reader`select pg_terminate_backend(${pid}, 2000)`;
        await pending;
        await lane.end({ timeout: 0 });
      }
    },
  );

  it.each([false, "require"] as const)(
    "must close stalled startup I/O before forced end resolves (ssl=%s)",
    async (ssl) => {
      const sockets = new Set<Socket>();
      let accept!: () => void;
      const accepted = new Promise<void>((resolve) => (accept = resolve));
      // Accept TCP and consume bytes, but never complete PostgreSQL/TLS startup.
      const peer = createServer((socket) => {
        sockets.add(socket);
        socket.on("data", () => undefined);
        socket.once("close", () => sockets.delete(socket));
        accept();
      });
      await new Promise<void>((resolve) =>
        peer.listen(0, "127.0.0.1", resolve),
      );
      const address = peer.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture TCP port");
      const lane = postgres({
        host: "127.0.0.1",
        port: address.port,
        user: "fixture",
        database: "fixture",
        ssl,
        max: 1,
        connect_timeout: 2,
      });
      const reservation = lane.reserve().then(
        () => undefined,
        () => undefined,
      );
      try {
        await accepted;
        await lane.end({ timeout: 0 });
        // Give FIN/close propagation a full event-loop turn; this is not settlement.
        await delay(50);
        expect(
          sockets.size,
          "forced end returned with a live startup transport",
        ).toBe(0);
      } finally {
        for (const socket of sockets) socket.destroy();
        await reservation;
        await lane.end({ timeout: 0 });
        await new Promise<void>((resolve, reject) =>
          peer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
