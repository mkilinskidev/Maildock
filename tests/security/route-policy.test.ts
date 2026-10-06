import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Exact reviewed exceptions. A new route/method must use the application guard
// or receive a specific boundary review here; no generic skip flag is allowed.
const boundaries = new Map([
  ["auth/[...all]/route.ts:GET", "Better Auth session protocol"],
  [
    "auth/[...all]/route.ts:POST",
    "Better Auth login; Maildock exact-Origin current-session logout",
  ],
  ["setup/route.ts:GET", "Public initialized status"],
  ["setup/route.ts:POST", "Bootstrap secret + exact Origin + bounded parser"],
  [
    "auth/initial-mfa/start/route.ts:POST",
    "Initial MFA: exact Origin + bounded strict JSON + owner session + password + bootstrap + PostgreSQL boundary",
  ],
  [
    "auth/initial-mfa/complete/route.ts:POST",
    "Initial MFA: exact Origin + bounded strict JSON + owner session + bootstrap + TOTP + atomic READY/revocation",
  ],
  ["health/live/route.ts:GET", "Public health probe"],
  ["health/ready/route.ts:GET", "Public health probe"],
  ["oauth/google/start/route.ts:GET", "Owner session + state/PKCE creation"],
  [
    "oauth/google/callback/route.ts:GET",
    "Owner session + atomic state/PKCE consumption",
  ],
  ["oauth/microsoft/start/route.ts:GET", "Owner session + state/PKCE creation"],
  [
    "oauth/microsoft/callback/route.ts:GET",
    "Owner session + atomic state/PKCE consumption",
  ],
]);

it("inventories every HTTP method and requires the guard before application work", () => {
  const root = path.resolve("src/app/api");
  const foundExceptions = new Set<string>();
  const methods = new Set([
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "TRACE",
    "CONNECT",
  ]);
  for (const file of readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith("route.ts"))) {
    const name = file.replaceAll("\\", "/");
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          expect(
            methods.has(declaration.name.getText(source)),
            `${name}: HTTP exports must use reviewed function declarations`,
          ).toBe(false);
      }
      if (
        !ts.isFunctionDeclaration(statement) ||
        !statement.name ||
        !methods.has(statement.name.text)
      )
        continue;
      const method = statement.name.text;
      const key = `${name}:${method}`;
      if (boundaries.has(key)) {
        foundExceptions.add(key);
        continue;
      }
      const body = statement.body!;
      const first = body.statements[0]?.getText(source);
      const second = body.statements[1]?.getText(source);
      expect(first, key).toBe(
        "const denied = await requireOwnerApiAccess(request);",
      );
      expect(second, key).toBe("if (denied) return denied;");
      const text = body.getText(source);
      if (/request\.(json|text)\(|readDraftRequest\(|JSON\.parse/.test(text)) {
        expect(
          body.statements[2]?.getText(source),
          `${key}: JSON must be media-type checked before parsing`,
        ).toContain("requireJsonMediaType(request)");
        expect(body.statements[3]?.getText(source), key).toBe(
          "if (unsupported) return unsupported;",
        );
      }
    }
  }
  expect(foundExceptions).toEqual(new Set(boundaries.keys()));
});
