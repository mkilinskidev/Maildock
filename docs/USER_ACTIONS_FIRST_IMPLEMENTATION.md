# Sync Engine v1: User-actions-first i Interactive Priority (etap 2)

Data: 2026-10-17. Gałąź: `codex/v1-user-actions-first`, utworzona z
`codex/v1-inbox-first` (`7f28d93`). Raporty audytu i poprzednich etapów nie
były modyfikowane. Bez nowego schedulera, nowej kolejki, migracji, zmiany
policy pg-boss i bez preemption aktywnych jobów.

Hierarchia: 1. akcje użytkownika, 2. interactive fetching, 3. INBOX fresh, 4. inne fresh, 5. backfill INBOX, 6. pozostały backfill. To polityka
pierwszeństwa przy konflikcie o zasoby, a nie sekwencyjność globalna: konta są
niezależne.

## 1. Stan wyjściowy (problemy)

1. Komenda, która przegrała `pg_try_advisory_lock` z recent/delta/backfill,
   rzucała `MailboxBusyError`, co dla pg-boss było błędem: retry po 15 s z
   backoffem, zużycie `retryLimit: 4`, po czwartej kolizji job `failed`
   (komenda zostawała `pending` do pollera, 30 s).
2. Synchronizacja nie widziała komend: recent/delta/backfill startowały i brały
   lock mimo gotowej komendy tego mailboxa.
3. Poller komend co 30 s wysyłał nowy job dla każdej `pending`/`executing`
   komendy bez sprawdzania, czy żyje już job. Kolejka komend ma policy
   `standard`, a w pg-boss `singletonKey` bez `singletonSeconds` nie daje
   żadnej wyłączności; duplikaty były więc realne.
4. Content: brak naprawy osieroconych `pending`/`fetching` (request zwraca
   `false` dla tych stanów, więc użytkownik widział „Preparing" bez końca po
   utracie joba). Jeden wolny body fetch blokował wszystkie inne (concurrency 1).
5. Załączniki: `repair()` co 30 s wysyłał kolejny job dla każdego
   `pending`/`fetching`; duży załącznik mnożył joby (nieszkodliwe dla danych,
   chroni je lock per załącznik, ale zajmowały sloty).

## 2. Zmienione moduły

| Moduł                                           | Zmiana                                                                                                                                                                                  | Uzasadnienie                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `application/inbox-first-policy.ts`             | Stałe `COMMAND_WAITING_STALE_SECONDS` (600), `COMMAND_BUSY_BASE/MAX_SECONDS` (2/6), czysta `commandBusyDelaySeconds` (opóźnienie rosnące, ograniczone, jitter 0-1 s, całkowite sekundy) | Jedno miejsce na progi; funkcja testowalna z fałszywym `random`                               |
| `infrastructure/deduplicated-enqueue.ts` (nowy) | `enqueueDeduplicated`: producer advisory lock per element pracy + `findJobs` po `data` + insert w jednej transakcji                                                                     | Wspólna reguła dla API, pollera, kontynuacji i repair; nie zakłada wyłączności `singletonKey` |
| `infrastructure/message-command-jobs.ts`        | `enqueueMessageCommand` korzysta z helpera (tryby `request`/`continue`); handler łapie `MailboxBusyError` sprzed `run`; poller używa tej samej ścieżki                                  | Pkt 3.B i 3.D zadania                                                                         |
| `infrastructure/sync-admission.ts`              | Pierwsze zapytanie bramki: gotowa komenda tego mailboxa → `true` dla każdego rodzaju i tieru (także INBOX fresh)                                                                        | Pkt 3.C; recent/delta/backfill już wołają bramkę przed lockiem i pod lockiem                  |
| `infrastructure/content-jobs.ts`                | `CONTENT_WORKER_CONCURRENCY = 2`; `enqueueContentRepair`; `ContentRepairPoller` (30 s)                                                                                                  | Pkt 4: repair i brak blokady przez jeden wolny fetch                                          |
| `application/message-content-service.ts`        | `orphanedRequests()`: `pending`/`fetching` starsze niż 30 s z użytecznym placementem, tylko aktywne konto i mailbox                                                                     | Kandydaci do repair; sam job-dedup robi helper                                                |
| `infrastructure/attachment-jobs.ts`             | `enqueueAttachment` przez helper (okno żywego aktywnego joba 300 s)                                                                                                                     | Repair co 30 s nie mnoży jobów dużego załącznika                                              |
| `composition/worker.ts`, `worker-process.ts`    | `contentPoller` (start/stop razem z innymi pollerami); owijka `enqueue` komend zwraca `void`                                                                                            | Wiring                                                                                        |

Bez zmian: `MessageCommandService` (lifecycle, MOVE, rollback), `mailbox-lock.ts`,
`CommandService.create` (202, durable command, optimistic UI), policy kolejek
pg-boss, concurrency attachment (2), HTML sandbox, sanitizacja, polityka
remote images, walidacja i limity załączników.

## 3. Lifecycle komendy

1. `create` w transakcji: wiersz `message_commands` (`pending`, `attempts 0`),
   optymistyczna projekcja flag/`actionHidden`. Zwrot `202`.
2. `enqueue` (best effort po commicie) → `enqueueMessageCommand(mode "request")`.
   Błąd enqueue jest połykany: komendę naprawia poller (≤ 30 s).
3. Worker (concurrency 4): `mailboxId(commandId)` → `withLock` → `run`.
   - Lock zajęty → `MailboxBusyError` **przed** `run` (flaga `started`) →
     patrz §5. Stan komendy pozostaje `pending`, `attempts` bez zmian.
   - Lock wzięty → `run`: walidacje, `pending → executing` (`attempts + 1`),
     `mutateMessage`, `succeeded`/`failed`, rollback optymistycznej projekcji
     przy pewnym błędzie, reconcile delta.
4. Błąd operacji (po starcie `run`) → zwykły retry pg-boss (kolejka:
   `retryLimit 4`, 15 s z backoffem), jak dotychczas.
5. Poller (30 s): `pendingIds()` (`pending` i `executing`) → ta sama ścieżka
   `request`.

Stany **runnable** dla bramki synchronizacji: wyłącznie `status = 'pending'`
utworzone w ciągu 10 min. `executing` albo trzyma lock (lock go chroni), albo
czeka w ograniczonym retry pg-boss po błędzie (zamierzone: synchronizacja nie
jest wtedy wstrzymywana, a liczba retry jest skończona). `succeeded`/`failed`
nie wstrzymują niczego. Komenda `pending` starsza niż 10 min (sierota bez
żywego joba) przestaje wstrzymywać synchronizację, a poller nadal próbuje ją
wykonać.

## 4. Pierwszeństwo komend nad synchronizacją

`higherPriorityWorkWaiting(boss, accountId, mailboxId, kind)` sprawdza najpierw
komendy **tego mailboxa** (ten sam klucz co mailbox lock), a dopiero potem
dotychczasowe reguły INBOX-first. Wynik `true` znaczy: zapisz trwałego
następcę (fresh 5 s, backfill 10 s) i zakończ bez lockowania.

- Dotyczy recent, delta (w tym IDLE, manual, poll) i backfill, **również
  INBOX**: INBOX-first nie ma pierwszeństwa przed akcją użytkownika.
- Sprawdzenie działa przed lockiem i ponownie pod lockiem, więc synchronizacja,
  która już wzięła lock, a w międzyczasie zobaczyła komendę, zwalnia go przed
  rozpoczęciem pracy.
- Backfill nie wchodzi w nowy zakres UID, gdy komenda czeka (kontrola na
  starcie joba i kontynuacji).
- Komenda innego mailboxa tego samego konta i komenda innego konta nie
  wstrzymują niczego. Brak nowej kolejki, tabeli i locka.
- Komenda, której lock trzyma aktywna synchronizacja, nie wymusza niczego:
  lock pozostaje nietknięty (patrz §8).

Pozostałe gwarancje INBOX-first bez zmian: priorytety 20/10/-5/-10, zarezerwowany
slot delta INBOX, bramka międzykolejkowa, initial INBOX gate (60 s), szybki
repair INBOX (30 s), newest-UID-first, first-visible polling.

## 5. Semantyka busy, retry i deduplikacji

**Busy** (lock zajęty, `run` nie wystartował):

- `createMailboxLock` zwalnia zarezerwowaną sesję PostgreSQL w `finally` zanim
  handler zapisze następcę. Handler nie czeka na lock (`pg_try_advisory_lock`),
  więc nie zajmuje slotu workera ani sesji bazy.
- Handler zapisuje jednego następcę tej samej komendy: `startAfter` =
  `commandBusyDelaySeconds(deferrals)` (2 s, rosnąco do 6 s, + jitter 0-1 s;
  licznik `deferrals` w payloadzie), po czym kończy własny job jako
  `completed`. Nie jest to retry pg-boss: `retryCount` i `retryLimit` nietknięte,
  `attempts` komendy nietknięte, brak backoffu 15 s.
- Błąd `MailboxBusyError` rzucony **po** starcie `run` (flaga `started`) nie
  jest traktowany jak busy i idzie zwykłą ścieżką błędu.
- Błąd zapisu następcy → job rzuca → zwykły retry pg-boss (komenda nie ginie);
  dodatkowo poller naprawia trwały `pending`.

**Deduplikacja** (`enqueueDeduplicated`, producer advisory lock
`maildock-enqueue:<kolejka>:<klucz>` w transakcji z `findJobs` po `data`):

- tryb `request` (API, poller): `created`/`retry` zawsze blokują wysyłkę;
  `active` blokuje, gdy `started_on` jest młodsze niż 120 s;
- tryb `continue` (następca własnego aktywnego joba): liczy się wyłącznie
  `created`/`retry`, więc istnieje najwyżej jeden następca;
- aktywny job starszy niż okno to sierota po awarii workera (pg-boss wygasi ją
  dopiero po 15 min): poller może ją zastąpić. Duplikat jest bezpieczny, bo
  wykonawca ponownie czyta trwały stan pod lockiem (`succeeded`/`failed` →
  powrót; `executing` MOVE → brak ponowienia, patrz §6).
- Policy kolejki pozostaje `standard`; nie zmieniono jej.
- Joby wysłane przed wdrożeniem (bez `singletonKey`) są znajdowane po `data`.

## 6. Niepewny MOVE

`MessageCommandService.run` nie został zmieniony:

- `executing` + MOVE przy ponownym uruchomieniu → `failed` z komunikatem o
  niepewnym wyniku i reconcile, bez drugiego `mutateMessage` (istniejący test
  `fails an uncertain MOVE replay without repeating it`).
- Błąd po rozpoczęciu mutacji MOVE → `failed` + reconcile, bez automatycznego
  ponowienia; pewny błąd (`source_missing`, `conflict`, zmiana UIDVALIDITY) →
  rollback projekcji.
- Busy kończy się przed `run`, więc nie dotyka stanu `executing`. Duplikat joba
  (sierota) trafia na lock; po zwolnieniu widzi stan terminalny albo
  `executing` i dla MOVE nie powtarza operacji.
- Nowy test (12): przy błędzie reconcile po jednoznacznym ack komenda zostaje
  `succeeded`, flaga `\Seen` zachowana, replay nie wywołuje drugiej mutacji.
- Nowy test (15): dwie równoległe komendy tego samego mailboxa przez prawdziwy
  lock nie nakładają się; przegrany dostaje `MailboxBusyError` przed `run`
  (`pending`, `attempts 0`) i po ponowieniu kończy się raz.

## 7. Interactive fetching: wdrożone poprawki

| Punkt zadania                              | Decyzja                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Repair osieroconego content             | **Wdrożone.** `ContentRepairPoller` co 30 s: kandydaci z `orphanedRequests` (starsze niż 30 s; request zapisuje `pending` tuż przed `schedule`), wysyłka tylko bez żywego joba (aktywny liczy się przez 300 s). Stany `ready`/`failed` i konta wyłączone nie są ruszane.                         |
| 2. Zbędny re-render/odczyt gotowych CID    | **Nie wdrożone.** Każdy poll ponownie czyta gotowe bajty i koduje base64. Poprawa wymaga cache wyniku walidowanego zasobu (bezpieczeństwo: format, typ, powiązanie `messageId`/`contentId`) albo zmiany kontraktu `detail`. Bez pomiaru nie uzasadnia dotykania ścieżki sanitizacji. Opis w §10. |
| 3. Content concurrency 1 → 2               | **Wdrożone.** Test izolowany (16): przy 1 slocie `fast` nie kończy się, dopóki `slow` trwa; przy 2 kończy się natychmiast. Koszt: jedna dodatkowa sesja IMAP (content nie bierze mailbox locka). Brak pomiaru na prawdziwym serwerze.                                                            |
| 4. Natychmiastowy HTML bez czekania na CID | **Już spełnione**, dodano test UI: `iframe` z HTML jest widoczny, gdy `pending: true`.                                                                                                                                                                                                           |
| 5. Anulowanie pollingu po zmianie          | **Już spełnione** (`cancelled`, `AbortController`, `clearTimeout` w cleanupie efektu), dodano test UI (21): po zmianie wiadomości poprzednie żądania są przerwane, a licznik wywołań starej nie rośnie.                                                                                          |
| Załączniki                                 | `enqueueAttachment` przez helper: request i repair nie mnożą jobów. Concurrency 2 bez zmian. Walidacja i limity bez zmian.                                                                                                                                                                       |

Nie zmieniono: sandbox iframe, sanitizacji, polityki remote images, cache,
walidacji i limitów rozmiaru. Brak globalnego poolingu IMAP.

## 8. Jawne ograniczenia (aktywne recent/delta/backfill)

Ten etap **nie** przerywa aktywnej pracy. Jeżeli synchronizacja już trzyma
mailbox lock, komenda nie wykona się, dopóki ta praca nie zwolni locka:

- Aktywny backfill: do końca bieżącej porcji (≈27 s w zaobserwowanym runtime).
- Aktywny recent lub delta: do końca przebiegu.
- Po zwolnieniu: komenda startuje przy najbliższym następcy (2-3 s, do 6 s
  przy kolejnych kolizjach) plus ok. 2 s pollingu pg-boss. To kilka sekund, nie
  15 s z backoffem i nie utrata retry.
- Dotychczasowe zachowanie „nie czekaj bez końca” jest zachowane: handler
  nigdy nie czeka na lock.

To, co rozwiązano: komenda **nie przegrywa** ze zwykłą synchronizacją
**przed jej startem** (nowa praca ustępuje, backfill nie wchodzi w nowy zakres)
oraz kolizja przestała być błędem. Czego nie rozwiązano: skrócenia już
trwającej synchronizacji.

## 9. Testy i izolacja

Izolacja: żaden test nie czyta `DATABASE_URL`/`TEST_DATABASE_URL` (w procesie
nie były ustawione, sprawdzone przed uruchomieniem). `vitest.config.ts` nie
ładuje `.env`. Każdy plik integracyjny startuje własny, jednorazowy kontener
`postgres:18.6-bookworm` na losowym porcie, własny pg-boss i fałszywe serwisy
(sync, komendy, provider, content). Nie uruchamiano aplikacji, workera,
synchronizacji, SMTP ani IMAP na prawdziwym koncie; nie ruszano istniejących
kontenerów (`maildock-app-1`, `maildock-postgres-1`), bazy ani kolejki.
Testy czasowe używają przesuwania `start_after`/`started_on` w jednorazowej
bazie oraz fałszywych timerów w teście UI, bez sleepów.

Nowy plik `tests/user-actions-first.integration.test.ts` (21 testów), prawdziwy
pg-boss (`fetch`, `startAfter`, retry, `complete`/`fail`), prawdziwy
advisory lock, deterministyczne kroki jak w `inbox-first-priority`:

| Nr zadania | Test                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-3        | Lock trzyma „backfill": komenda `pending`, `attempts 0`, job `completed`/`retryCount 0`, jeden następca z `startAfter` ≤ 4 s, po zwolnieniu wykonana raz |
| 4-6        | Bramka i workery recent/delta/backfill, dla Archive i INBOX: ustępują, zapisują jednego następcę, wracają po zakończeniu komendy                         |
| 7, 26      | Komenda innego mailboxa/konta nie wstrzymuje pracy; zajęty mailbox konta A nie zatrzymuje komendy konta B                                                |
| 8, 23      | API, retry, poller i kontynuacja (także równoległe `Promise.all`): jeden job w `created`/`retry`/`active`; sierota (aktywny > 120 s) zastępowana         |
| 9          | Równoległe kontynuacje: najwyżej jeden następca                                                                                                          |
| 10         | Komenda bez enqueue (crash po zapisie): poller tworzy job, komenda wykonana                                                                              |
| 13         | Błąd `run` → zwykły retry pg-boss (bez następcy); `MailboxBusyError` rzucony po starcie `run` nie jest odroczeniem                                       |
| 14         | Komenda starsza niż 10 min, `executing`, `succeeded`, `failed` nie wstrzymują historii                                                                   |
| 15         | Równoległe komendy: brak nakładania (`overlap = 1`), kolejność, brak podwójnej mutacji                                                                   |
| 16         | Wolny content A nie blokuje B (prawdziwy `boss.work`)                                                                                                    |
| 17, 18     | Repair: tylko `pending`/`fetching` starsze niż 30 s, bez `ready`/`failed`/świeżych; brak duplikatu przy queued/concurrent/aktywnym; sierota zastępowana  |
| 19         | Załącznik: 6 równoległych requestów i 3 ticki repair przy aktywnym jobie → jeden job; różne załączniki niezależne                                        |
| 24         | Awaria `send` następcy: job w `retry`, komenda `pending`                                                                                                 |
| 25         | 8 równoległych handlerów na puli 2 sesji przy zajętym locku: wszystkie wracają, pula wolna, 8 następców (po jednym na komendę)                           |

Dodane do istniejących plików: `message-commands.integration` (12, 15),
`email-rendering-ui` (21 i natychmiastowy HTML przy `pending`).
Istniejące testy pokrywają 11 (`fails an uncertain MOVE replay without
repeating it`), 20 (sanitizacja, cache i remote images: `email-rendering*`,
`sanitize*`, `message-content-provider`) i 22 (`inbox-first-priority`,
`initial-inbox-*`, `recent-sync-*`, `delta-sync-*`, `backfill-sync-*`).

Kontrola czułości: po tymczasowym wyłączeniu bramki komend 4 z 21 nowych testów
nie przechodzi (kod przywrócono).

Wyniki (bez `tests/security/**`, w izolowanych kontenerach):

- `user-actions-first.integration`: 21/21; `message-commands.integration`: 18/18;
  `email-rendering-ui`: 11/11.
- Pełne `vitest run` bez `tests/security/**`: 79 plików, 907/907.
- `pnpm typecheck`, `pnpm lint`, `prettier --write` zmienionych plików,
  `git diff --check`: bez błędów.
- Test 16 sprawdzony negatywnie: przy `CONTENT_WORKER_CONCURRENCY = 1` kończy się
  timeoutem (kod przywrócono do 2).

## 10. Pozostałe problemy (etap 3: cooperative preemption)

1. Aktywny backfill trzyma lock przez całą porcję. Kontrakt z poprzedniego
   etapu pozostaje: `higherPriorityWorkWaiting(…)` między podzakresami UID
   (po pełnym FETCH i commicie), wynik `yielded`, zwolnienie locka przed
   następnym FETCH. Bramka rozpoznaje już komendy, więc ten sam test wystarczy.
2. Aktywny recent/delta nie oddaje locka ani sesji IMAP; potrzebny punkt
   kontrolny między partiami.
3. Okno wyścigu po drugim sprawdzeniu bramki (komenda utworzona po nim).
4. Komendy czekające w retry pg-boss po błędzie operacji (`executing`) nie
   wstrzymują synchronizacji; decyzja świadoma, do rewizji razem z preemption.
5. Sierota aktywnego joba wygasa w pg-boss po 15 min; helper omija ją po 120 s
   (komendy) i 300 s (content, załączniki), ale sama sierota nadal istnieje do
   wygaśnięcia.
6. Koszt bramki: jedno dodatkowe lekkie zapytanie przy starcie każdego joba
   synchronizacji (partial lookup po `mailbox_id`, `status`); w razie potrzeby
   indeks `message_commands (mailbox_id) WHERE status = 'pending'` wymagałby migracji
   i nie został dodany.
7. Optymalizacja CID (punkt 2 w §7) i ewentualna zmiana contentu na współbieżność
   zależną od limitu połączeń IMAP wymagają pomiaru na prawdziwym serwerze
   i szerszego projektu (np. współdzielona pula IMAP), poza zakresem.
8. Wiele procesów workera: sloty i `deferrals` są lokalne dla jobów, dedup działa
   między procesami (stan w bazie).
9. Nie mierzono na prawdziwym Gmailu.

## 11. Zmiany

Kod: `inbox-first-policy.ts`, `deduplicated-enqueue.ts` (nowy),
`message-command-jobs.ts`, `sync-admission.ts`, `content-jobs.ts`,
`message-content-service.ts`, `attachment-jobs.ts`, `composition/worker.ts`,
`composition/worker-process.ts`.

Testy: `tests/user-actions-first.integration.test.ts` (nowy),
`tests/message-commands.integration.test.ts`, `tests/email-rendering-ui.test.tsx`.

Gałąź: `codex/v1-user-actions-first`. Commit kodu: `4147158`. Raport jest w
osobnym, następnym commicie (dokument nie może zawierać własnego SHA).
Bez merge do `main`, push i PR.
