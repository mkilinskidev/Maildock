import { readFile } from "node:fs/promises";
import type { MigrationMeta } from "drizzle-orm/migrator";

type RecordedMigration = { hash: string; created_at: string };
const serialize = (rows: { hash: string; timestamp: number }[]) =>
  rows.map((row) => `${row.hash}\t${row.timestamp}\n`).join("");

/** Compare complete reviewed histories; never normalize or rewrite stored hashes. */
export async function matchesRecoveryMigrationHistory(
  actual: RecordedMigration[],
  expected: MigrationMeta[],
) {
  const current = expected.map((row) => ({
    hash: row.hash,
    timestamp: row.folderMillis,
  }));
  if (actual.length !== expected.length) return false;
  const matches = (history: typeof current) =>
    actual.every(
      (row, i) =>
        row.hash === history[i].hash &&
        Number(row.created_at) === history[i].timestamp,
    );
  if (matches(current)) return true;

  const [deployed, lf] = await Promise.all(
    ["legacy-migrations.txt", "legacy-migrations-lf.txt"].map((name) =>
      readFile(`scripts/postgres/recovery/${name}`, "utf8"),
    ),
  );
  const manifestPattern = /^(?:[a-f0-9]{64}\t[0-9]{13}\n){32}$/;
  if (!manifestPattern.test(deployed) || !manifestPattern.test(lf))
    return false;
  // The alternate is tied to the exact baseline files shipped in this release.
  // Later migrations must still match their current exact hashes and timestamps.
  if (lf !== serialize(current.slice(0, 32))) return false;
  const historical = deployed
    .trimEnd()
    .split("\n")
    .map((line, i) => {
      const [hash, timestamp] = line.split("\t");
      if (Number(timestamp) !== current[i].timestamp)
        throw new Error("Invalid reviewed recovery migration history.");
      return { hash, timestamp: Number(timestamp) };
    });
  return matches([...historical, ...current.slice(32)]);
}
