import { sql, type SQLWrapper } from "drizzle-orm";
import {
  messageAttachments,
  messageContents,
  messagePlacementProjection as placement,
} from "../../../shared/infrastructure/database/schema";

/** Frozen remote bytes must still have their original visible source. */
export function visibleResource(
  message: SQLWrapper,
  mailbox: SQLWrapper,
  epoch: SQLWrapper,
  uid: SQLWrapper,
  binding: SQLWrapper,
) {
  return sql`maildock_receiving_visible_resource(${message}, ${mailbox}, ${epoch}, ${uid}, ${binding})`;
}
export const visibleContent = () =>
  visibleResource(
    messageContents.messageId,
    messageContents.sourceMailboxId,
    messageContents.sourceUidValidity,
    messageContents.sourceUid,
    messageContents.sourceConfigurationBinding,
  );
export const visibleAttachment = () =>
  visibleResource(
    messageAttachments.messageId,
    messageAttachments.sourceMailboxId,
    messageAttachments.sourceUidValidity,
    messageAttachments.sourceUid,
    messageAttachments.sourceConfigurationBinding,
  );

/** IDs alone cannot authorize reuse of a prepared receiving reference. */
export function matchingComposeSource(
  source: import("../domain/compose-source").SourceContext,
) {
  const i = source.identity;
  return sql`(NOT maildock_receiving_account_enrolled(${source.accountId}::uuid) OR
    ${
      i
        ? sql`(${placement.uidValidity}=${i.epoch}::bigint AND ${placement.uid}=${i.uid}::bigint
      AND ${placement.configurationBinding}=${i.configuration}::bigint)`
        : sql`false`
    })`;
}
