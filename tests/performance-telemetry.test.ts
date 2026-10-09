import { describe, expect, it, vi } from "vitest";
const capture = vi.hoisted(() => vi.fn());
vi.mock("@/shared/infrastructure/logging/logger", () => ({
  createLogger: () => ({ info: capture }),
}));
import {
  withPerformance,
  measureStage,
  instrumentImap,
  reconciliationMetrics,
} from "@/shared/infrastructure/logging/performance";

describe("allowlisted stage telemetry", () => {
  it("aggregates protocol stages without emitting arguments, errors or payloads", async () => {
    capture.mockClear();
    await expect(
      withPerformance("delta", async () => {
        await measureStage("credentials", async () => "token-secret");
        const client = instrumentImap({
          search: async () => {
            throw Object.assign(new Error("subject body password secret"), {
              code: "ETIMEOUT",
            });
          },
        });
        reconciliationMetrics(40000, 0, true);
        await client.search();
      }),
    ).rejects.toMatchObject({ code: "ETIMEOUT" });
    const summary = capture.mock.calls[0][0];
    expect(summary).toMatchObject({
      event: "mail.performance",
      operation: "delta",
      success: false,
      errorCode: "ETIMEOUT",
      failedStage: "new_uids",
      localUids: 40000,
      condstore: true,
    });
    expect(summary.stages.credentials.calls).toBe(1);
    expect(JSON.stringify(summary)).not.toMatch(/secret|subject|password/);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("cannot change success or failure when the logger fails", async () => {
    capture.mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    await expect(withPerformance("content", async () => 42)).resolves.toBe(42);
    const failure = new Error("operation failed");
    await expect(
      withPerformance("content", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    capture.mockReset();
  });
});
