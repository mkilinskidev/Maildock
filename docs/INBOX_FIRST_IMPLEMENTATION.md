# Sync Engine v1: INBOX-first i newest-UID-first

Data: 2026-10-17. Gałąź: `codex/v1-inbox-first`, utworzona z `main`
(`ba074880768645473af070ecc846e420ced990d5`).

Kontynuacja na cały czas działania aplikacji (delta, IDLE, poller, retry,
backfill): `docs/INBOX_FIRST_FULL_PRIORITY.md`.

## Zachowanie

- Discovery rozpoznaje INBOX po `remotePath.toUpperCase() === "INBOX"`.
  Kończy jego próbę planowania przed uruchomieniem planowania pozostałych folderów.
  Błędy wszystkich enqueue są zbierane i zgłaszane; awaria INBOX nie pomija reszty.
- Wszyscy producenci recent korzystają z `enqueueRecent`, który odczytuje kanoniczną
  ścieżkę z bazy. INBOX otrzymuje priority 20, pozostałe foldery 10.
- Worker recent sprawdza ochronę przed mailbox lockiem i ponownie pod nim.
  Initial recent pozostałych folderów konta czeka na zakończenie pierwszej próby
  INBOX, maksymalnie do `firstDiscoveredAt + 60 sekund`.
  Trwałe `recentSyncCompletedAt` zwalnia ochronę również po błędzie i podczas retry.
  Ponowne enqueue, zmiana `startedAt` i restart procesu nie przesuwają terminu.
- Pusty INBOX kończy próbę normalnie. Brak INBOX, missing/nonselectable, failed,
  zakończona próba lub wyłączone konto nie utrzymują ochrony. Wyłączone konto nadal
  podlega istniejącej walidacji dostępu do providera i nie łączy się z IMAP.
- Odroczenie zapisuje następcę w pg-boss z `startAfter: 5` przed zakończeniem
  bieżącego joba. Błąd zapisu następcy powoduje błąd joba i zachowuje retry.
  Producentowy advisory lock oraz koalescencja ograniczają kolejkę do jednego
  oczekującego następcy danego folderu. Normalne żądanie może zaplanować następcę
  aktywnego recent; repair pomija również aktywne zadanie.
- Istniejący DeltaPoller naprawia initial recent bez udanej synchronizacji i bez
  żywego joba: po starcie workera oraz w istniejącym interwale, domyślnie 300 s.
  Naprawia także osierocone `running`, bez resetowania statusów i checkpointów.
- `requestRecentSync` zapisuje `pending` przed enqueue, warunkowo względem odczytanego
  statusu i z wykluczeniem `running`. Po enqueue nie zapisuje statusu. Jego obsługa
  błędu zmienia wyłącznie własny, nadal aktualny `pending`, więc nie nadpisuje
  `running`/`success` szybkiego workera.
- Recent sortuje kopię UID numerycznie malejąco. Pierwszy FETCH obejmuje najwyżej
  25 UID, kolejne istniejący batch size. Każdy kompletny FETCH trafia do sink przed
  rozpoczęciem następnego. Brakujące UID są ponownie sprawdzane: rzeczywisty EXPUNGE
  jest dopuszczalny, nadal obecny pominięty UID powoduje retry. Wcześniejsze commity
  pozostają dostępne po późniejszym błędzie; obsługa UIDVALIDITY pozostaje istniejąca.
- UI oglądanego INBOX odpytuje listę co 2 s podczas pierwszej niezakończonej próby,
  maksymalnie przez 60 s od wykrycia folderu. Potem wraca do 20 s. Ukryta karta,
  wyszukiwarka, drafty, All Inboxes i inne foldery nie korzystają z przyspieszenia.
  Zapytania nie nakładają się; cleanup anuluje HTTP i timer oraz odrzuca spóźnione
  odpowiedzi po zmianie konta, folderu lub widoku. Lista nie czeka na recent success.

## Zmienione pliki

Kod:

- `src/components/mail-client.tsx`
- `src/composition/worker.ts`
- `src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts`
- `src/modules/mail/application/initial-inbox-sync.ts` (nowy)
- `src/modules/mail/application/mailbox-discovery-service.ts`
- `src/modules/mail/application/message-service.ts`
- `src/modules/mail/infrastructure/delta-sync-jobs.ts`
- `src/modules/mail/infrastructure/recent-sync-jobs.ts`
- `src/shared/application/initial-inbox-polling.ts` (nowy)

Testy i raport:

- `tests/initial-inbox-sync.integration.test.ts` (nowy)
- `tests/initial-inbox-ui.test.tsx` (nowy)
- `tests/recent-sync-provider.test.ts` (nowy)
- `tests/incremental-sync-jobs-watchers.test.ts`
- `tests/incremental-sync.integration.test.ts`
- `tests/mail-provider.test.ts`
- `docs/INBOX_FIRST_IMPLEMENTATION.md` (ten raport)

## Walidacja i izolacja

126 testów zaliczonych w 14 plikach:

- 17 nowych testów integracyjnych: kolejność discovery i startu IMAP, blokowanie
  równoległego initial recent, empty/failed/missing/nonselectable/absent INBOX,
  disabled account, retry i stały deadline, odtworzenie stanu po restarcie,
  recovery enqueue i osieroconego running, status race, pierwszy commit przed
  zakończeniem providera, koalescencja i błąd zapisu trwałego następcy.
- 9 testów UI: pierwsza widoczna partia przy running, ograniczenie czasowe,
  zakończenie próby, cleanup po zmianie folderu/widoku i unmount, ignorowanie
  spóźnionej odpowiedzi oraz brak przyspieszenia poza initial INBOX.
- 5 testów providera recent: numeryczna kolejność i niemutowanie SEARCH,
  zapis przed następnym FETCH, puste okno, missing UID i częściowa awaria.
- Regresje: `recent-sync-jobs`, `mail-provider`, `incremental-sync-provider`,
  `backfill-sync-provider`, `backfill-sync-jobs`, `incremental-sync-jobs-watchers`,
  `mail-client-unread-count`, `imap-client-lifecycle`, `incremental-sync.integration`,
  `backfill-sync.integration`, `runtime-jobs.integration`.

Nowy test integracyjny ignoruje `DATABASE_URL` i `TEST_DATABASE_URL`; zawsze tworzy
własny jednorazowy kontener PostgreSQL i własny pg-boss. Testy korzystają wyłącznie
z fake providerów. Przed uruchomieniem istniejących integracji usunięto
`TEST_DATABASE_URL` wyłącznie ze środowiska procesu testowego, aby również użyły
własnych kontenerów. Nie uruchamiano aplikacji, operacji na Gmailu, migracji ani
czyszczenia kolejek działającej instancji; nie restartowano jej kontenerów.

`pnpm typecheck`, `pnpm lint` i `git diff --check`: zaliczone.
Istniejące nieśledzone audyty pozostają nietknięte i poza commitem.

## Ograniczenia i dalsze ryzyka

- Ochrona 60 s jest ograniczeniem konkurencji, a nie SLA ani limitem czasu IMAP.
  Po jej wygaśnięciu inne foldery mogą ruszyć równolegle z wolnym INBOX.
  Po awarii lub restarcie trwającym ponad minutę pierwszeństwo startu jest celowo
  osłabione przez fallback. Nie ma preemption już działających jobów.
- Recovery korzysta z dotychczasowego interwału DeltaPollera. Trwale nieskuteczny
  initial recent może być ponownie planowany w kolejnych przebiegach pollera;
  istniejący retry/backoff pg-boss pozostaje zachowany.
- Wyższy UID oznacza późniejsze dodanie do folderu, nie nowsze INTERNALDATE.
  Kolejność odpowiedzi wewnątrz pojedynczego FETCH zależy od serwera.
- Szybszy polling kończy się po minucie także przy nadal trwającym recent.
  Metadata folderów nadal odświeża się w dotychczasowym interwale.
- Nie mierzono opóźnień ani obciążenia na prawdziwym Gmailu. Dotychczasowe konflikty
  mailbox lock/busy retry, długie recent/delta, brak preemption backfillu i limity
  content/attachments pozostają osobnymi tematami poza tym zakresem.
- Nie dodano tabel, migracji, nowego schedulera ani zmian formatu checkpointów.
  Algorytmy delta i backfill pozostały bez zmian; DeltaPoller zyskał tylko naprawę
  initial recent.
