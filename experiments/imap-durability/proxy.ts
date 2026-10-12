import { createServer, connect, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
/** Disposable loopback TCP relay; no host network settings. TLS stays end-to-end.
 * This models delay/bandwidth/blackout/reset, not IP packet loss. */
export class Proxy {
  sockets = new Set<Socket>();
  bytes = 0;
  peakBuffered = 0;
  buffered = 0;
  resets = 0;
  hold = false;
  reject = false;
  dropCommit = false;
  commitObserved: () => void = () => {};
  private timers = new Set<NodeJS.Timeout>();
  private server = createServer((source) => {
    if (this.reject) {
      source.destroy();
      return;
    }
    const target = connect(this.targetPort, "127.0.0.1");
    source.setNoDelay(true);
    target.setNoDelay(true);
    this.sockets.add(source);
    this.sockets.add(target);
    let tail = Buffer.alloc(0);
    const forward = (from: Socket, to: Socket, isServer: boolean) => {
      let next = performance.now();
      from.on("data", (data: Buffer) => {
        this.bytes += data.length;
        if (isServer && this.dropCommit) {
          const combined = Buffer.concat([tail, data]);
          tail = combined.subarray(Math.max(0, combined.length - 16));
          if (combined.includes(Buffer.from("COMMIT\0"))) {
            this.hold = true;
            this.commitObserved();
          }
        }
        if (this.hold) {
          from.pause();
          return;
        }
        // Zero-impairment baseline must not inherit Windows timer quantization.
        if (this.oneWayMs === 0 && !this.bytesPerSecond) {
          if (!to.destroyed && !to.write(data)) {
            from.pause();
            to.once("drain", () => from.resume());
          }
          return;
        }
        from.pause();
        this.buffered += data.length;
        this.peakBuffered = Math.max(this.peakBuffered, this.buffered);
        const now = performance.now();
        next =
          Math.max(now + this.oneWayMs, next) +
          (this.bytesPerSecond
            ? (data.length / this.bytesPerSecond) * 1000
            : 0);
        const timer = setTimeout(
          () => {
            this.timers.delete(timer);
            this.buffered -= data.length;
            if (!to.destroyed) {
              if (to.write(data)) from.resume();
              else to.once("drain", () => from.resume());
            }
          },
          Math.max(0, next - now),
        );
        this.timers.add(timer);
      });
      from.on("error", () => to.destroy());
      from.on("close", () => {
        this.sockets.delete(from);
        to.destroy();
      });
    };
    forward(source, target, false);
    forward(target, source, true);
  });
  constructor(
    readonly targetPort = 32993,
    public oneWayMs = 0,
    public bytesPerSecond = 0,
  ) {}
  async listen() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    return (this.server.address() as { port: number }).port;
  }
  reset() {
    this.resets++;
    for (const s of this.sockets) s.destroy();
    this.hold = false;
  }
  async close() {
    this.reset();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
