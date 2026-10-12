# Recommendation

**READY FOR NEXT VALIDATION PHASE**

The real-server experiment supports progressive bounded UID windows and one data lane as the next validation baseline. Three alternating A trials show first metadata at 216–304 ms versus 1.57–2.12 seconds for a full UID/flags inventory. Twenty-seven successful 50,000 + 10 trials obtain every initial and appended identity; worst observed wait after APPEND completion is 465.05 ms. A 15,000-deletion run converges exact current membership in 25.21 seconds while ten arrivals remain responsive, with a 326.94 ms worst wait.

No unexplained missing still-existing identity, duplicate local placement, unsupported historical boundary or accepted stale epoch occurred in the completed trials. Failed smoke, interleaving, limit, instrumentation and idle-timeout traces are retained and are not counted as passing runs. The byte-limit experiment rejects excessive data, measures 1,180 bytes of received overshoot, closes the native transport and publishes no partial metadata. Existing 46 scripted transport scenarios and 47 application IMAP regressions pass.

The extra data lane reduces one small user's admission wait but does not establish a consistent arrival or throughput advantage worth the concurrent-writer complexity. Keep one authoritative data lane, and treat an optional watcher as a measured notification aid rather than a correctness dependency. Refresh selection before trusting UIDNEXT and classify legal unsolicited flags separately from required metadata.

This recommendation is **not production implementation approval or a successful full architecture validation**. D/E are partially tested: one destructive run, one-page CONDSTORE comparison, orderly JSON restart only, and scripted transport faults separately from Dovecot. The reference 20 ms RTT/20 MiB/s conditions, calibrated server clocks, repeated deterministic race matrix, crash-consistent PostgreSQL progress, lease/epoch/turn transaction fences, multi-account fairness, long saturation, huge sparse gaps, full MIME/provider compatibility and preserved business integrations remain unproven. Each unmeasured numerical hypothesis is labeled in [results](BENCHMARK_RESULTS.md).

The next authorized validation phase should focus on durable atomic facts/frontiers and integrated deadline/admission fencing under controlled latency and concurrent load. No production synchronization engine, dependency patch, database migration, push, merge or PR follows from this experiment.
