import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Logger } from "pino";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  applicationEvents,
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import {
  eventDefinitions,
  safeDiagnosticDetails,
  type ApplicationEventName,
  type DiagnosticDetails,
  type EventQuery,
  type ApplicationEventPage,
} from "../domain/application-event";

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
export function parseEventCursor(cursor: string) {
  return cursorSchema.parse(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
}
export class ApplicationEventService {
  private nextCleanup = 0;
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}
  async record(
    event: ApplicationEventName,
    context: {
      accountId?: string;
      mailboxId?: string;
      details?: DiagnosticDetails;
    } = {},
  ): Promise<void> {
    try {
      await this.db.insert(applicationEvents).values({
        id: randomUUID(),
        event,
        ...eventDefinitions[event],
        accountId: context.accountId,
        mailboxId: context.mailboxId,
        details: safeDiagnosticDetails(context.details),
      });
    } catch {
      // Deliberately do not serialize database errors: query parameters can contain private data.
      this.logger?.warn(
        { event: "diagnostics.persistence_failed", diagnosticEvent: event },
        "Application event could not be recorded",
      );
    }
    if (Date.now() >= this.nextCleanup) {
      this.nextCleanup = Date.now() + 60 * 60_000;
      await this.cleanup();
    }
  }
  async cleanup(): Promise<void> {
    try {
      await this.db
        .delete(applicationEvents)
        .where(
          lt(
            applicationEvents.createdAt,
            new Date(Date.now() - 30 * 86400_000),
          ),
        );
      await this.db.execute(
        sql`delete from application_events where id in (select id from application_events order by created_at desc, id desc offset 10000)`,
      );
    } catch {
      this.logger?.warn(
        { event: "diagnostics.retention_failed" },
        "Application event retention cleanup failed",
      );
    }
  }
  async list(query: EventQuery): Promise<ApplicationEventPage> {
    const cursor = query.cursor ? parseEventCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({
        id: applicationEvents.id,
        createdAt: applicationEvents.createdAt,
        event: applicationEvents.event,
        accountId: applicationEvents.accountId,
        mailboxId: applicationEvents.mailboxId,
        details: applicationEvents.details,
        accountName: mailAccounts.displayName,
        mailboxPath: mailboxes.remotePath,
      })
      .from(applicationEvents)
      .leftJoin(mailAccounts, eq(applicationEvents.accountId, mailAccounts.id))
      .leftJoin(mailboxes, eq(applicationEvents.mailboxId, mailboxes.id))
      .where(
        and(
          query.level ? eq(applicationEvents.level, query.level) : undefined,
          query.area ? eq(applicationEvents.area, query.area) : undefined,
          query.accountId
            ? eq(applicationEvents.accountId, query.accountId)
            : undefined,
          cursor
            ? or(
                lt(applicationEvents.createdAt, new Date(cursor.at)),
                and(
                  eq(applicationEvents.createdAt, new Date(cursor.at)),
                  lt(applicationEvents.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(applicationEvents.createdAt), desc(applicationEvents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      events: page.map((row) => {
        const details = safeDiagnosticDetails(row.details);
        return {
          ...row,
          ...eventDefinitions[row.event],
          createdAt: row.createdAt.toISOString(),
          details,
          mailboxPath: row.mailboxPath ?? details.mailboxPath ?? null,
        };
      }),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.createdAt.toISOString(), id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
}
