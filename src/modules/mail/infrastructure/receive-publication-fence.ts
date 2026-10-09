import { eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";
import {
  MailTransportRouter,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";

/** Call on the publication transaction, before mailbox/message locks. Holding a
 * shared account row lock prevents disable/reconnect between validation and commit. */
export async function assertImapPublication(
  tx: Pick<Database, "select">,
  accountId: string,
  revision?: string,
) {
  const [account] = await tx
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, accountId))
    .for("share");
  if (!account) throw new StaleAccountWorkError();
  new MailTransportRouter().requireImap(account, revision);
}
