export const GMAIL_DELTA_INITIALIZATION_TIMEOUT_MS = 60_000;

type ConnectingClient = { connect(): Promise<unknown>; close(): void };

/** Bounds the whole initialization, including a peer that keeps sending data. */
export class GmailDeltaConnectionExperiment {
  private lifecycle = new AbortController();

  start() {
    if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController();
  }

  stop() {
    this.lifecycle.abort();
  }

  async connect(
    client: ConnectingClient,
    signal?: AbortSignal,
    onTimeout?: (error: Error) => void,
  ): Promise<void> {
    const cancellation = signal
      ? AbortSignal.any([this.lifecycle.signal, signal])
      : this.lifecycle.signal;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        cancellation.removeEventListener("abort", abort);
      };
      const terminate = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          client.close();
        } catch {
          /* Preserve the cancellation/deadline even if teardown fails. */
        }
        reject(error);
      };
      const abort = () =>
        terminate(
          Object.assign(
            new Error("Gmail delta initialization was cancelled."),
            { code: "ABORT_ERR" },
          ),
        );
      const timer = setTimeout(() => {
        if (settled) return;
        const error = Object.assign(
          new Error("Gmail delta initialization deadline exceeded."),
          { code: "CONNECT_TIMEOUT" },
        );
        try {
          onTimeout?.(error);
        } catch {
          /* Diagnostics have no authority. */
        }
        terminate(error);
      }, GMAIL_DELTA_INITIALIZATION_TIMEOUT_MS);
      cancellation.addEventListener("abort", abort, { once: true });
      if (cancellation.aborted) {
        abort();
        return;
      }
      // Observe late rejection as well: closing the transport settles real ImapFlow.
      Promise.resolve()
        .then(() => {
          if (!settled) return client.connect();
        })
        .then(
          () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
        );
    });
  }
}
