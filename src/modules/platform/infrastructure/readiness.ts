import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "@/shared/infrastructure/config/config";

export type ReadinessDependencies = {
  config: AppConfig;
  query: { unsafe: (query: string) => PromiseLike<unknown> };
};

export async function checkReadiness({
  config,
  query,
}: ReadinessDependencies): Promise<boolean> {
  try {
    await query.unsafe("select 1");
    const migrationCheck = (await query.unsafe(`
      select
        to_regclass('public.instance_state') is not null as instance_state,
        to_regclass('drizzle.__drizzle_migrations') is not null as migrations
    `)) as Array<{ instance_state: boolean; migrations: boolean }>;
    if (!migrationCheck[0]?.instance_state || !migrationCheck[0]?.migrations)
      return false;

    await mkdir(config.attachmentsPath, { recursive: true });
    await access(config.attachmentsPath, constants.R_OK | constants.W_OK);
    const probe = path.join(
      config.attachmentsPath,
      `.readiness-${randomUUID()}`,
    );
    await writeFile(probe, "ready", { flag: "wx", mode: 0o600 });
    await rm(probe);
    return true;
  } catch {
    return false;
  }
}
