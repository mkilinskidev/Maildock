import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve("dist-worker");

async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewrite(target);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const source = await readFile(target, "utf8");
    const qualified = source.replace(
      /(from\s+["']|import\s*(?:\(\s*)?["'])@\/([^"']+)(["'])/g,
      (_statement, prefix, specifier, quote) => {
        const relative = path
          .relative(path.dirname(target), path.join(outputRoot, specifier))
          .replaceAll(path.sep, "/");
        return `${prefix}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`;
      },
    );
    const rewritten = qualified.replace(
      /(from\s+["']|import\s*(?:\(\s*)?["'])(\.\.?\/[^"']+)(["'])/g,
      (statement, prefix, specifier, quote) =>
        /\.[a-z0-9]+$/i.test(specifier)
          ? statement
          : `${prefix}${specifier}.js${quote}`,
    );
    if (rewritten !== source) await writeFile(target, rewritten, "utf8");
  }
}

await rewrite(outputRoot);
