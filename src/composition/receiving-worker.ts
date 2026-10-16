import type { Logger } from "pino";
import type { AppConfig } from "../shared/infrastructure/config/config";
import type { BlobStorage } from "../shared/application/blob-storage";
import { ReceivingExecutor } from "../shared/infrastructure/database/receiving-executor";
import { ElectedReceivingCoordinator } from "../modules/mail/application/receiving-election";
import { receivingTopologyHandlers } from "../modules/mail/application/receiving-topology";
import type { receivingCredentialBindings } from "../modules/accounts/infrastructure/receiving-credentials";

/** The process supervisor ticks only while verified owner MFA is ready. Lost
 * lifetimes retire completely before another actor can attempt election. */
export class ReceivingWorker {
  private current?: ElectedReceivingCoordinator;
  private executor?: ReceivingExecutor;
  private enabled = false;
  private ticking?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(
    private readonly input: {
      config: Pick<AppConfig, "databaseUrl" | "diagnosticEndpoint">;
      logger: Logger;
      blobStorage: BlobStorage;
      credentials: ReturnType<typeof receivingCredentialBindings>;
    },
  ) {}
  get owner() {
    return this.enabled ? this.current : undefined;
  }
  start() {
    if (this.enabled || this.stopping)
      throw new Error("Receiving lifetime already started or retiring");
    this.enabled = true;
    this.executor = new ReceivingExecutor(this.input.config.databaseUrl, 2);
    return this.tick();
  }
  tick(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.ticking ??= this.advance().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async advance() {
    if (
      this.current &&
      ["lost", "stopped"].includes(this.current.snapshot.phase)
    ) {
      await this.current.stop();
      this.current = undefined;
    }
    if (!this.enabled) return;
    this.current ??= new ElectedReceivingCoordinator({
      executor: this.executor!,
      ...this.input.credentials,
      diagnosticEndpoint: this.input.config.diagnosticEndpoint,
      onControlError: (error) =>
        this.input.logger.warn(
          { event: "receiving.control", err: error },
          "Receiving control failed; retiring owner",
        ),
      operationHandlers: {
        ...receivingTopologyHandlers,
        list: { topology: "list", discover: true },
        repair: { repair: true },
        store: { flags: true },
        move: { move: true },
        "content-slice": { content: true },
        "attachment-slice": { attachment: this.input.blobStorage },
        append: { sentCopy: this.input.blobStorage },
        "exact-lookup": {
          flags: true,
          move: true,
          sentCopy: this.input.blobStorage,
        },
      },
    });
    if (
      this.current.snapshot.phase === "follower" &&
      (await this.current.elect())
    )
      this.input.logger.info(
        { event: "receiving.owner", workers: 2, sqlCapacity: 2 },
        "Receiving coordinator elected",
      );
  }
  async notify(accountId: string) {
    await this.owner?.notify(accountId);
  }
  stop(): Promise<void> {
    this.enabled = false;
    // Revoke admission synchronously, including an in-flight election.
    const retirement = this.current?.stop();
    this.stopping ??= (async () => {
      try {
        await retirement;
        await this.ticking;
      } finally {
        await this.executor?.stop();
        this.current = undefined;
        this.executor = undefined;
      }
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
