import { connect } from "node:net";
import { expect, it } from "vitest";
import { fixture } from "../experiments/imap-transport/fixture";

it("retires accepted TCP connections that have not completed the TLS handshake", async () => {
  const peer = await fixture(() => false);
  const socket = connect(peer.endpoint.port, peer.endpoint.host);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const closing = peer.cleanup();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(peer.peers).toHaveLength(0);
    expect(
      await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]),
    ).toBe(true);
  } finally {
    clearTimeout(timer);
    if (!socket.destroyed) socket.resetAndDestroy();
    await closing;
  }
});
