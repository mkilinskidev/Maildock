import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  safe: true,
  unavailable: false,
  query: vi.fn(),
  end: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock("@/shared/infrastructure/config/config", async (original) => ({
  ...(await original<typeof import("@/shared/infrastructure/config/config")>()),
  getConfig: () => ({}),
}));
vi.mock("@/shared/infrastructure/database/database", () => ({
  createDatabase: () => ({
    client: Object.assign(state.query, { end: state.end }),
  }),
}));
vi.mock("@/shared/infrastructure/logging/logger", () => ({
  createLogger: () => ({ fatal: state.fatal }),
}));
class RefusedExit extends Error {}
beforeEach(() => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.clearAllMocks();
  state.safe = true;
  state.unavailable = false;
  state.end.mockResolvedValue(undefined);
  state.query.mockImplementation(async () => {
    if (state.unavailable) throw new Error("F12_SQL_CREDENTIAL_CANARY");
    return [
      {
        identity_ok: true,
        authority_ok: state.safe,
        scope_ok: true,
        schemas_ok: true,
        objects_ok: true,
        system_ok: true,
      },
    ];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("checks ordinary web authority once and closes its startup connection", async () => {
  const { register } = await import("@/instrumentation");
  await register();
  expect(state.query).toHaveBeenCalledTimes(1);
  expect(state.end).toHaveBeenCalledTimes(1);
  expect(state.fatal).not.toHaveBeenCalled();
});

it.each(["authority", "connection"])(
  "exits the independent web root on %s failure with only a fixed diagnostic",
  async (failure) => {
    state.safe = failure !== "authority";
    state.unavailable = failure === "connection";
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new RefusedExit();
    });
    const { register } = await import("@/instrumentation");
    await expect(register()).rejects.toBeInstanceOf(RefusedExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(state.end).toHaveBeenCalledTimes(1);
    expect(state.fatal.mock.calls[0][0]).toMatchObject({
      category:
        failure === "authority" ? "database_authority" : "database_unavailable",
    });
    expect(JSON.stringify(state.fatal.mock.calls)).not.toContain("CANARY");
  },
);
