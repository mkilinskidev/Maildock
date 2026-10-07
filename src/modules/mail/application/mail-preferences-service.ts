import { eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { instanceState } from "../../../shared/infrastructure/database/schema";
import {
  autoReadSchema,
  defaultAutoRead,
  type AutoReadPreference,
} from "../domain/mail-interactions";

export class MailPreferencesService {
  constructor(private readonly database: Database) {}

  async autoRead(): Promise<AutoReadPreference> {
    const [settings] = await this.database
      .select({ value: instanceState.autoRead })
      .from(instanceState)
      .where(eq(instanceState.id, 1));
    return autoReadSchema.parse(settings?.value ?? defaultAutoRead);
  }

  async setAutoRead(value: AutoReadPreference): Promise<void> {
    const autoRead = autoReadSchema.parse(value);
    await this.database
      .insert(instanceState)
      .values({ id: 1, autoRead })
      .onConflictDoUpdate({
        target: instanceState.id,
        set: { autoRead, updatedAt: new Date() },
      });
  }
}
