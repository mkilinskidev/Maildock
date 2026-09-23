import { getConfig } from "@/shared/infrastructure/config/config";
import { createDatabase } from "@/shared/infrastructure/database/database";

const runtimeDatabase = createDatabase(getConfig());

export const db = runtimeDatabase.db;
export const sqlClient = runtimeDatabase.client;
