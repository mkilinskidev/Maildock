# Dependency patches

Maildock carries version-specific pnpm patches that are part of the supported production build.

- `patches/imapflow@2.0.6.patch` corrects conditional IMAP STORE behavior required for CONDSTORE conflict handling.
- `patches/pg-boss@12.33.7.patch` prevents stately pending work from being selected beside a live active job with the same singleton key.
- Better Auth Drizzle adapter 1.7.7 preserves the complete conditional predicate in the outer guarded update upstream; the former 1.7.5 patch is no longer needed. PostgreSQL concurrency regression tests remain required.
- `patches/next@16.3.8.patch` enforces the reviewed framework request-body boundary; staged attachment upload keeps its separate streaming limit.

Next.js 16.3.8 still truncates proxy bodies upstream, so its patch is retained with unchanged contents under the new version. MailParser 3.9.28 pins Nodemailer 10.0.10 and uses its address parser; a scoped pnpm override selects Nodemailer 10.0.13 there as well as in the application.

Version-scoped overrides resolve source-map-js 1.2.1 to 1.2.2 and Sharp 0.35.4 to 0.35.5 for security fixes. Sharp's matching platform binaries and libvips artifacts update with it; unrelated dependency versions stay pinned.

Do not remove a patch just because a newer package exists. For a patched dependency upgrade: reproduce the original regression against the candidate package, inspect the published code, remove the patch only when equivalent upstream behavior is proven, retain regression coverage, verify lockfile patch hashes, run focused/security/full tests, and build/inspect the production image.

The Dockerfile copies `patches/` before both frozen installs, so build and production dependency artifacts use the same reviewed patch set.
