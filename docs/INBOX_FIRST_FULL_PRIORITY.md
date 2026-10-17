# Sync Engine v1: pełne INBOX-first

Data: 2026-10-17. Gałąź: `codex/v1-inbox-first`. Baza: `b24e19a`
(`feat(sync): prioritize initial inbox and newest recent messages`; treść
`1fcfbd7` plus raporty audytu). Uzupełnia `docs/INBOX_FIRST_IMPLEMENTATION.md`.

Poprzedni etap dawał pierwszeństwo INBOX tylko przy onboardingu (discovery,
initial recent, 60 s ochrony). Ten etap rozszerza INBOX-first na cały czas
działania: recent, delta, IDLE, poller, manual refresh, retry, repair i backfill.
Bez nowego schedulera, bez nowej kolejki, bez migracji, bez preemption.

## 1. Odnalezione ścieżki synchronizacji

### Producenci

| Kolejka  | Producent      | Ścieżka                                                                                                         |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| recent   | Discovery      | `MailboxDiscoveryService.run` → `MessageService.requestSync` → `requestRecentSync` (INBOX najpierw, awaitowany) |
| recent   | Web            | `PgBossRecentSyncScheduler.schedule` → `enqueueRecent`                                                          |
| recent   | Worker         | `composition/worker.ts` `recentSyncScheduler` → `enqueueRecent`                                                 |
| recent   | Recovery epoch | `DeltaSyncService` (zmiana UIDVALIDITY) i `BackfillSyncService` (zmiana epoki) → `requestRecentSync`            |
| recent   | Inne           | `AttachmentService`, `SentCopyService` (folder nie zsynchronizowany) → scheduler                                |
| recent   | Repair         | `DeltaPoller` (initial bez sukcesu, co 300 s) i **nowy** szybki repair INBOX (co 30 s)                          |
| recent   | Worker         | następca odroczenia (initial protection, admission, busy lock)                                                  |
| delta    | Manual / API   | `refresh/route.ts` → `MessageService.requestSync` → `PgBossDeltaSyncScheduler` → `enqueueDelta`                 |
| delta    | IDLE           | `IdleWatcherManager`: po połączeniu i po `exists/flags/expunge/mailboxClose` (debounce 500 ms)                  |
| delta    | Poller         | `DeltaPoller.poll` co `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS` (300 s)                                             |
| delta    | Komendy        | `MessageCommandService` reconcile (worker i web `accounts.ts`), `SentCopyService`                               |
| delta    | Worker         | **nowy** następca odroczenia/busy lock                                                                          |
| backfill | Recent success | `MessageService.runRecentSync` → `enqueueBackfill`                                                              |
| backfill | Poller         | `BackfillPoller` co 60 s                                                                                        |
| backfill | Worker         | kontynuacja po porcji, **nowy** następca ustąpienia                                                             |

Wszystkie ścieżki recent przechodzą przez `enqueueRecent`, delta przez
`enqueueDelta`, backfill przez `enqueueBackfill` → `enqueueCoalescedSync`.
Żadna nie przyjmuje priorytetu od wywołującego; API przekazuje tylko identyfikatory.

### Wykonawcy

`registerRecentSyncWorker` (localConcurrency 2), `registerDeltaWorker` (2),
`registerBackfillWorker` (1); niezależnie: komendy (4), content (1), załączniki
(2), discovery (5). Wszystkie synchronizacje folderu oraz komendy dzielą
advisory lock `mailbox-sync:<mailboxId>`; content i załączniki go nie używają.

### Jak mniej ważny folder mógł wyprzedzić gotowy INBOX (przed zmianą)

1. Delta miała stały priority 10: INBOX z IDLE czekał FIFO za falą 14 delta z pollera.
2. pg-boss porządkuje tylko w obrębie kolejki: recent innego folderu i delta
   INBOX startowały niezależnie, bez żadnego rozstrzygnięcia między nimi.
3. Bramka backfillu sprawdzała tylko recent/delta tego samego folderu: historia
   Archive startowała obok gotowej delty INBOX.
4. Oba sloty delta mogły być zajęte przez długie delty innych folderów.
5. Kolizja locka (np. delta INBOX podczas porcji backfillu INBOX) → błąd → retry
   30 s z backoffem; po 4 kolizjach job `failed`, praca czekała na IDLE/poller.
6. Backfill miał jednakowy priority −10: historia INBOX nie była preferowana.
7. Ustąpienie backfillu kończyło job bez następcy; powrót dopiero z pollerem (≤60 s).
8. Initial recent INBOX bez żywego joba wracał tylko z DeltaPollerem (≤300 s).

## 2. Jedna polityka INBOX-first

`src/modules/mail/application/inbox-first-policy.ts` — czyste wartości:

| Tier            | Prace                                        | pg-boss priority |
| --------------- | -------------------------------------------- | ---------------: |
| `inbox-fresh`   | recent/delta/IDLE/poll/manual/recovery INBOX |               20 |
| `other-fresh`   | to samo dla pozostałych folderów             |               10 |
| `inbox-history` | backfill INBOX                               |               −5 |
| `other-history` | backfill pozostałych                         |              −10 |

Rozpoznanie INBOX: `isInboxPath(remotePath)` — kanoniczna ścieżka z bazy
(`upper(remote_path) = 'INBOX'`), nigdy nazwa wyświetlana ani kolejność discovery.
Discovery, IDLE i `shouldDeferInitialRecent` używają tej samej funkcji.
Priorytet liczony jest w transakcji producenta (`storedSyncPriority`) z
zapisanego `remote_path`. Usunięty w międzyczasie folder dostaje najniższy priorytet swojego rodzaju.

Poziomy 1–2 (akcje użytkownika, content/załączniki/CID) nie przechodzą przez
nową politykę: ich workery nie wołają bramki i nie są przez nią wstrzymywane.

## 3. Mechanizmy pierwszeństwa

Trzy warstwy, każda z inną gwarancją:

| Mechanizm                                         | Gdzie                                                         | Gwarancja                                                                                                         | Granica                                                   |
| ------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Priorytet kolejki                                 | wszyscy producenci                                            | W obrębie jednej kolejki gotowy INBOX jest pobierany przed innymi folderami, a historia INBOX przed inną historią | Nie porównuje kolejek; nie zatrzymuje aktywnych jobów     |
| Bramka dopuszczenia (`higherPriorityWorkWaiting`) | recent, delta, backfill: przed lockiem i ponownie pod lockiem | Między kolejkami, w obrębie konta: niższy tier nie startuje, gdy wyższy czeka                                     | Sprawdzenie w chwili startu; nie przerywa trwającej pracy |
| Zarezerwowany slot INBOX w delta                  | `registerDeltaWorker`                                         | Długie delty innych folderów nie zajmą wszystkich slotów                                                          | Tylko kolejka delta; patrz §7                             |

### Bramka dopuszczenia

`src/modules/mail/infrastructure/sync-admission.ts`. Jedno zapytanie do
`pgboss.job` złączone z `mailboxes` (partial index `job_i3` dla kolejek stately):

- `other-fresh` (recent/delta folderu ≠ INBOX) ustępuje, gdy INBOX tego konta
  ma recent lub delta **gotowe i nieuruchomione**;
- historia (backfill dowolnego folderu, również INBOX) ustępuje, gdy dowolny
  folder konta ma gotowe recent/delta, albo gdy recent/delta INBOX jest aktywne;
  dodatkowo, jak dotąd, gdy ten sam folder ma recent/delta w stanie queued;
- `inbox-fresh` nigdy nie ustępuje bramce.

„Gotowe” = `created`/`retry` z `start_after <= now()`, bez aktywnego joba o tym
samym kluczu (stately i tak go nie uruchomi) i nie dłużej niż 120 s od
gotowości. Liczą się tylko foldery `selectable` i `active` tego samego konta.

Ustąpienie najpierw zapisuje trwałego następcę z opóźnieniem (fresh 5 s,
historia 10 s, ten sam klucz singleton), a dopiero potem kończy bieżący job.
Błąd zapisu następcy → błąd joba → zwykłe retry pg-boss. Ustąpienie nie zużywa
prób retry i nie zmienia statusów ani checkpointów.

### Zarezerwowany slot delta

`freshLanes(concurrency)` dzieli istniejący budżet: przy
`messageSyncConcurrency = 2` delta ma 1 slot ogólny + 1 slot z
`minPriority: 20` (tylko INBOX). Łączna współbieżność, liczba rezerwacji puli
DB i sesji IMAP się nie zmienia. Przy concurrency 1 rezerwacji nie ma
(pozostają priorytet i bramka). Slot ogólny także wybiera INBOX jako pierwszy.

## 4. Recent, delta i backfill — rozstrzygnięcia

| Konkurencja (to samo konto)                       | Wynik                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Delta INBOX vs delta innych                       | Priorytet 20 > 10 w kolejce; dodatkowy slot INBOX             |
| Delta INBOX vs recent innego folderu              | Recent innego folderu ustępuje przy starcie                   |
| Recent INBOX vs delta innego folderu              | Delta innego folderu ustępuje przy starcie                    |
| Fresh INBOX vs oczekujący backfill innego folderu | Backfill ustępuje                                             |
| Fresh INBOX vs oczekujący backfill INBOX          | Backfill ustępuje (bramka folderu i konta)                    |
| Fresh innego folderu vs backfill INBOX            | Backfill INBOX ustępuje (fresh > historia)                    |
| Backfill INBOX vs backfill innych                 | Priorytet −5 > −10                                            |
| Delta INBOX vs aktywny backfill innego folderu    | Delta startuje równolegle (inny lock); backfill kończy porcję |
| Delta INBOX vs aktywny backfill INBOX             | Brak preemption: delta czeka na commit porcji, patrz §7       |
| Konto A vs konto B                                | Bramka nigdy nie patrzy na inne konto                         |

## 5. Zagłodzenie innych folderów

- Bramka blokuje tylko na pracę INBOX gotową do startu, nie na aktywną
  (dla fresh), więc nieustanne IDLE INBOX nie wstrzymuje innych folderów:
  następca blokowany przez własny aktywny job nie jest liczony.
- Retry INBOX z przyszłym `startAfter` nie blokuje nikogo.
- Gotowy, a nieodebrany INBOX przestaje blokować po 120 s (zablokowany konsument).
- Aktywny INBOX starszy niż expiry kolejki (15 min) to sierota; nie blokuje historii.
- Missing, nonselectable lub usunięty INBOX nie blokuje.
- Odroczenie innego folderu to opóźnienie 5 s, a nie odrzucenie: job wraca sam.
- Historia może czekać przez cały czas trwania ciągłej świeżej pracy konta.
  To świadoma decyzja z `SYNC_ENGINE_V1_PRIORITY_DESIGN.md` §13 p. 5;
  backfill rusza w pierwszej przerwie.

## 6. Retry i recovery

- **Kolizja locka** (`MailboxBusyError`, nowy typ w `mailbox-lock.ts`) w recent,
  delta i backfill: callback nie startował, więc nie jest to błąd synchronizacji.
  Zapisywany jest następca za 5 s (backfill za 10 s); retry nie jest zużywany,
  a job nie przechodzi w `failed`. Wcześniej: retry 30 s z backoffem, po 4 kolizjach `failed`.
  Komendy zachowują dotychczasowe zachowanie (poza zakresem).
- **Retry błędu**: job w `retry` zachowuje priority 20; producenci (IDLE, poller,
  manual) koalescują do niego (`queued` obejmuje retry), bez duplikatów i bez resetu opóźnienia.
- **Restart workera**: priorytety są w wierszach pg-boss, a bramka czyta stan z
  bazy. Po restarcie zachowanie jest identyczne (test 12).
- **Szybki repair INBOX**: `DeltaPoller` ma drugi timer co 30 s, który wybiera
  wyłącznie wiersze INBOX bez udanego initial recent i bez żywego joba
  (`enqueueRecent` w trybie repair pomija created/retry/active). Pozostałe
  foldery i świeżość delta korzystają z niezmienionych 300 s. Ocena: 300 s
  recovery dla INBOX było nieakceptowalne przy onboardingu; 30 s jest
  ograniczone do jednego folderu na konto i nie dubluje żywych jobów. Trwale
  błędny INBOX jest ponawiany w rytmie retry pg-boss, a nie co 30 s, bo przez
  cały łańcuch retry job pozostaje żywy.
- **Backfill**: ustąpienie zachowuje klucz `mailboxId:frontier`, a checkpoint
  pozostaje bez zmian. Kontynuacja po porcji ma tier liczony na nowo.
  `BackfillPoller` nadal naprawia crash między commitem a enqueue.
- Żadne osierocone stany nie blokują konta: patrz granice w §5.

## 7. Zachowane zabezpieczenia i ograniczenia

Zachowane bez zmian: advisory lock per mailbox, producer lock +
koalescencja, policy stately i poprawka pg-boss, atomowy checkpoint i CAS
frontier w `persistBatch`, epoch/UIDVALIDITY recovery, ochrona initial INBOX
(60 s), obsługa niepewnego MOVE, retry komend. Brak nowych tabel i migracji.

### Ograniczenia (nie rozwiązane w tym etapie)

1. **Brak preemption aktywnych jobów.** Bramka działa wyłącznie przy starcie.
   Jeśli porcja backfillu INBOX trzyma lock, delta INBOX czeka do commitu porcji
   (do ~27 s w zaobserwowanym runtime), następnie około 5 s na następcę
   i około 2 s na polling pg-boss. Test 5 to dokumentuje. Analogicznie trwający
   recent lub delta innego folderu nie oddaje slotu ani połączenia IMAP.
   **Kontrakt na etap cooperative preemption:** aktywny backfill sprawdza
   `higherPriorityWorkWaiting(…, "history")` między podzakresami UID
   (po pełnym FETCH i commicie) i kończy się wynikiem `yielded`, zwalniając lock
   przed następnym FETCH; zgodnie z `SYNC_ENGINE_V1_PRIORITY_DESIGN.md` §4–6.
2. **Okno wyścigu po drugim sprawdzeniu.** INBOX utworzony po sprawdzeniu pod
   lockiem nie zatrzymuje już rozpoczętej pracy innego folderu. Rezerwacja slotu
   delta pozwala mu jednak wystartować równolegle (test „races”).
3. **Recent bez zarezerwowanego slotu.** Po onboardingu recent jest rzadki
   (UIDVALIDITY, foldery dodane później). Dwa długie recent innych folderów mogą
   opóźnić recent INBOX do zwolnienia slotu; nowe recent innych folderów ustąpią.
   Rezerwacja zmniejszyłaby równoległość onboardingu innych folderów.
4. **Koszt rezerwacji delta.** Przy domyślnym concurrency 2 delta innych
   folderów mają jeden slot: fala pollera trwa około 2× dłużej (np. 14 × ~3 s).
5. **Wiele procesów workera.** Bramka działa między procesami (stan w bazie),
   ale sloty i rezerwacja są lokalne dla procesu.
6. **Joby sprzed wdrożenia.** Zakolejkowane wcześniej delta INBOX (priority 10) i
   backfill (−10) zachowują stary priorytet do skonsumowania. Bramka nie zależy od priority.
7. **Sierota aktywnego INBOX.** Po crashu aktywny job INBOX blokuje własny klucz
   do expiry pg-boss (15 min). Jest to zachowanie istniejące; innych folderów nie blokuje.
8. **Koszt bramki.** Na start joba recent/delta/backfill dochodzą 2 lekkie zapytania
   przed lockiem i 2 pod lockiem. Każde ustąpienie to dodatkowy cykl joba.
9. Schemat `pgboss` jest stały (domyślny; aplikacja go nie zmienia).
10. Nie mierzono na prawdziwym Gmailu. Konkurencja o DB/IMAP/CPU po starcie
    pracy pozostaje poza kontrolą tej polityki.

## 8. Testy

Nowy plik `tests/inbox-first-priority.integration.test.ts` (17 testów):
jednorazowy kontener PostgreSQL, własny pg-boss, fake serwisy/IMAP, prawdziwy
`boss.fetch` (priority, startAfter, retry, stately) i prawdziwy advisory lock.
Sloty są sterowane deterministycznie: każdy krok to jedno pobranie przez dany
slot i `complete`/`fail` jak w `boss.work`. Asercje dotyczą faktycznej kolejności
uruchomień, a nie tylko zapisanych priorytetów.

| Nr  | Scenariusz                                                                       | Wynik                                                                                                                       |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Delta INBOX za trzema deltami innych folderów                                    | INBOX uruchomiony pierwszy                                                                                                  |
| —   | Slot INBOX: nie bierze innych; startuje INBOX (A i B) obok długiej delty Archive | OK                                                                                                                          |
| 2   | Delta INBOX vs recent Archive                                                    | Recent odroczony z jednym następcą; kolejność INBOX → Archive                                                               |
| 3   | Recent INBOX vs delta Archive                                                    | INBOX → Archive                                                                                                             |
| 4   | Oczekujący backfill Archive i INBOX vs gotowa delta INBOX                        | Historia odroczona; delta → backfill INBOX → Archive                                                                        |
| 5   | Aktywny backfill                                                                 | Archive: delta INBOX równolegle. INBOX: delta nie startuje (**ograniczenie**), następca bez retry/failed, start po commicie |
| 6   | Historia INBOX vs historia innych; fresh innego folderu vs historia INBOX        | −5 przed −10; historia ustępuje fresh                                                                                       |
| 7   | IDLE (prawdziwy `IdleWatcherManager`, fake klient)                               | Jedna delta INBOX, priority 20, uruchomiona przed kolejką                                                                   |
| 8   | DeltaPoller                                                                      | INBOX utworzone i wykonane pierwsze dla obu kont                                                                            |
| 9   | Manual refresh przez `MessageService.requestSync`                                | 20 vs 10, INBOX pierwszy                                                                                                    |
| 10  | Retry INBOX i kolizja locka                                                      | Retry zachowuje 20; brak duplikatów; busy → 1 następca, retryCount 0                                                        |
| 11  | Retry w przyszłości, stale ready, aktywny INBOX z następcą, sierota              | Nie blokują innych folderów ani historii                                                                                    |
| 12  | Restart pg-boss i ponowna rejestracja                                            | Priorytet i bramka zachowane                                                                                                |
| 13  | Dwa konta                                                                        | INBOX konta A nie wstrzymuje fresh ani historii konta B                                                                     |
| 14  | Komenda i content przy czekającym INBOX i backfillu                              | Uruchomione od razu                                                                                                         |
| —   | Wyścig: INBOX po pierwszym sprawdzeniu / po sprawdzeniu pod lockiem              | Odroczenie pod lockiem / brak preemption, INBOX w swoim slocie                                                              |
| 16  | Ustąpienie historii                                                              | Ten sam klucz, frontier bez zmian, kontynuacja z tierem                                                                     |

Scenariusz 15 (initial INBOX-first) pokrywają istniejące
`initial-inbox-sync.integration`, `initial-inbox-ui` i `recent-sync-provider`.
Uruchomione i zaliczone.

Kontrola czułości: po tymczasowym wyłączeniu bramki 9 z 17 nowych testów
nie przechodzi; kod przywrócono.

Dostosowane istniejące testy:

- `initial-inbox-sync.integration`: bezpośrednie wywołanie handlera oznacza
  teraz job tego folderu jako pobrany. Bez tego pozostawał „czekającym INBOX”,
  którego nowa bramka słusznie respektuje. W teście terminu INBOX jest aktywny.
- `runtime-jobs.integration`: migracje w izolowanej bazie, ponieważ producenci
  czytają `mailboxes.remote_path`.
- Mocki `backfill-sync-jobs` i `incremental-sync-jobs-watchers`: `getDb`
  dla zapytań bramki oraz osobny mock pollera.

Wyniki (`TEST_DATABASE_URL` i `DATABASE_URL` usunięte ze środowiska procesu,
wyłącznie własne kontenery i fake providery):

- Zestaw synchronizacji (20 plików): 280/280.
- Pełne `vitest run` bez `tests/security/**`: 78 plików, 883/883.
- `pnpm typecheck`, `pnpm lint`, `prettier --check` zmienionych plików, `git diff --check`: zaliczone.

Nie uruchamiano aplikacji, synchronizacji działającej instancji, operacji na
Gmailu, SMTP, migracji ani czyszczenia kolejek istniejącej bazy; nie restartowano kontenerów.

## 9. Zmiany

Kod:

- `src/modules/mail/application/inbox-first-policy.ts` (nowy): tiery, priorytety, limity, podział slotów.
- `src/modules/mail/infrastructure/sync-admission.ts` (nowy): bramka dopuszczenia.
- `src/modules/mail/infrastructure/sync-queues.ts` (nowy): nazwy kolejek bez cykli importów.
- `src/modules/mail/infrastructure/coalesced-sync-job.ts`: priorytet z `remote_path` w transakcji producenta.
- `src/modules/mail/infrastructure/mailbox-lock.ts`: `MailboxBusyError`.
- `src/modules/mail/infrastructure/recent-sync-jobs.ts`: bramka i następca przy busy.
- `src/modules/mail/infrastructure/delta-sync-jobs.ts`: tier, bramka, busy, slot INBOX,
  kolejność pollera, szybki repair initial INBOX.
- `src/modules/mail/infrastructure/backfill-sync-jobs.ts`: tier, bramka konta, następca ustąpienia i busy.
- `src/modules/mail/application/initial-inbox-sync.ts`, `mailbox-discovery-service.ts`,
  `message-service.ts`, `infrastructure/idle-watchers.ts`: wspólne `isInboxPath`/`syncPriority`.

Testy: `tests/inbox-first-priority.integration.test.ts` (nowy) oraz dostosowane
`initial-inbox-sync.integration`, `runtime-jobs.integration`, `backfill-sync-jobs`,
`incremental-sync-jobs-watchers`.

Commit: osobny commit na `codex/v1-inbox-first` zawierający ten raport
(SHA w `git log`; raport nie może zawierać własnego SHA). Bez merge, push i PR.
