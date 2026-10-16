# R16 normal deployment smoke

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
