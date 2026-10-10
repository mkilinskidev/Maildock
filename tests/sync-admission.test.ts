import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { installSyncAdmission } from "@/modules/mail/infrastructure/sync-admission";

describe("synchronization admission adapter boundaries", () => {
  function fixture(acquired = true) {
    const executeSql = vi.fn(async () => ({ rows: [] }));
    const tx = {
      db: {
        executeSql: vi.fn(async (sql: string) => ({
          rows: sql.includes("pg_try_advisory_xact_lock") ? [{ acquired }] : [],
        })),
      },
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };
    const db: ReturnType<PgBoss["getDb"]> = {
      executeSql,
      beginTransaction: vi.fn(async () => tx),
    };
    const boss = { getDb: () => db } as unknown as PgBoss;
    const restore = installSyncAdmission(boss, 2);
    return { db, tx, executeSql, restore };
  }
  const fetchSql =
    "WITH next AS (SELECT j.id FROM pgboss.job_common j WHERE j.name = 'mailbox-delta-sync-v1' LIMIT 1) UPDATE pgboss.job_common j SET started_on = pgboss.job_now() RETURNING j.id";
  it("leaves commands and content database operations unchanged and restores the adapter", async () => {
    const f = fixture();
    await f.db.executeSql("select 1", ["parameter"]);
    expect(f.executeSql).toHaveBeenCalledWith("select 1", ["parameter"]);
    expect(f.db.beginTransaction).not.toHaveBeenCalled();
    f.restore();
    expect(f.db.executeSql).toBe(f.executeSql);
  });
  it("does not retry or fetch when another process owns short admission authority", async () => {
    const f = fixture(false);
    expect(await f.db.executeSql(fetchSql)).toEqual({ rows: [] });
    expect(f.tx.db.executeSql).toHaveBeenCalledOnce();
    expect(f.tx.commit).toHaveBeenCalledOnce();
    expect(f.tx.rollback).not.toHaveBeenCalled();
  });
  it("fails closed on an unsupported fetch shape", async () => {
    const f = fixture();
    await expect(
      f.db.executeSql(fetchSql.replace("LIMIT 1", "LIMIT 2")),
    ).rejects.toThrow("Unsupported pg-boss");
    expect(f.executeSql).not.toHaveBeenCalled();
    expect(f.db.beginTransaction).not.toHaveBeenCalled();
  });
  it("rolls back SQL failures without swallowing them or modifying retry deadlines", async () => {
    const f = fixture();
    f.tx.db.executeSql.mockRejectedValueOnce(
      new Error("fixture database unavailable"),
    );
    await expect(f.db.executeSql(fetchSql)).rejects.toThrow(
      "fixture database unavailable",
    );
    expect(f.tx.rollback).toHaveBeenCalledOnce();
    expect(f.tx.commit).not.toHaveBeenCalled();
  });
});
