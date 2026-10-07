import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import nextConfig from "../../next.config";
import { config as proxyConfig } from "@/proxy";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { BlobLimitError } from "@/shared/application/blob-storage";

vi.mock("@/modules/auth/infrastructure/auth", () => ({ auth: {} }));
vi.mock("@/modules/auth/application/session-validation", () => ({
  getValidBusinessSession: vi.fn(),
}));

// Exercise the installed dependency, not a copy of the patched algorithm.
const require = createRequire(import.meta.url);
const { getCloneableBody } = require("next/dist/server/body-streams") as {
  getCloneableBody: (
    source: Readable,
    limit: number,
  ) => { cloneBodyStream(): Readable; finalize(): Promise<void> };
};

it("ships matching CJS/ESM overflow rejection and the locked dependency patch", () => {
  const root = path.dirname(require.resolve("next/package.json"));
  for (const prefix of ["dist/server", "dist/esm/server"]) {
    const body = readFileSync(
      path.join(root, prefix, "body-streams.js"),
      "utf8",
    );
    const server = readFileSync(
      path.join(root, prefix, "next-server.js"),
      "utf8",
    );
    expect(body).toContain("if (overflowError) throw overflowError;");
    expect(body).not.toContain("const urlInfo");
    expect(server).toContain("err.code === 'NEXT_PROXY_BODY_TOO_LARGE'");
    expect(server).toContain("res.body('Request body is too large.').send();");
  }
  const patch = readFileSync("patches/next@16.3.6.patch");
  const hash = createHash("sha256").update(patch).digest("hex");
  expect(readFileSync("pnpm-lock.yaml", "utf8")).toContain(
    `next@16.3.6: ${hash}`,
  );
  expect(readFileSync("pnpm-workspace.yaml", "utf8")).toContain(
    "next@16.3.6: patches/next@16.3.6.patch",
  );
  const dockerfile = readFileSync("Dockerfile", "utf8");
  expect(dockerfile.indexOf("COPY patches ./patches")).toBeLessThan(
    dockerfile.indexOf("pnpm install --frozen-lockfile"),
  );
});

it("uses Next 16.3.6 with a finite proxy ceiling and bypasses only the raw upload", () => {
  expect(require("next/package.json").version).toBe("16.3.6");
  expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(
    10 * 1024 * 1024,
  );
  for (const url of [
    "/api/attachments/staged",
    "/api/attachments/staged/",
    "/api/attachments/staged?marker=synthetic",
  ]) {
    expect(
      unstable_doesMiddlewareMatch({ config: proxyConfig, nextConfig, url }),
    ).toBe(false);
  }
  for (const url of [
    "/api/setup",
    "/api/auth/sign-in/username",
    "/api/attachments/staged/00000000-0000-4000-8000-000000000000",
    "/api/attachments/staged-extra",
    "/api/outgoing",
    "/accounts",
  ]) {
    expect(
      unstable_doesMiddlewareMatch({ config: proxyConfig, nextConfig, url }),
    ).toBe(true);
  }
});

it.each([7, 8])(
  "replays every byte below/at the installed clone limit (%i)",
  async (size) => {
    const input = Readable.from([
      Buffer.alloc(3, 65),
      Buffer.alloc(size - 3, 66),
    ]);
    const body = getCloneableBody(input, 8);
    const clone = body.cloneBodyStream();
    const chunks: Buffer[] = [];
    for await (const chunk of clone) chunks.push(chunk);
    await body.finalize();
    const replay: Buffer[] = [];
    for await (const chunk of input) replay.push(chunk);
    expect(Buffer.concat(replay)).toEqual(Buffer.concat(chunks));
    expect(Buffer.concat(replay).length).toBe(size);
  },
);

it.each(["CANARY", "%0aFORGED_LINE", "x".repeat(2048)])(
  "rejects clone overflow before replay and emits no request URL (%s)",
  async (marker) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = Object.assign(
        Readable.from([Buffer.alloc(8), Buffer.alloc(1)]),
        {
          url: `/api/setup?synthetic=${marker}`,
        },
      );
      const body = getCloneableBody(input, 8);
      for await (const chunk of body.cloneBodyStream()) void chunk;
      await expect(body.finalize()).rejects.toMatchObject({
        code: "NEXT_PROXY_BODY_TOO_LARGE",
      });
      expect(warning.mock.calls).toEqual([
        [
          "Request body exceeded the configured proxy limit; rejecting request.",
        ],
      ]);
    } finally {
      warning.mockRestore();
    }
  },
);

it("propagates an incomplete source at clone finalization", async () => {
  const input = new Readable({ read() {} });
  const body = getCloneableBody(input, 8);
  body.cloneBodyStream();
  const result = body.finalize();
  input.push(Buffer.alloc(2));
  input.destroy(new Error("Synthetic transport abort"));
  await expect(result).rejects.toThrow("Synthetic transport abort");
});

it("publishes exact storage bytes and cleans partial files on overflow or abort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maildock-f12-"));
  try {
    const storage = new LocalBlobStorage(root);
    const bytes = Buffer.from("synthetic-exact-bytes");
    const blob = await storage.put(
      Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]),
      bytes.length,
    );
    expect(blob.size).toBe(bytes.length);
    expect(blob.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(
      await readFile(path.join(root, "blobs", blob.key.slice(0, 2), blob.key)),
    ).toEqual(bytes);
    await expect(
      storage.put(Readable.from([bytes, Buffer.from("x")]), bytes.length),
    ).rejects.toBeInstanceOf(BlobLimitError);
    async function* aborted() {
      yield bytes.subarray(0, 7);
      throw new Error("Synthetic client abort");
    }
    await expect(storage.put(aborted(), bytes.length)).rejects.toThrow(
      "Synthetic client abort",
    );
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
    const files = await readdir(path.join(root, "blobs"), { recursive: true });
    expect(files.filter((file) => file.includes(blob.key))).toHaveLength(1);
    expect(
      files.filter((file) => file.split(path.sep).length > 1),
    ).toHaveLength(1);
  } finally {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    expect(path.basename(root).startsWith("maildock-f12-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
