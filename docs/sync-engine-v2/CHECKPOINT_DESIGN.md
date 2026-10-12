# Checkpointy i trwałość postępu

Data: 2026-10-11. Status: **proponowana ścisła semantyka, bez kodu/DDL/test runs**.
Źródło produktowe: [kontrakt v0.10](PRODUCT_CONTRACT.md), IF-004/CR/RC/MI. Problem: [niezależny audyt M-05](INDEPENDENT_REVIEW.md). Kontekst: [selekcja](INITIAL_INBOX_DESIGN.md), [bootstrap/T1](BOOTSTRAP_AND_READY_DESIGN.md), [decyzje](DESIGN_DECISIONS_PENDING.md).

## 1. Jedna definicja

**Bezpieczny checkpoint jest trwałym certyfikatem kompletnego rozliczenia obowiązków projekcji w jawnie określonym scope, epoce i zakresie zmian providera.** Przesunięcie z C do C' jest dopuszczalne wyłącznie, jeżeli discovery objętego zakresu jest zakończone, a każda wymagana zmiana ma terminalny, trwale opublikowany wynik: aktualny remote state (ewentualnie nowszy state, który ją subsumuje), wiarygodnie potwierdzona absence/membership removal lub udowodniony brak wpływu na określoną projekcję. Nie zostaje pending/unknown required effect. Dowód i update C' są atomowe i fenced.

Unresolved work z replay guarantee jest **postępem intake**, nigdy bezpiecznym checkpointem applied. Enqueue, queue ACK, otrzymana strona, staging IDs, w pamięci „done”, HIGHESTMODSEQ z SELECT czy MAX(local UID) nie są dowodem applied changes. Nie obiecujemy exactly-once zdalnego execution; zapewniamy idempotent lokalny effect i at-least-once repair/replay.

Ta definicja obejmuje Gmail i IMAP bez udawania identycznego cursor type. Główne applied scope nie może być zawężane w trakcie run tylko po to, by ominąć failing items. Checkpoint history changes **nie** oznacza ukończonego importu historycznej populacji niezmienionych wiadomości. Zakres i obowiązki są zamrożone przed finalizacją. [IF-004, CR-001–006, RC-001/007](PRODUCT_CONTRACT.md).

### Rekomendowana korekta CR-001 i IF-004 (bez edycji kontraktu)

CR-001 dziś dopuszcza unresolved work z replay guarantee, IF-004 dopuszcza tylko durably applied. To nie dwa opisy tej samej rzeczy. Proponowany tekst do przyszłego zatwierdzenia:

> CR-001 — Advance the authoritative provider change checkpoint only after discovery of its covered range is complete and every required projection effect in the declared scope is durably resolved. A confirmed current or superseding remote state, confirmed absence or membership removal, or a proven no-effect outcome may resolve an item. Unresolved work, fetch cursors and staged receipts are separate progress markers and never authorize advancing this checkpoint.

> IF-004 — Current synchronization uses the applied checkpoint defined by CR-001. Retries, overlapping work and stale responses must not resurrect removed mail, overwrite newer confirmed state or accepted pending intent, or duplicate logical identities. Intake progress and historical coverage are reported separately.

Wybieramy ostrzejszy wariant już zgodny z IF-004 i preferencją CR-001; korekta usuwa sprzeczną alternatywę, nie nadaje stagingowi statusu applied. Nie wymaga odrębnej decyzji produktowej o tym, czy ACK=success — kontrakt już tego zabrania. [Gmail v1 final pending check](../../src/modules/mail/application/gmail-sync-service.ts), `history()`; [repository completion](../../src/modules/mail/infrastructure/gmail-sync-repository.ts), `completeItems()`.

## 2. Trzy niezależne wskaźniki

| Wskaźnik | Co potwierdza | Czego nie potwierdza |
| --- | --- | --- |
| Provider applied checkpoint | kompletne terminalne effects w declared provider scope/range/epoch | pełna historia, latest now, queue success, końcowa post-T1 freshness |
| Intake/selection/reconciliation cursor + receipts | które query/range/page/fragment odkryto i zachowano; które bounded porcje completed | brak gaps w całym stream, remote success, bezpieczne C' |
| History frontier/coverage | które części historycznej populacji zostały rozpoznane i materializowane lub terminalnie rozliczone | stan current flags/removals ani account history applied watermark |

**Gmail:** account-wide C jest decimal historyId, intake ma `(start,target,pageToken,fragment offset/digest,receipts)`; history frontier jest inventory query/bucket/page/generation, nie historyId. Jedna wiadomość = `(account,native id)`, wiele label placements. C nie jest timestampem ani sekwencją ciągłych numerów. [schema messages/placements/gmail state/work](../../src/shared/infrastructure/database/schema.ts), [ADR 0013/0014](../adr/0014-gmail-account-history-and-progressive-sync.md), [Gmail history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

**IMAP:** nie istnieje portable account-wide scalar C. Certyfikat ma mailbox/UIDVALIDITY, complete arrival coverage U i **osobne** flag/presence proof dla known projected UID domain. Przy kwalifikowanym CONDSTORE/QRESYNC może mieć applied M dla tego scope; bez tych capabilities nie ma durable remote delta cursor flag/expunge. Finite sweep run/certificate jest lokalnym dowodem obserwacji, nie rzekomym provider event watermark. `arrival U=1000` nie potwierdza flag/deletions UID 1–999. `history frontier=500` nie potwierdza arrivals >500. [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051), [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162), [ImapSliceSyncService write/completed](../../src/modules/mail/application/imap-slice-sync-service.ts).

### Gmail: co oznacza „wszystkie objęte zmiany”, gdy historia jest niepełna

Głównego account checkpointu nie przesuwamy po samym INBOX-filtered replay. Dla każdego history ID/record do targetu klasyfikujemy effects na **całym koncie**:

- Znany message: reconcile aktualne flags, native memberships/absence, pending-intent overlay oraz potrzebne metadata; nie zostawiamy unresolved membership w innym label tylko dlatego, że INBOX jest ready.
- Nowa bieżąca wiadomość / aktualne INBOX addition: materializuj current metadata, flags i memberships; stara internalDate nie czyni jej history-only, jeśli została teraz dostarczona/przeniesiona do INBOX.
- Unknown identity: nie zakładaj no-effect na podstawie braku lokalnego wiersza. Typed event może dowieść permanent deletion nieznanego ID; w pozostałych przypadkach GET/current labels lub wystarczający protocol evidence ustala relevance. Dawne INBOX labelRemoved i obecna state różnią się od deletion.
- Nieznana **niebieżąca** wiadomość poza current/selected/materialized scope: po ustaleniu braku required projection effect można zapisać terminal no-effect z powodem i klasyfikacją history eligibility. Późniejszy import metadata to history frontier, nie pending **covered current effect**. Jeżeli full current materialization tego eventu jest wymagane, nie wolno nazwać go no-effect. Zmiana nazwy pending na deferred nie zwalnia z checkpointu.

History eligibility musi obejmować skipped/deferred population niezależnie od opróżnienia receipts (pełna inventory wszystkich dat/label, nie tylko `before:C`). Brak local effect jest dopuszczalny wyłącznie po udowodnionej klasyfikacji, nie przez enqueue do history job. To nie shadow projection całego konta. READY nie czeka na metadata niezmienionych starych messages, bo te nie należą do obowiązków `(C,T1]`. Zachowanie ma kwalifikować fixture unknown IDs/local memberships oraz live imports. [Kontrakt IS-006, RA-08](PRODUCT_CONTRACT.md), [Gmail classify/history service](../../src/modules/mail/application/gmail-sync-service.ts).

## 3. Minimalne persistence i authority

Rekomendujemy zachować PostgreSQL + pg-boss, współdzielone messages/placements/content/commands/publications. Jedno miejsce durable eligibility; queue dostarcza wake i retry delivery, nie prawdę o postępie. Nie kopiujemy prywatnego SQL interception pg-boss ani progów burst8/60 jako definicji poprawności. [ADR 0004](../adr/0004-postgresql-background-jobs-with-pg-boss.md), [sync-admission.ts](../../src/modules/mail/infrastructure/sync-admission.ts), [gmail-sync-jobs poll/enqueue](../../src/modules/mail/infrastructure/gmail-sync-jobs.ts).

Logiczny model zawiera jeden rekord scope progress z revision/run/epoch, fixed target i due/error oraz bounded receipt set. Gmail stage potrzebuje durable IDs/range/version/fragment; IMAP może zapisać bounded group w payload plus interval cursor, zamiast osobnej tabeli na każdy FETCH. Nazwy/layout są propozycją, nie zmieniamy obecnych constraints. [Bootstrap state rationale](BOOTSTRAP_AND_READY_DESIGN.md#1-milestones-i-minimalny-model).

### Lock wybrany do oceny

Preferowany prosty wariant: **jedna sesyjna advisory authority na bounded execution slice**, scoped Gmail account lub IMAP mailbox, współdzielona przez sync i kolidujące commands. Remote read/mutation i jego publication używają tego samego authority lifetime; nie lock na cały inventory/READY run. Acquire przed provider read, publication przez dokładnie tę zarezerwowaną DB sesję, w każdej transakcji sprawdzenie pierwotnego PID i exact held key. Reconnect/unlock/session loss unieważnia buffered response; ponowne acquire wymaga nowego remote observation, nie publikacji starej odpowiedzi. Row locks/revision checks dodatkowo chronią account disable/reconnect.

Session-level locks automatycznie znikają po zakończeniu sesji i nie są rollbackowane jak dane; ich lifetime różni się od xact lock. Dlatego transaction lock do finalizacji/row locking **nie** zastępuje authority spanning read+write. [PostgreSQL advisory locks §13.3.5](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS). Nie trzymamy otwartej DB **transakcji** podczas sieci; sesję możemy trzymać podczas pojedynczej bounded operacji i uwzględniamy ją w connection budget.

To świadomy reuse [gmail-account-lock](../../src/modules/mail/infrastructure/gmail-account-lock.ts), który sprawdza PID/exact lock i daje DB na tej sesji. Obecny [mailbox-lock](../../src/modules/mail/infrastructure/mailbox-lock.ts) trzyma reserved connection, ale callback zapisuje przez inny pool; sam account revision nie fence'uje utraty tej sesji. Nie deklarujemy tej ścieżki jako bezpiecznej v2. [Testy Gmail authority/pool1](../../tests/gmail-provider.integration.test.ts), przypadki „authority leaves pool-one…” / „verifies the exact advisory lock…”, są wzorcem fault seams, nie dowodem całej IMAP composition.

Nie dodajemy lease table/heartbeat authority, jeśli session approach spełni latency/connection qualification. Alternatywa short row-lock + monotonic execution fencing token pozwala oddać sesję w remote wait, ale wymaga osobnego owner lease/expiry, odpowiedniej synchronizacji commands i tokenów na każdej publikacji; bez dowodu konieczności jest bardziej złożona. Network/quota retry i credentials refresh wykonuj poza authority, potem acquire i revalidate revision/run. Remote timeout musi kończyć slice; nie śpimy z authority podczas backoff. Individual actions czekają najwyżej na bounded operację/przydział, nie cały run.

### Konkurujący workers i locks order

W2 przy held scope lock W1 nie robi provider calls dla tego scope; zapisuje/coalesces due i wraca bez success reconciliation. W1 po loss session nie może publish na innym connection nawet przy unchanged accountRevision. Nowy W2 odczytuje safe progress i robi świeżą obserwację. ACK starego joba nie odbiera W2 durable work.

Każda publication transaction: account row shared lock/revision/transport/enabled check → scope state row FOR UPDATE/CAS run+epoch+expected cursor → message/placement/command rows w stałym porządku → mutation/progress. Account config update exclusive nie może przejść pomiędzy validate i commit. Ustalić rzeczywisty lock order z command/content services podczas implementacji; brak nested pool checkout na reserved authority. [receive-publication-fence](../../src/modules/mail/infrastructure/receive-publication-fence.ts), [Gmail publication/projector](../../src/modules/mail/infrastructure/gmail-projector.ts).

## 4. Granice transakcji

| Operacja | Co musi commitować razem | Dlaczego |
| --- | --- | --- |
| T0 / new run | baseline, W0/C, policy version, generation, due | crash nie uruchamia innej selekcji z połową referencji |
| Page intake | wszystkie IDs/required event versions danego fragmentu + cursor/digest/offset | token nie może pominąć nieutrwalonej końcówki |
| Bounded projection | metadata, flags, memberships/retirement, attachment handles, coherent publication + terminal receipt | complete nie wyprzedza user-visible state; zachowane command overlay |
| History frontier step | efekty history batch + completed range/frontier | restart nie pomija nieutrwalonej historii |
| Applied checkpoint | locked proof: discoveryComplete i zero unresolved w covered scope + C CAS + zamknięcie run/receipt GC + continuous due | atomic no-gap advancement, nie tylko sprawdzenie przed transakcją |
| READY | wszystkie milestone predicates + immutable certificate/T1 reference + readyAt + continuous due | crash nie daje READY bez handoff |
| User intent acceptance | intent sequence/desired state + optimistic projection / durable due | enqueue może się nie udać bez zgubienia accepted command |

Queue enqueue/ACK poza tymi transakcjami jest bezpieczne, gdy periodic repair opiera się na durable due i receipts. Transactional enqueue pg-boss jest opcjonalne, nie dodatkowa warstwa correctness. No polling web/browser prerequisite; lifecycle security/MFA readiness pozostaje zachowane. [gmail-sync-jobs](../../src/modules/mail/infrastructure/gmail-sync-jobs.ts), [message-command jobs](../../src/modules/mail/infrastructure/message-command-jobs.ts), [worker lifecycle](../../src/composition/worker-process.ts).

Dopuszczamy data commit przed **osobnym** cursor/checkpoint commit, jeśli replay jest guarded/idempotent i cursor nie może advance bez ponownego sprawdzenia dowodu. To crash-safe, ale może powtórzyć bounded work. Preferujemy atomic effect+receipt/frontier dla nowych ścieżek. Istniejący IMAP `sink.messages` i późniejsze `write()` są odrębnymi transakcjami; nie twierdzimy, że dziś data+cursor wszędzie atomic. [IMAP testy 288–315, 380–416](../../tests/imap-resumable-sync.integration.test.ts), [service persistBatch/write](../../src/modules/mail/application/imap-slice-sync-service.ts).

Receipt GC nie może zgubić unresolved IDs nawet po wygaśnięciu provider tokenu. Terminal receipts można usunąć dopiero gdy committed coverage/cursor+projection pozwala bezpiecznie replay; dla unresolved dedup potrzebne są zakres/run/native locator i required version. Nie przechowujemy nieograniczonego event log: page staging ma high-water/backpressure i bounded fragments; jeśli intake nie ma miejsca, token pozostaje do ponowienia. Raw payload dużego history record może być digestowany i re-read; changed digest wymaga replay od safe start, nigdy ślepe offset advance. [GmailSyncRepository stagePage](../../src/modules/mail/infrastructure/gmail-sync-repository.ts).

## 5. Idempotencja, wersje i optimistic intents

| Element | Reguła |
| --- | --- |
| Gmail canonical | unique `(account,native id)` → ten sam local UUID podczas replay i native recovery |
| Gmail membership | desired full current label set; label loss != message deletion; unique membership |
| IMAP replay | locator `(account,mailbox,UIDVALIDITY,UID)`; sequence number/Message-ID/subject/date nie identity |
| Current flags | niższy Gmail historyId/IMAP MODSEQ nie nadpisuje wyższego confirmed observation; equal replay idempotent |
| Bez wersji IMAP / negatywny GET | serialized current observation+publication; replay staging to ponowne odczytanie stanu, nie stosowanie starych snapshot bytes |
| Retirement/tombstone | obsolete run albo response sprzed nowszej projekcji odrzucony; absence nie pobudza resurrection przez stary positive response |
| Local intent | remote confirmed state oddzielne od overlay; older observation/confirmation nie czyści nowszego accepted intent |
| Notification / UI revision | existing unique event keys i atomic coherent publication; replay nie emituje drugiego arrival notification |

Gmail required event version receipt jest osobna od remote historyId zwróconego GET. GET może mieć version >target: nie wolno ustawić całego account checkpointu na tę wersję, bo nie wiadomo, co zmieniło się na innych IDs. Tombstone bez remote version nie dostaje zmyślonego historyId; opiera się na typed deletion evidence albo serialized exact absence read z run/required range. Zapis typu „last response wins” na podstawie wall-clock nie spełnia RC-003.

Obecne [gmail-projector](../../src/modules/mail/infrastructure/gmail-projector.ts) ma native upsert, providerHistory stale guard, pending commands overlay i remoteMissingAt; [MessageService.persistBatch](../../src/modules/mail/application/message-service.ts) ma placement lookup i MODSEQ guard. Są to dowody poszczególnych seams, **nie** dowód że wszystkie missing/overlap races już rozwiązano.

Read → unread acceptance jest zatwierdzone RC-009; nie pytamy ponownie o tę politykę. Kod [MessageCommandService](../../src/modules/mail/application/message-command-service.ts) i [GmailMessageCommandService](../../src/modules/mail/application/gmail-message-commands.ts) odrzuca drugą pending akcję; przyszła konkretna adaptacja sequence/coalescing/confirmation będzie konieczna poza samym receive orchestration. Ten projekt jej nie implementuje. Remote mutation ACK nie jest provider change checkpoint. Niepewny MOVE nie może być blind retried; observe destination/source mapping, a uncertainty pozostaje visible.

## 6. Macierz awarii i recovery

| Punkt awarii / sytuacja | Co jest prawdą po restarcie | Bezpieczna kontynuacja |
| --- | --- | --- |
| Przed zapisem data/stage | nic nie jest complete; C/frontier stare | ponów remote read albo fragment, dedup |
| Po staging przed materializacją | intake zachowane, C stare, pending trwałe | drain/GET current IDs; żaden false applied timestamp |
| Po data przed receipt/cursor | data może istnieć, progress stare | guarded replay bounded group; nie bierze MAX(local UID) jako cursor |
| Po effect+receipt przed checkpoint | completed effects prawdziwe, C stare | discovery/replay lub final proof check, bez rematerializacji bodies |
| Po C commit przed ACK | C i effects committed | duplicate job rereads state/no-op; repair current due; nie cofa C |
| Niepewny DB COMMIT reply | nie wiadomo lokalnie czy commit zaszedł | odczytaj persisted run/receipts/C, nie wnioskuj z wyjątku i nie force advance |
| Dwa workers | tylko holder current authority publikował | loser no success; duplicate delivery coalesced |
| Utrata lock session | held authority nieważne, remote outcome może być znany/unknown | discard buffered projection, reacquire nowy slice i remote reobserve; remote action uncertainty osobno |
| Disable/reconnect revision | stare run responses obsolete | row-lock revision guard odrzuca, durable intents adopt/reobserve zgodnie z command semantics |
| Masowe removals + crash | completed chunks/cursor zachowane, reszta pending | bounded resume, positive exact observations/typed removals, foreground przy każdym admission |
| Partial inventory / network | brak dowodu absence | nie masowe tombstoning; exact IDs/current rechecks |
| Outage/quota | C nie udaje success; retry deadline persistent | zwolnij zasoby, pokaż stale/backoff, zdrowe konta eligible |

### Gmail historyId expiration

History404 unieważnia możliwość replay danego zakresu; exact message404 oznacza coś innego. Zatrzymaj main applied checkpoint advancement i oznacz repair generation. Zachowaj valid UUID/cache/blobs/commands oraz unresolved receipts/IDs; staging ID pozwala current GET po expiration, ale nie rekonstruuje utraconego pełnego event stream. Nie twierdzimy, że stare history effects są wszystkie applied tylko dlatego, że IDs przeżyły.

Capture nowy B **przed** repair inventory. Foreground current detection może od razu poll history od B i materializować arrivals między bounded repair slices, utrwalając suffix receipts. Main checkpoint pozostaje invalid/stary aż recovery potwierdzi znane projections, required identities i spójny nowy baseline + finite suffix. Unseen known IDs w pełnej inventory wymagają exact GET przed retirement. Paginated list exhaustion nie jest atomic snapshot; stara znana projection nie znika od nieobecności na jednej stronie. Nieznana historyczna populacja jest dalej history-eligible, nie obietnica exact global coverage z B.

Finalization nowego baseline to **rebase po authoritative state reconciliation**, nie zwykły advance ponad nierozliczoną utraconą historią. UI health degraded do recoveryComplete, completed bootstrap milestone osobno. Jeżeli nowy B wygasa zanim suffix/inventory można rozliczyć, ponawiamy controlled repair; nie ma unconditional recovery time guarantee. Cel do przyszłej walidacji: poprawność current known state i skuteczny fresh path mimo 15k repair items, bez resetu DB. [Gmail integration expiry/pending under revision](../../tests/gmail-provider.integration.test.ts), [GmailSyncService bootstrap/inventory](../../src/modules/mail/application/gmail-sync-service.ts), [history.list expiry semantics](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

### IMAP UIDVALIDITY reset / capability loss

Zmiana E unieważnia old UID lookup, arrival coverage, MODSEQ i history frontier tego mailboxa. Nowa generation z nowym T0; stare placements oznaczone nieważnymi/reconciled w bounded operacjach, nie używane do nowych mutations/content GET. Cached message/content/blob/pins nie są kasowane od resetu. Foreground new epoch discovery ma execution opportunity przed pełnym old-placement cleanup; transaction nie usuwa 15k rows naraz.

Mapping starego local UUID do nowego UID wymaga dowodu, np. kwalifikowanego OBJECTID EMAILID lub znanego MOVE/COPYUID map. Nie gwarantujemy stable UUID przez external MOVE/reset na każdym IMAP; RFC Message-ID nie wystarcza. Bez proof zachowujemy lokalne cached references jako takie, nowy locator może dostać nową identity, a nie heuristic merge. [RFC 8474](https://www.rfc-editor.org/rfc/rfc8474), [RFC 6851](https://www.rfc-editor.org/rfc/rfc6851), [kontrakt RC-008](PRODUCT_CONTRACT.md).

Obecny IMAP reset usuwa placements i resetuje progress w jednej transakcji; to obserwacja v1, nie rekomendacja bounded v2 cleanup. [ImapSliceSyncService selected/reset](../../src/modules/mail/application/imap-slice-sync-service.ts), [test reset](../../tests/imap-resumable-sync.integration.test.ts). Przy NOMODSEQ/utracie QRESYNC nie zachowujemy unsupported applied M; przechodzimy do scoped current-state sweep z [P-03](DESIGN_DECISIONS_PENDING.md), nie fabrykujemy history cursor.

## 7. Dowody schematu i walidacja projektu

Przeczytano istniejący [schema.ts](../../src/shared/infrastructure/database/schema.ts): mailboxes recent/backfill/delta i JSON progress; messages Gmail partial unique/native IDs/providerHistoryId; mailbox_messages transport/epoch/identity uniqueness; message_commands sequence/status; gmail_account_sync_state i gmail_sync_work run/token/fragment/status constraints. [0037](../../db/migrations/0037_gmail_provider_operations.sql), [0040](../../db/migrations/0040_imap_resumable_slices.sql), [0042](../../db/migrations/0042_mail_publication.sql) potwierdzają operacyjne tabele/progress i commit publication. Nie zmieniono żadnego z nich; nie proponujemy literalnego dopisania pól do legacy DDL bez późniejszego schema review.

Istniejące [IMAP fixture integration](../../tests/imap-resumable-sync.integration.test.ts) oraz [Gmail synthetic HTTP/DB integration](../../tests/gmail-provider.integration.test.ts) obejmują replay, failed staging/checkpoint, expiry, revision, quota, fragment501, advisory authority. Nie zostały uruchomione w tym zadaniu; nie dowodzą live sort/paging/reservation/latency. Przyszłe fault validation P-05 musi objąć każdy wiersz crash matrix, exact session loss z obsolete response, unknown no-effect classification, optimistic intents i stale tombstone resurrection, oraz jedno konto/ten sam INBOX przy masowych usunięciach.

Projekt nie tworzy lease brokerów, event busa, shadow state ani job per message. Ograniczone receipts i jeden scope authority chronią konkretne crash/race gaps; pełny scheduler/resources/DDL to późniejszy projekt. Fresh-only MI usuwa v1 migration scope, ale nie zwalnia z non-destructive recovery już zainicjalizowanej v2 instalacji.
