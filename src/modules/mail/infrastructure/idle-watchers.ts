import { ImapFlow } from "imapflow";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { PgBoss } from "pg-boss";

import type { AccountsService } from "../../accounts/application/accounts-service";
import { imapOptions } from "../../accounts/infrastructure/imap-smtp-mail-provider";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";
import { enqueueDelta } from "./delta-sync-jobs";

type Watch = { stop(): void };
export function idleReconnectDelay(backoff: number, random: number): number {
  return backoff + Math.floor((random * backoff) / 2);
}

export function nextIdleReconnectBackoff(backoff: number): number {
  return Math.min(backoff * 2, 5 * 60_000);
}
type IdleClient = Pick<
  ImapFlow,
  "once" | "on" | "connect" | "mailboxOpen" | "close" | "capabilities"
>;

export class IdleWatcherManager {
  private readonly watches = new Map<string, Watch>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private refreshing = false;

  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly boss: PgBoss,
    private readonly logger: Logger,
    private readonly createClient: (
      options: ConstructorParameters<typeof ImapFlow>[0],
    ) => IdleClient = (options) => new ImapFlow(options),
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh().catch(() => undefined),
      60_000,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.refreshing) return;
    this.refreshing = true;
    try {
      const eligible = await this.database
        .select({
          accountId: mailAccounts.id,
          accountName: mailAccounts.displayName,
          accountEmail: mailAccounts.email,
          mailboxId: mailboxes.id,
          remotePath: mailboxes.remotePath,
          capabilities: mailAccounts.imapCapabilities,
        })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.enabled, true),
            eq(mailboxes.selectable, true),
            eq(mailboxes.lifecycleStatus, "active"),
            eq(mailboxes.recentSyncStatus, "success"),
          ),
        );
      const inboxes = eligible.filter(
        (row) =>
          row.remotePath.toUpperCase() === "INBOX" &&
          row.capabilities.includes("IDLE"),
      );
      const desired = new Set(inboxes.map((row) => row.mailboxId));
      for (const [id, watch] of this.watches)
        if (!desired.has(id)) {
          watch.stop();
          this.watches.delete(id);
        }
      for (const row of inboxes)
        if (!this.watches.has(row.mailboxId))
          this.watches.set(
            row.mailboxId,
            this.watch(
              row.accountId,
              row.mailboxId,
              row.remotePath,
              row.accountName,
              row.accountEmail,
            ),
          );
    } finally {
      this.refreshing = false;
    }
  }

  private watch(
    accountId: string,
    mailboxId: string,
    remotePath: string,
    accountName: string,
    accountEmail: string,
  ): Watch {
    let cancelled = false;
    let client: IdleClient | undefined;
    let backoff = 1_000;
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let resumeSleep: (() => void) | undefined;
    const wake = () => {
      if (cancelled || wakeTimer) return;
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        void enqueueDelta(this.boss, accountId, mailboxId, "idle").catch(
          () => undefined,
        );
      }, 500);
    };
    const loop = async () => {
      while (!cancelled && !this.stopped) {
        try {
          const account =
            await this.accounts.getProviderImapAccountForWork(accountId);
          if (cancelled || this.stopped) break;
          client = this.createClient({
            ...imapOptions(account.imap),
            disableAutoIdle: false,
            autoIdleDelay: 1000,
            maxIdleTime: 4 * 60_000,
            socketTimeout: 6 * 60_000,
          });
          const active = client;
          const closed = new Promise<void>((resolve) =>
            active.once("close", resolve),
          );
          active.on("error", () => undefined);
          active.on("exists", wake);
          active.on("flags", wake);
          active.on("expunge", wake);
          active.on("mailboxClose", wake);
          await active.connect();
          if (!active.capabilities.has("IDLE")) {
            active.close();
            return;
          }
          await active.mailboxOpen(remotePath, { readOnly: true });
          await enqueueDelta(this.boss, accountId, mailboxId, "idle");
          this.logger.info(
            {
              event: "mail.idle_connected",
              accountId,
              mailboxId,
              accountName,
              accountEmail,
              mailboxPath: remotePath,
            },
            "IDLE watcher connected",
          );
          backoff = 1_000;
          await closed;
        } catch {
          this.logger.warn(
            {
              event: "mail.idle_disconnected",
              accountId,
              mailboxId,
              accountName,
              accountEmail,
              mailboxPath: remotePath,
              category: "connection_failed",
            },
            "IDLE watcher disconnected",
          );
        } finally {
          client?.close();
          client = undefined;
        }
        if (cancelled || this.stopped) break;
        await new Promise<void>((resolve) => {
          resumeSleep = resolve;
          sleepTimer = setTimeout(
            resolve,
            idleReconnectDelay(backoff, Math.random()),
          );
        });
        sleepTimer = undefined;
        resumeSleep = undefined;
        backoff = nextIdleReconnectBackoff(backoff);
      }
    };
    void loop();
    return {
      stop: () => {
        cancelled = true;
        if (wakeTimer) clearTimeout(wakeTimer);
        if (sleepTimer) clearTimeout(sleepTimer);
        resumeSleep?.();
        client?.close();
      },
    };
  }
}
