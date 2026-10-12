# Recommendation

**REQUIRES ARCHITECTURE REVISION**

The tested PostgreSQL model preserves atomic facts/frontiers, conservative replay,
unique placements, lease/epoch protection and durable due-work recovery. An actual
lost COMMIT response, worker SIGKILL boundaries, independent coordinator processes,
remote-cap takeover rejection and controlled transport faults were exercised.
Production services, schema and earlier research/experiments are preserved.

A retained correctness reproduction found a late cancelled DB callback rolling
back a newer transaction while its caller reported success. The final experiment
repairs that execution boundary with explicit transaction commands and SQL lifetime
fencing; post-fix fault and load evidence is identified separately. This failure
must remain part of the architecture review, rather than being hidden by earlier
green counts or good latency.

Before implementation planning is approved, review the small clarifications in
[ARCHITECTURE_IMPLICATIONS.md](ARCHITECTURE_IMPLICATIONS.md): commit-time authority,
same-owner obsolete-result fencing, real database timeout settlement, and current
demand/rotation during recovery. They strengthen the existing simple direction;
they do not justify a receipt ledger or a separate synchronization framework.

Performance hypotheses are measured in [PERFORMANCE_RESULTS.md](PERFORMANCE_RESULTS.md),
including retained initial instrumentation/recovery counterexamples. Named NOT RUN
cases and production queue/business integration remain explicit. No unsafe result
is excluded to produce an implementation recommendation.

This ends Phase 3. No production implementation, push, merge or PR is authorized.
