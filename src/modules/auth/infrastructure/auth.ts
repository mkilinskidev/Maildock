import { getConfig } from "@/shared/infrastructure/config/config";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";

export const auth = createAuth(getConfig(), db);
