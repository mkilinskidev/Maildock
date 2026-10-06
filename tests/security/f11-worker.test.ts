import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  output: "",
  failComposition: false,
  failStartup: false,
  failAuthority: false,
  ready: false,
}));
vi.mock("@/shared/infrastructure/logging/logger", async (original) => {
  const actual =
    await original<typeof import("@/shared/infrastructure/logging/logger")>();
  return {
    createLogger: () =>
      actual.createLogger(
        { logLevel: "info" },
        {
          write: (line) => {
            state.output += line;
          },
        },
      ),
  };
});
vi.mock("@/modules/auth/application/instance-readiness", () => ({
  isInstanceReady: async () => state.ready,
}));
vi.mock("@/composition/worker", async () => {
  const { createLogger } =
    await import("@/shared/infrastructure/logging/logger");
  const failure = () =>
    Object.assign(new Error("F11_WORKER_RAW_CANARY"), {
      params: ["F11_WORKER_RAW_CANARY"],
    });
  return {
    createWorkerComposition: () => {
      if (state.failComposition) throw failure();
      const poller = { start: vi.fn(), stop: vi.fn() };
      return {
        logger: createLogger({ logLevel: "info" }),
        events: { cleanup: async () => {} },
        database: {
          db: {},
          client: Object.assign(
            async () => [
              {
                identity_ok: true,
                authority_ok: !state.failAuthority,
                scope_ok: true,
                schemas_ok: true,
                objects_ok: true,
                system_ok: true,
              },
            ],
            { end: async () => {} },
          ),
        },
        jobs: {
          start: async () => {
            if (state.failStartup) throw failure();
          },
          stop: async () => {},
          boss: {},
        },
        watchers: {
          stop: async () => {
            throw failure();
          },
        },
        attachmentPoller: poller,
        poller,
        backfillPoller: poller,
        commandPoller: poller,
        outgoingPoller: poller,
        sentCopyPoller: poller,
      };
    },
  };
});

const previousExitCode = process.exitCode;
const initialTerm = new Set(process.rawListeners("SIGTERM"));
const initialInt = new Set(process.rawListeners("SIGINT"));
afterEach(() => {
  process.exitCode = previousExitCode;
  for (const [signal, initial] of [
    ["SIGTERM", initialTerm],
    ["SIGINT", initialInt],
  ] as const)
    for (const listener of process.rawListeners(signal))
      if (!initial.has(listener))
        process.removeListener(
          signal,
          listener as (...args: unknown[]) => void,
        );
});
describe("F11 actual worker process composition/startup/shutdown boundaries", () => {
  it("rejects unsafe authority before business startup with a fixed diagnostic", async () => {
    vi.resetModules();
    state.output = "";
    state.failComposition = false;
    state.failAuthority = true;
    await import("@/composition/worker-process");
    expect(state.output).toContain("database_authority");
    expect(state.output).not.toContain("worker.shutdown_failed");
    expect(process.exitCode).toBe(1);
    state.failAuthority = false;
  });
  it("captures composition failures before readiness and preserves nonzero exit", async () => {
    vi.resetModules();
    state.output = "";
    state.failComposition = true;
    await import("@/composition/worker-process");
    expect(state.output).toContain("worker.startup_failed");
    expect(state.output).not.toContain("F11_WORKER_RAW_CANARY");
    expect(process.exitCode).toBe(1);
  });
  it("captures readiness/start failures and subsequent shutdown failures", async () => {
    vi.resetModules();
    state.output = "";
    state.failComposition = false;
    state.failStartup = true;
    state.ready = true;
    await import("@/composition/worker-process");
    expect(state.output).toContain("worker.startup_failed");
    expect(state.output).toContain("worker.shutdown_failed");
    expect(state.output).not.toContain("F11_WORKER_RAW_CANARY");
    expect(process.exitCode).toBe(1);
  });
});
