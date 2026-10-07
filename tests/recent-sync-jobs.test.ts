import { describe, expect, it } from "vitest";

import { recentSyncPayloadSchema } from "@/modules/mail/infrastructure/recent-sync-jobs";

describe("recent synchronization jobs", () => {
  it("accepts a versioned IDs-only payload", () => {
    expect(
      recentSyncPayloadSchema.parse({
        version: 1,
        accountId: "00000000-0000-4000-8000-000000000001",
        mailboxId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toEqual({
      version: 1,
      accountId: "00000000-0000-4000-8000-000000000001",
      mailboxId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("rejects credentials and unknown payload fields", () => {
    expect(() =>
      recentSyncPayloadSchema.parse({
        version: 1,
        accountId: "00000000-0000-4000-8000-000000000001",
        mailboxId: "00000000-0000-4000-8000-000000000002",
        password: "must-never-enter-a-job",
      }),
    ).toThrow();
  });
});
