# Disposable ImapFlow transport validation

Phase 1 only. This directory imports the installed `imapflow` dependency, never application composition, account settings, databases, credentials or production synchronization code. No additional dependencies were installed. Existing `tsx`, TypeScript and Node's test runner are used. Vitest's existing include pattern excludes this directory.

Run from the repository root in PowerShell:

```powershell
$env:IMAP_EXPERIMENT_REPEATS = '3'
node --import tsx --test --test-concurrency=1 experiments/imap-transport/transport.test.ts
node --import tsx experiments/imap-transport/summarize.ts
Remove-Item Env:IMAP_EXPERIMENT_REPEATS
```

The suite writes `measurements.json`; the summary command refreshes only the generated measurement section of the Phase 1 results report. A single diagnostic run:

```powershell
node --import tsx experiments/imap-transport/scenario.ts slow-fetch
```

Each scenario runs in a separate child process with a 12-second parent kill deadline and a 15-second Node test deadline. The 10-second trickle case intentionally takes about 10.5 seconds including process startup. Fixture barriers have 1.5-second deadlines. Cancellation calls `close()` on the real client and awaits operation settlement; process termination is emergency containment, never a successful cancellation result. All server timers are cleared and clients/sockets/server are closed. Normal cleanup waits for all peer close events before emergency server-side destruction.

The fixture listens on an ephemeral port on **127.0.0.1 only**. It uses TLS by default, synthetic PREAUTH, and a committed disposable self-signed certificate/key. Verification is disabled only for this loopback fixture. These files are public test material and must never be used for deployment. The key is not an account credential. To regenerate them (OpenSSL required only for regeneration):

```powershell
openssl req -config experiments/imap-transport/openssl.cnf -x509 -newkey rsa:2048 -nodes -keyout experiments/imap-transport/localhost-key.pem -out experiments/imap-transport/localhost-cert.pem -days 3650 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

`IMAP_EXPERIMENT_PLAINTEXT=1` selects diagnostic plaintext mode. This host's ESET inspection changed literal framing and partial requests and injected `addedByEsetSecurity` commands. The retained `initial-plaintext.json` and `plaintext-interference.json` are contaminated diagnostic evidence, not valid ImapFlow performance measurements. `fixture-debug-tls.json` retains a development run with an incorrect reselect barrier; its failure led to correcting the fixture namespace response, not changing ImapFlow. A TLS attempt made before the certificate existed failed setup; it supplied no transport evidence.

`PASS` in raw data means the observed behavior matched an assertion, including expected unsafe behavior. It does **not** mean an architectural safety requirement passed. Read the two reports for that assessment. Oversize/out-of-range/wrong-origin scenarios deliberately model nonconforming peers. Do not turn a returned empty FETCH array into successful metadata coverage.

Memory is sampled process memory, including the scripted server, every 2 ms. The actual instantaneous peak can be higher. Event-loop monitoring has 5 ms resolution. Bytes are decrypted IMAP payload seen by the client's native TLS socket; TLS record overhead is excluded. Network writes are summarized by size, not body contents. All content is synthetic.
