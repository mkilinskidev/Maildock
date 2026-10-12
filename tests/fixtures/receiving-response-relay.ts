import { connect, createServer, type Socket } from "node:net";

/** Same raw reply-loss technique as Stage 1; no PostgreSQL frame parser. */
export async function receivingResponseRelay(url: string) {
  const target = new URL(url);
  const host = target.hostname,
    port = Number(target.port);
  const sockets = new Set<Socket>();
  const control = { drop: false };
  const server = createServer((client) => {
    const upstream = connect(port, host);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (bytes) => upstream.write(bytes));
    upstream.on("data", (bytes) => {
      if (!control.drop) client.write(bytes);
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing relay port");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  return {
    control,
    url: target.toString(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
