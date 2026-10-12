import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
export function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b),
    n = sorted.length;
  const percentile = (p: number) =>
    sorted[Math.min(n - 1, Math.ceil(n * p) - 1)] ?? null;
  return {
    n,
    p50: n >= 2 ? percentile(0.5) : null,
    p95: n >= 20 ? percentile(0.95) : null,
    p99: n >= 100 ? percentile(0.99) : null,
    max: n ? sorted[n - 1] : null,
  };
}
export class Trace {
  gzip = createGzip();
  file;
  operations: Record<string, unknown>[] = [];
  count = 0;
  loop = monitorEventLoopDelay({ resolution: 10 });
  constructor(path: URL) {
    this.file = createWriteStream(path);
    this.gzip.pipe(this.file);
    this.loop.enable();
  }
  async write(event: Record<string, unknown>) {
    const accepted = this.gzip.write(
      JSON.stringify({
        utc: new Date().toISOString(),
        at: performance.now(),
        ...event,
      }) + "\n",
    );
    if (!accepted) await once(this.gzip, "drain");
  }
  async operation(event: Record<string, unknown>) {
    const { transport, commands, tagged, ...small } = event;
    const scopes = (transport ?? []) as Record<string, unknown>[];
    await this.write({
      ...small,
      transport: scopes,
      commandCount: (commands as unknown[])?.length,
      taggedCount: (tagged as unknown[])?.length,
    });
    this.count++;
    this.operations.push(small);
    if (this.operations.length > 512) this.operations.shift();
  }
  async close() {
    this.loop.disable();
    this.gzip.end();
    await finished(this.file);
  }
}
