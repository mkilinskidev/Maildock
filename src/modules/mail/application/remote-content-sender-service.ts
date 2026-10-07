import { eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { remoteContentSenders } from "../../../shared/infrastructure/database/schema";

export function normalizedSender(
  from: readonly { address?: string }[],
): string | null {
  // A multi-mailbox From is ambiguous. Never derive identity from display text.
  if (from.length !== 1) return null;
  const address = from[0]?.address?.trim().toLowerCase();
  return address && /^[^\s<>@]+@[^\s<>@]+$/.test(address) ? address : null;
}
export class RemoteContentSenderService {
  constructor(private readonly db: Database) {}
  async list() {
    return this.db
      .select()
      .from(remoteContentSenders)
      .orderBy(remoteContentSenders.address);
  }
  async allowed(address: string | null) {
    if (!address) return false;
    const [rule] = await this.db
      .select()
      .from(remoteContentSenders)
      .where(eq(remoteContentSenders.address, address));
    return !!rule;
  }
  async trust(address: string) {
    await this.db
      .insert(remoteContentSenders)
      .values({ address })
      .onConflictDoNothing();
  }
  async remove(address: string) {
    await this.db
      .delete(remoteContentSenders)
      .where(eq(remoteContentSenders.address, address));
  }
}
