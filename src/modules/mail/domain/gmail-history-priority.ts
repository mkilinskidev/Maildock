import type { GmailHistory } from "../../accounts/infrastructure/gmail-client";

/** Missing label snapshots cannot establish absence from INBOX. Generic
 * references duplicated by typed events add no independent negative evidence. */
export function classifyGmailHistory(
  history: GmailHistory["history"],
  localInbox: ReadonlySet<string>,
): { id: string; priorityClass: number }[] {
  const priorities = new Map<string, number>();
  for (const record of history) {
    const typed = [
      ...record.messagesAdded.map((event) => ({ ...event, ambiguous: false })),
      ...record.messagesDeleted.map((event) => ({
        ...event,
        ambiguous: false,
      })),
      ...record.labelsAdded.map((event) => ({
        ...event,
        ambiguous: event.labelIds === undefined,
      })),
      ...record.labelsRemoved.map((event) => ({
        ...event,
        ambiguous: event.labelIds === undefined,
      })),
    ];
    const typedIds = new Set(typed.map((event) => event.message.id));
    const events = [
      ...typed,
      ...record.messages
        .filter((m) => !typedIds.has(m.id))
        .map((message) => ({ message, labelIds: undefined, ambiguous: true })),
    ];
    for (const event of events) {
      const message = event.message;
      const inbox =
        localInbox.has(message.id) ||
        event.labelIds?.includes("INBOX") ||
        message.labelIds?.includes("INBOX");
      const priority =
        inbox || event.ambiguous || message.labelIds === undefined ? 0 : 1;
      priorities.set(
        message.id,
        Math.min(priorities.get(message.id) ?? 1, priority),
      );
    }
  }
  return [...priorities].map(([id, priorityClass]) => ({ id, priorityClass }));
}
