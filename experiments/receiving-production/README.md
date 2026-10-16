# R16 normal deployment smoke

## R17 multi-mailbox validation

Use the same disposable normal Compose deployment described below, with
`R17_MAILBOXES=1` in the **fixture** service's environment. This seeds two large
secondary folders, custom folders, all five product roles, a nonselectable
container and overlapping Gmail-like IMAP labels per account. It does not contact
a real provider. The built application uses its normal W2/C1/D2 worker.

Run `smoke.mjs setup`, then `r17-smoke.mjs sync`, `quiet`, `moves`, `sent` and `reader`
using the same one-shot producer command below. `sync` requires all 24 selectable
mailboxes and 3,124 independent active placements, then sets a manual Archive
mapping to `Przechowalnia`. `quiet` changes flags/membership remotely without a
wake. `moves` and `sent` test both UIDPLUS and no-UIDPLUS visibility; Sent also
checks the server-copy policy and original MIME digests.
It manually maps Sent to the custom Projects mailbox. `reader` checks secondary
body retrieval, body search, cross-mailbox rejection and the authenticated render route.

`r17-smoke.mjs many` adds 80 empty remote folders and waits for ordinary periodic
LIST and receiving to complete all 104 selectable mailboxes, without requesting
discovery or sending a wake. Restart only the app and run `r17-smoke.mjs restart`
to verify retained identities/coverage/manual mapping and folder reads. Retain
each phase's own JSON result; a failed phase is not a successful complete run.

Use `resources.mjs LABEL` during activity and `resources.mjs LABEL --gc` for an
explicit inspector-GC retained-heap comparison before/after `many`. Both inspect
the actual web/worker; producer memory is excluded. GC samples are labelled and
are not natural peak-memory measurements. Keep the inspector confined to the
disposable override. Preserve raw results outside the checkout and shut down
only the explicitly isolated project when finished.

## Original deployment setup

This disposable fixture exercises the built application image with the normal
`container-entrypoint.mjs`, web server and compiled worker. It never connects to a
real mail provider. The producer imports the same compiled application services
used by HTTP handlers; it does not invoke a legacy receiving executor. This is
service-level functional coverage plus authenticated HTTPS API render-route coverage;
it does not automate a browser UI.

Use a new Compose project and new volumes. Generate `POSTGRES_PASSWORD`,
`AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` outside the checkout; set
`APP_ORIGIN=https://localhost:31416`. Do not use an existing installation or its
environment file. The `setup` phase creates a TOTP secret through BetterAuth,
verifies a time-based code, and establishes the authenticated fixture session.

Build the base `docker-compose.yml` app normally. Add a temporary override:

```yaml
services:
  app:
    network_mode: service:fixture
    expose: !reset []
    environment:
      NODE_EXTRA_CA_CERTS: /r16-experiments/imap-transport/localhost-cert.pem
      NODE_OPTIONS: --inspect=127.0.0.1:0
    volumes:
      - /ABSOLUTE/REPO/experiments:/r16-experiments:ro
      - /ABSOLUTE/EVIDENCE:/r16-evidence
    depends_on:
      fixture:
        condition: service_started
  fixture:
    image: node:24.21.0-bookworm-slim
    command: [node, /r16-experiments/receiving-production/peer.mjs]
    volumes:
      - /ABSOLUTE/REPO/experiments:/r16-experiments:ro
    ports: ["127.0.0.1:31416:3443"]
```

TLS IMAP and SMTP listen on the shared loopback namespace. The TLS ingress forwards
to the actual web server. Internal diagnostics and Node inspectors have no
published port. Inspector configuration is benchmark-only. Database migrations,
application role, credential encryption, elected ownership, jobs and blob storage
are the ordinary deployment implementations. Defaults remain W=2, C=1, D=2.

Run each phase as a separate one-shot producer in that project:

```text
docker compose <env/project/base/override arguments> run --rm --no-deps -e NODE_OPTIONS= --entrypoint node app /r16-experiments/receiving-production/smoke.mjs PHASE
```

Sequence: `setup`, `receive`, `reader`, `html-repeat`, `attachment`, `commands`, `outgoing`,
`diagnostics`, `dense`, `uncertain`; restart only `app`, then `restart`.
For shutdown during an active download: `pause-attachment`, restart only `app`,
then `retry-attachment`. This verifies visible graceful cancellation and an
explicit new user request. `resume-attachment` asserts original-intent restart
after abrupt process death. Finish with `quiet`. `ingress` checks verified TLS
health endpoints and unauthenticated API denial. `rediscover` is useful when updating
the image of an already running disposable fixture. `diagnose` is read-only
troubleshooting and is not an acceptance phase. Each producer has a bounded
absolute watchdog. Do not restart the peer between mutations: its remote state is
in memory, while local database state survives.

The peer seeds 1,024 metadata messages per account, a roughly 2.1 MiB HTML body,
a PNG CID resource and a 100 MiB attachment. Attachment literals are generated in
32 KiB slices and verified incrementally by SHA-256. No 100 MiB fixture buffer is
allocated. Sent MIME is bounded to 25 MiB by the peer. Lost STORE/MOVE/APPEND replies
are injected only after the corresponding synthetic mutation has occurred.

During a phase sample `docker stats --no-stream` for the actual `app` and `postgres`
containers. Execute `resources.mjs LABEL` with `compose exec -T -e NODE_OPTIONS=
app node ...` for actual web/worker memory, cumulative CPU, descriptors, PostgreSQL
activity and cache sizes. Sample repeatedly during dense sync, HTML processing,
attachment streaming and quiet idle. One-shot producer memory is excluded from
these app measurements. The HTML renderer called by the producer is also excluded;
the actual worker's receiving and sanitization costs are included. `trace.mjs` is
a bounded 30-second exception-location diagnostic; do not use traced runs as
performance evidence.

Keep JSON/log evidence outside version control and redact generated setup secrets
before displaying startup logs. On completion stop the explicitly disposable
Compose project with `down --remove-orphans`; preserve evidence before removing
its volumes. See the R16 results report for the actual run, corrections and limits.

## R16 final boundary and COMMIT-loss validation

Use another fresh disposable project. `html-newsletter` (UID 1) and `html-css`
(UID 101) follow `setup` and `receive`. `html-boundaries.mjs` defines only those
two accepted inputs, below the unchanged structural budgets. Each phase checks
ready publication, section preservation, inert markup, authoritative plain-text
search, an exact HTML-only search oracle using the built sanitizer, and the
authenticated web render route. The peer changes its body before the request;
the worker obtains current BODYSTRUCTURE as part of the ordinary content read.

For each phase, run `sample-boundary.mjs LABEL` with `compose exec -T -e
NODE_OPTIONS= app node /r16-experiments/receiving-production/sample-boundary.mjs
LABEL` in a separate shell. Wait for `LABEL-sampling-ready` in the evidence
directory, run the phase, then create `LABEL-sampling-stop`. The sampler has a
90-second bound. It records actual worker heap via inspector, RSS via `/proc`,
worker cumulative CPU differences, and app cgroup memory at 100-ms intervals.
It performs no HTML processing; one-shot producer resources are excluded, while
the sampler's small process is included in app cgroup measurements. Phase duration
also includes the producer oracle and web rendering, so it is not sanitizer-only
latency. `profile-html.mjs newsletter` is an optional isolated built-sanitizer
diagnostic; run it in a one-shot container, outside accepted worker measurements.

For COMMIT loss, replace the fixture command with
`completion-peer.mjs` and add these **test-only override** entries:

```yaml
services:
  fixture:
    extra_hosts: ["postgres:127.0.0.1"]
  postgres:
    networks:
      default:
        aliases: [database-target]
```

The app retains `network_mode: service:fixture`, inherits that hosts mapping,
and uses its normal production database URL. The relay runs in the existing
fixture service on loopback 5432, forwarding to `database-target:5432` with
TCP_NODELAY. Do not add `extra_hosts` to the app: Docker rejects that combination
with a shared network namespace. If restarting the fixture during setup, recreate
the app afterwards so it joins the new namespace. Do not restart the peer once
remote mutation evidence is being collected.

After the HTML phases, run `commit-loss.mjs` as a one-shot producer. It installs
a disposable deferred advisory barrier/audit for UID 2's ready publication,
observes its real backend executing COMMIT, and arms the relay for that exact
backend PID. The relay removes only its COMMIT CommandComplete and corresponding
ReadyForQuery frames. All other replies pass through. Independent database
visibility proves COMMIT; a held mailbox lock and `pg_blocking_pids` prove the
deployed worker's actual attempt recovery waits before proceeding. The producer
checks one ready publication, unchanged attempt, no repeated content literals,
and no STORE/MOVE/APPEND/SMTP. Then restart only `app` and run
`commit-loss-restart`: it requires a new live owner/generation, the original result,
one audit row, and unchanged literal/mutation counters. Run `ingress`, then stop
the disposable project. No relay, trigger, inspector or extra service is installed
in normal production configuration.
