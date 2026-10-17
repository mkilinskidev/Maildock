# Sync Engine v1: Cooperative Backfill Preemption (etap 3)

Gałąź: `codex/v1-cooperative-backfill` (od `codex/v1-dedup-safety` @ `053ef66`).
Commit: patrz ostatnia linia dokumentu.

Zakres: wyłącznie trwający backfill historii. Recent, delta, komendy, MOVE,
kolejki, scheduler i schemat bazy są bez zmian (brak migracji).

## 1. Problem

Do tej pory jeden job backfill = jeden SEARCH + jeden FETCH całego zakresu
(`MAILDOCK_BACKFILL_CHUNK_SIZE`, domyślnie 500 UID) + jeden commit. Bramka
`higherPriorityWorkWaiting` była sprawdzana tylko przed startem joba i pod
lockiem tuż przed wywołaniem providera. Komenda użytkownika, która pojawiła się
po starcie, czekała na cały zakres 500 UID, a historia INBOX trzymała mailbox
advisory lock przez cały ten czas.

## 2. Implementacja

### 2.1 Zmienione pliki

| Plik                                                                                                                                                          | Zmiana                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/accounts/domain/mail-provider.ts`                                                                                                                | `BackfillMailboxSyncRequest.subBatchSize?`, `BackfillMailboxSyncSink.shouldYield?()`. Bez zależności od pg-boss.                                                                                                       |
| `src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts`                                                                                              | `synchronizeBackfillMailbox`: pętla po rozłącznych, malejących podzakresach w obrębie zakresu joba; `shouldYield` tylko między zatwierdzonymi podpartiami.                                                             |
| `src/modules/mail/application/backfill-sync-service.ts`                                                                                                       | `BACKFILL_SUB_BATCH_UIDS = 100`; `run(accountId, mailboxId, shouldYield?)` zwraca `BackfillRunResult`; diagnostyka podpartii; opcjonalny logger.                                                                       |
| `src/modules/mail/infrastructure/sync-admission.ts`                                                                                                           | `higherPriorityWork()` (ta sama decyzja co `higherPriorityWorkWaiting`, plus kategoria), `interactiveFetchWaiting()` (content/attachment/CID danego konta). `higherPriorityWorkWaiting` zachowuje dotychczasowy wynik. |
| `src/modules/mail/infrastructure/backfill-sync-jobs.ts`                                                                                                       | `backfillYieldReason()`; worker przekazuje callback, rozróżnia wyniki, planuje następcę, loguje powód ustąpienia.                                                                                                      |
| `src/composition/worker.ts`, `worker-process.ts`                                                                                                              | Przekazanie istniejącego loggera.                                                                                                                                                                                      |
| `tests/cooperative-backfill.integration.test.ts`                                                                                                              | Nowy: 21 testów akceptacyjnych (izolowany PostgreSQL + pg-boss).                                                                                                                                                       |
| `tests/backfill-sync-provider.test.ts`                                                                                                                        | Nowe: 6 testów providera (sub-batche, yield, braki UID, błąd FETCH).                                                                                                                                                   |
| `tests/backfill-sync.integration.test.ts`, `backfill-sync-jobs.test.ts`, `inbox-first-priority.integration.test.ts`, `user-actions-first.integration.test.ts` | Tylko dostosowanie atrap do nowego typu wyniku `run()`. Asercje bez zmian.                                                                                                                                             |

`MessageService.persistBatch` nie wymagał zmian: już teraz zapisuje wiadomości
i frontier w jednej transakcji z CAS (`backfillFrontierUid = frontier`,
`backfillUidValidity = recentSyncUidValidity = epoch`).

### 2.2 Szerokość podpartii: 100 UID

- Zakres joba pozostaje `MAILDOCK_BACKFILL_CHUNK_SIZE` (500) — kolejki, klucze
  `mailboxId:frontier` i BackfillPoller działają jak dotąd. Wewnątrz joba
  provider robi `ceil(500/100) = 5` bezpiecznych granic.
- 100 < `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE` (150): pojedynczy FETCH historii
  nigdy nie jest większy niż FETCH świeżej synchronizacji, więc czas trzymania
  locka po pojawieniu się sygnału jest ograniczony do jednego FETCH metadanych
  (envelope, flags, BODYSTRUCTURE, references) ≤ 100 wiadomości i jednej
  transakcji ≤ 100 wiadomości.
- Mniejsza wartość (np. 25) zwiększa liczbę SEARCH/FETCH/transakcji i zapytań
  bramki 4×, a zysk latencji jest mały wobec stałych kosztów (SELECT, logout,
  2–6 s opóźnienia busy-continuation komendy).
- Stała w kodzie (`BACKFILL_SUB_BATCH_UIDS`), wstrzykiwana w konstruktorze
  serwisu (testy używają 3). Bez nowej zmiennej środowiskowej.
- Podpartia jest liczona w UID, nie w wiadomościach: rzadki zakres może dać
  mniej FETCH-y (puste podzakresy nie wykonują FETCH w ogóle).

### 2.3 Przebieg jednego joba

```
lock(mailbox)
  bramka (pod lockiem) -> ustąp bez postępu?
  SELECT (EXAMINE), sink.selected(uidValidity, F)        // epoch check
  dla [lower, upper] = [F-99, F], [F-199, F-100], ... ∩ [floor, F]:
     1. UID SEARCH lower:upper
     2. UID FETCH wszystkich znalezionych (iterator do końca)
     3. brakujące UID -> ponowny SEARCH; nadal obecny => błąd, brak commitu
     4.+5. sink.chunk(messages, lower-1) = persistBatch: dane + CAS frontier
     upper = lower-1; koniec zakresu joba albo 0 => wyjdź bez pytania
     6. sink.shouldYield()  // tylko tu: FETCH zakończony, podpartia zatwierdzona
     7. true => wyjdź normalnie; false => kolejna podpartia
  mailboxClose + logout (zwykła ścieżka finally)
unlock(mailbox)
```

Frontier zawsze pochodzi z granicy zakresu (`lower - 1`), nigdy z najmniejszego
otrzymanego UID. Pusty podzakres też wywołuje `chunk([], lower-1)` i atomowo
przesuwa frontier.

## 3. Wykrywanie pilniejszej pracy

`backfillYieldReason(boss, accountId, mailboxId)` (infrastruktura), używane
przed lockiem, pod lockiem i między podpartiami — ta sama polityka w trzech
miejscach. Kategorie (kolejność = pilność):

| Powód         | Źródło                                                                            | Zakres      |
| ------------- | --------------------------------------------------------------------------------- | ----------- |
| `command`     | `message_commands.status = 'pending'`, nie starsze niż 10 min                     | ten mailbox |
| `own-fresh`   | queued recent/delta tego mailboxa (także busy-continuation i retry)               | ten mailbox |
| `fresh`       | gotowe recent/delta innych folderów konta; aktywne INBOX fresh (≤ 15 min)         | konto       |
| `interactive` | joby `message-content-fetch-v1` / `attachment-fetch-v1` (CID to joby załączników) | konto       |
| `gate-error`  | odczyt bramki rzucił wyjątek                                                      | —           |

`command` i `fresh` to istniejące `higherPriorityWorkWaiting(..., "history")` —
bez zmian zachowania; dodano jedynie kategorię dla diagnostyki.

### 3.1 Interactive fetching — przyjęta polityka

Content i załączniki nie biorą `mailbox-sync` locka, więc historia nie widzi
ich przez kontencję locka. Konkurencja dotyczy sesji IMAP i przepustowości
konta (Gmail). Przyjęto ograniczoną, account-scoped politykę:

- liczy się tylko żywy job pg-boss tego samego konta:
  - `active` z `started_on` w ciągu `ACTIVE_WORK_STALE_SECONDS` (15 min =
    expiry kolejki; martwego workera wcześniej usuwa heartbeat 90 s),
  - `created`/`retry` już wymagalny (`start_after <= now()`) i nie starszy niż
    `WAITING_WORK_STALE_SECONDS` (120 s);
- content: `data->>'accountId'`; załącznik/CID: `attachmentId` →
  `message_attachments` → `messages.account_id`;
- nie liczą się: trwałe wiersze `pending`/`fetching` bez joba (osierocone —
  poller je ponownie zakolejkuje i wtedy zaczną się liczyć), dalekie retry,
  przeterminowane joby, inne konta.

Kompromis: historia nie konkuruje z tym, co użytkownik właśnie otwiera, ale
każde otwarcie wiadomości zatrzymuje historię konta na ≥ 10 s
(`HISTORY_DEFER_SECONDS`). Content jest pobierany tylko na żądanie (brak
masowego prefetchu), więc ryzyko zagłodzenia historii jest małe; długi
załącznik może wstrzymać historię maksymalnie do 15 min (granica aktywności).
Zysk po stronie Gmaila (mniej równoległych sesji) pozostaje hipotezą — nie
mierzono go na realnym koncie (zakaz w tym etapie).

### 3.2 Błąd odczytu bramki

Callback w workerze łapie wyjątek i zwraca `true` z powodem `gate-error`:
provider kończy się normalnie po zatwierdzonej podpartii, worker planuje
opóźnionego następcę. Jeśli również enqueue następcy się nie powiedzie, job
kończy się błędem → retry pg-boss, a niezależnie BackfillPoller; oba czytają
trwały frontier. Błąd bramki _przed_ startem (poza runem) zachowuje się jak
dotąd: job rzuca i trafia do retry.

## 4. Checkpoint i UIDVALIDITY

- Każda podpartia: dane + `backfillFrontierUid: F -> lower-1` w jednej
  transakcji `persistBatch` z CAS na frontier i epoch. Brak zmian w CAS.
- Wyjątek FETCH lub SEARCH, brakujący-a-obecny UID, błąd DB: transakcja
  podpartii nie zachodzi albo jest wycofana; wcześniej zatwierdzone podpartie
  zostają. Serwis ustawia `backfillStatus = failed` (jak dotąd), job → retry.
- Status: `selected` ustawia `running`, każdy commit podpartii ustawia
  `pending` (dotychczasowe zachowanie `persistBatch`), `0` ⇒ `complete`. UI
  może więc pokazywać `pending` w trakcie dalszych podpartii tego samego joba.
- `complete` tylko gdy frontier = 0. Yield nigdy nie ustawia `failed`.
- UIDVALIDITY: sprawdzane w `selected` każdej sesji; zmiana ⇒ dotychczasowe
  recovery (`not_started`, wyczyszczony frontier, `requestRecentSync`).
  W obrębie jednej sesji SELECT epoch nie może się zmienić niezauważenie
  (zmiana zrywa sesję → błąd → retry → nowy SELECT).

## 5. Lifecycle joba i wznowienie

`BackfillRunResult`:

| Wynik         | Znaczenie                                                  | Worker                                                |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `completed`   | frontier = 0                                               | nic                                                   |
| `progressed`  | cały zakres joba zatwierdzony, frontier > 0                | następca `mailboxId:F'`, `startAfter` 5 s (jak dotąd) |
| `yielded`     | ≥ 1 podpartia zatwierdzona, potem sygnał                   | log, następca `mailboxId:F'`, `startAfter` 10 s       |
| `ineligible`  | wyłączone konto/folder, brak recent, complete, reset epoki | nic                                                   |
| (brak wyniku) | ustąpienie przed lub pod lockiem, `MailboxBusyError`       | następca z tym samym kluczem, 10 s (jak dotąd)        |
| wyjątek       | awaria                                                     | retry pg-boss (jak dotąd)                             |

Brak nowej trwałej maszyny stanów; payload nadal `{version, accountId, mailboxId}`,
a serwis zawsze czyta trwały frontier.

- **Klucz następcy po yield z postępem** = `mailboxId:<nowy frontier>` — ten sam
  klucz, który wyliczy BackfillPoller, więc poller i worker deduplikują się w
  `enqueueCoalescedSync` (advisory xact lock + `queued`).
- **Stately**: aktywny job ma stary klucz; następca ma nowy klucz albo (bez
  postępu) ten sam klucz w stanie `created` za aktywnym — oba przypadki są
  dozwolone przez politykę `stately` i lokalną łatkę.
- **Gorąca pętla**: yield z postępem zawsze robi ≥ 1 podpartię i czeka 10 s;
  yield bez postępu czeka 10 s i nie dotyka IMAP. Utrzymujący się sygnał daje
  więc co najwyżej jedną podpartię na ~10 s, nigdy pętlę bez opóźnienia.
- **Równoległe workery**: dwa joby tego samego mailboxa (np. retry + poller)
  serializuje advisory lock; przegrany robi busy-yield bez sesji IMAP.
  Duplikat po zakończeniu historii dostaje `ineligible`.
- **Crash po commicie, przed enqueue**: frontier jest trwały, BackfillPoller
  (60 s) kolejkuje `mailboxId:F'`.

## 6. Testy

Wszystko na fake ImapFlow / atrapach, izolowany kontener
`postgres:18.6-bookworm` (testcontainers), własny pg-boss. Bez `DATABASE_URL`
i `TEST_DATABASE_URL` (uruchamiane z `env -u`). Żadnego połączenia z działającą
instancją, żadnego IMAP/SMTP.

`tests/cooperative-backfill.integration.test.ts` — prawdziwy
`ImapSmtpMailProvider` nad fake klientem, prawdziwy `BackfillSyncService`,
`MessageService.persistBatch`, `registerBackfillWorker`, mailbox advisory lock
i pg-boss. Zakres joba 10 UID, podpartia 3 UID.

| #       | Scenariusz                                                                                                                                                          | Wynik |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1       | komenda w trakcie FETCH: podpartia zatwierdzona, brak kolejnego FETCH, close+logout, lock wolny, następca `:7` z opóźnieniem; po komendzie wznowienie od 7 do końca | ✓     |
| 2       | INBOX delta w trakcie historii INBOX → `own-fresh`                                                                                                                  | ✓     |
| 3       | fresh innego folderu → `fresh`; 3b historia Archive ustępuje INBOX delta, priorytet −10 zachowany                                                                   | ✓     |
| 4       | content tego konta → `interactive`                                                                                                                                  | ✓     |
| 5       | aktywny job załącznika/CID tego konta → `interactive`                                                                                                               | ✓     |
| 6       | komenda, delta, content, załącznik innego konta → brak yield, historia kończy się                                                                                   | ✓     |
| 7       | sygnał tuż po sprawdzeniu → dokładnie jedna dodatkowa podpartia                                                                                                     | ✓     |
| 8       | błąd bramki → `gate-error`, brak kolejnej podpartii, brak `failed`, wznowienie                                                                                      | ✓     |
| —       | bramka startowa także czeka na interactive                                                                                                                          | ✓     |
| —       | interactive: dalekie retry, stare niepobrane, osierocone aktywne, wiersze bez joba, inne konto → nie blokują                                                        | ✓     |
| 9/10/16 | błąd w drugim FETCH: frontier 7 zostaje, częściowo odebrany zakres nie jest zapisany, retry od 7                                                                    | ✓     |
| 11      | błąd DB (trigger) w drugiej podpartii → rollback całej podpartii i frontier                                                                                         | ✓     |
| 12      | rzadkie UID i puste podzakresy                                                                                                                                      | ✓     |
| 15      | zmiana UIDVALIDITY po yield → dotychczasowe recovery, bez FETCH                                                                                                     | ✓     |
| 17      | yield bez postępu → następca ≥ 5 s w przyszłości, nie do pobrania od razu                                                                                           | ✓     |
| 18      | crash po commicie przed enqueue → poller kolejkuje `:7`, wznowienie do końca                                                                                        | ✓     |
| —       | błąd enqueue następcy → job `failed`→`retry`, status nie `failed`, wznowienie                                                                                       | ✓     |
| 19/21   | aktywny job + poller (2×) + następca: 2 joby, nie więcej; brak utraty i duplikatów                                                                                  | ✓     |
| 20      | dwa workery, ten sam mailbox: drugi busy-yield bez sesji IMAP                                                                                                       | ✓     |
| —       | logi: tylko dozwolone pola, bez ID konta/mailboxa, nazw folderów, tematów                                                                                           | ✓     |

`tests/backfill-sync-provider.test.ts` (provider): kolejność
SEARCH→FETCH→commit→check, brak checku po ostatniej podpartii, yield kończy się
`close`+`logout` bez kolejnego FETCH, podpartie nie wychodzą poza zakres joba,
nieuporządkowane odpowiedzi FETCH (12), UID usunięty pomijany / UID obecny
blokuje (13, 14), wyjątek FETCH bez commitu (10).

Weryfikacja mutacyjna (lokalnie, cofnięta): wyłączenie `break` po
`shouldYield` → 14 testów czerwonych; traktowanie błędu bramki jako „kontynuuj”
→ test 8 czerwony.

22–24 (INBOX-first, user-actions-first, deduplikacja, heartbeat) pokrywa
pełna regresja poniżej — istniejące suite'y bez zmian asercji.

## 7. Wyniki pełnej regresji

| Kontrola                                                                                | Wynik                                                                                               |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `vitest run` (pełny, z `tests/security/**`), `env -u DATABASE_URL -u TEST_DATABASE_URL` | **112 plików, 1380/1380 passed**, exit 0, 151 s (przed etapem: 111 plików, 1353; +27 nowych testów) |
| `npm run typecheck` (`tsc` web + worker)                                                | 0 błędów                                                                                            |
| `npm run lint` (`eslint .`)                                                             | 0 problemów                                                                                         |
| `prettier --check` zmienionych plików                                                   | OK                                                                                                  |
| `git diff --check`                                                                      | OK                                                                                                  |

## 8. Znane ograniczenia IMAP

- **Brak natychmiastowej preemption.** Rozpoczęty `UID FETCH` musi się
  zakończyć: ImapFlow 2.0.6 nie anuluje wysłanego FETCH po opuszczeniu
  iteratora (odpowiedzi są nadal odbierane i odrzucane), a `client.close()`
  zrywa sesję i jest ścieżką awarii, nie ustępowania. Najgorszy czas od
  pojawienia się pracy do zwolnienia locka ≈ reszta bieżącej podpartii
  (SEARCH + FETCH ≤ 100 UID + weryfikacja braków + transakcja) + jedno
  sprawdzenie bramki (≤ 6 zapytań SQL) + `mailboxClose` + `logout`.
  Mierzone jako `releaseMs` (od wykrycia sygnału do zwolnienia locka).
- Czas między pojawieniem się komendy a jej wykonaniem obejmuje dodatkowo
  opóźnienie busy-continuation komendy (2–6 s + jitter, etap 2). Ten etap go
  nie zmienia.
- Sygnał jest sprawdzany co podpartię, nie w trakcie: sygnał pojawiający się
  tuż po sprawdzeniu pozwala dokończyć co najwyżej jedną kolejną podpartię.
- Duża wiadomość w podpartii nie wydłuża FETCH znacząco (metadane i
  BODYSTRUCTURE, bez treści), ale wolny serwer tak.

## 9. Pozostałe opóźnienia (poza zakresem)

- **Aktywne recent/delta nie są wywłaszczane.** Komenda na tym samym mailboxie
  czeka na koniec aktywnego recent/delta (busy-continuation). Recent/delta
  pracują partiami do 150 UID bez punktów ustąpienia.
- Content/CID nie czekają na historię (brak wspólnego locka), ale nadal
  konkurują z aktywnym recent/delta tego konta o sesje IMAP.
- `backfillStatus` przechodzi na `pending` po pierwszej zatwierdzonej
  podpartii, choć job nadal pracuje (semantyka `persistBatch` bez zmian).
- Własne recent/delta mailboxa liczone są jako `queued` także z odległym
  `startAfter` (dotychczasowa reguła bramki); teraz ma to wpływ również
  między podpartiami, ale zawsze po co najmniej jednej zatwierdzonej
  podpartii i z opóźnieniem 10 s.

## 10. Bezpieczeństwo środowiska

Nie uruchamiano synchronizacji realnego konta, nie łączono się z działającymi
kontenerami `maildock-app-1` / `maildock-postgres-1`, nie wykonywano migracji,
resetów ani czyszczenia kolejek poza jednorazowymi kontenerami testowymi.
Logi diagnostyczne zawierają tylko kategorię powodu, liczności, czasy i granice
frontier (bez UID wiadomości, nazw folderów, tematów, ID konta).

## 11. Commit

Implementacja i raport: `6472f5a73615fdbafbda368b731198f0003c583b` na `codex/v1-cooperative-backfill`. Bez merge, push i PR.
