import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Exact reviewed exceptions. A new route/method must use the application guard
// or receive a specific boundary review here; no generic skip flag is allowed.
const boundaries = new Map([
  [
    "auth/owner-recovery/resume/route.ts:POST",
    "Exact Origin + bounded strict empty JSON + M + CLI-created marker + expiring digest-only enrollment authority; no business session",
  ],
  [
    "auth/owner-recovery/complete/route.ts:POST",
    "Exact Origin + bounded strict JSON + M + current enrollment authority + bounded TOTP proof + atomic verification/revocation; fresh login required",
  ],
  [
    "auth/owner-recovery/cancel/route.ts:POST",
    "Exact Origin + bounded strict empty JSON + M + current enrollment authority revocation; durable recovery preserved",
  ],
  [
    "auth/mfa/manage/recovery/regenerate/route.ts:POST",
    "Exact Origin + bounded strict JSON + synchronized business owner/password/current MFA + encrypted replacement after commit",
  ],
  [
    "auth/mfa/manage/authenticator/start/route.ts:POST",
    "Exact Origin + bounded strict JSON + synchronized business owner/password/current MFA + revocation + digest-only ceremony",
  ],
  [
    "auth/mfa/manage/authenticator/resume/route.ts:POST",
    "Exact Origin + bounded strict empty JSON + synchronized unexpired narrow ceremony + pending factor only",
  ],
  [
    "auth/mfa/manage/authenticator/complete/route.ts:POST",
    "Exact Origin + bounded strict JSON + synchronized narrow ceremony + installed TOTP primitive + single-use completion",
  ],
  [
    "auth/mfa/totp/route.ts:POST",
    "Strict bounded JSON + exact Origin + real password challenge + PostgreSQL boundary + business session authorization",
  ],
  [
    "auth/mfa/recovery/route.ts:POST",
    "Strict bounded JSON + exact Origin + real password challenge + atomic Better Auth recovery consumption + business session authorization",
  ],
  [
    "auth/mfa/cancel/route.ts:POST",
    "Strict empty JSON + exact Origin + engine-owned challenge cookie expiry; no session issuance",
  ],
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
      // F11 permits exactly one outer failure boundary. Authorization must
      // still be the first application statement INSIDE that boundary, and
      // no work may run outside it. All original guard/parser checks remain.
      const outer = statement.body!;
      expect(outer.statements, `${key}: one outer boundary only`).toHaveLength(
        1,
      );
      const returned = outer.statements[0];
      expect(ts.isReturnStatement(returned), key).toBe(true);
      if (
        !ts.isReturnStatement(returned) ||
        !returned.expression ||
        !ts.isCallExpression(returned.expression)
      )
        throw new Error(`Missing route boundary: ${key}`);
      const call = returned.expression;
      expect(call.expression.getText(source), key).toBe("routeBoundary");
      expect(call.arguments, key).toHaveLength(1);
      const work = call.arguments[0];
      expect(ts.isArrowFunction(work), key).toBe(true);
      if (!ts.isArrowFunction(work) || !ts.isBlock(work.body))
        throw new Error(`Missing boundary callback: ${key}`);
      const body = work.body;
      if (boundaries.has(key)) {
        foundExceptions.add(key);
        continue;
      }
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
