import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("qualifies dynamic worker imports and loads them in native Node ESM", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "maildock-worker-imports-"),
  );
  try {
    const output = path.join(directory, "dist-worker");
    await mkdir(path.join(output, "nested"), { recursive: true });
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      path.join(output, "projector.js"),
      "export const value = 42;",
    );
    const entry = path.join(output, "nested", "content.js");
    await writeFile(
      entry,
      `
      const local = await import("../projector");
      const alias = await import("@/projector");
      const qualified = await import("../projector.js");
      console.log(local.value + alias.value + qualified.value);
    `,
    );
    await promisify(execFile)(
      process.execPath,
      [path.resolve("scripts/fix-worker-imports.mjs")],
      { cwd: directory },
    );
    const source = await readFile(entry, "utf8");
    expect(source).not.toContain('import("@/');
    expect(source).not.toContain('import("../projector")');
    const result = await promisify(execFile)(process.execPath, [entry]);
    expect(result.stdout.trim()).toBe("126");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
