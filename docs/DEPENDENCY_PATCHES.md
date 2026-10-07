# Dependency patches

Maildock carries version-specific pnpm patches that are part of the supported production build.

- `patches/imapflow@2.0.6.patch` corrects conditional IMAP STORE behavior required for CONDSTORE conflict handling.
- `patches/pg-boss@12.33.7.patch` prevents stately pending work from being selected beside a live active job with the same singleton key.
- `patches/@better-auth__drizzle-adapter@1.7.5.patch` preserves the complete conditional predicate used by Maildock's atomic authentication-state updates.
- `patches/next@16.3.6.patch` enforces the reviewed framework request-body boundary; staged attachment upload keeps its separate streaming limit.

Do not remove a patch just because a newer package exists. For a patched dependency upgrade: reproduce the original regression against the candidate package, inspect the published code, remove the patch only when equivalent upstream behavior is proven, retain regression coverage, verify lockfile patch hashes, run focused/security/full tests, and build/inspect the production image.

The Dockerfile copies `patches/` before both frozen installs, so build and production dependency artifacts use the same reviewed patch set.
