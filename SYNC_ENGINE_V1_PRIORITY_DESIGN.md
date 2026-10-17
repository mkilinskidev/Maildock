# Maildock v1 — Priority, Preemption & Interactive UX Design Review

Data: 2026-10-17, Europe/Warsaw. Gałąź `main`, HEAD `ba074880768645473af070ecc846e420ced990d5`.

## 1. Executive summary

**Rekomendacja: Minimal + wąski Cooperative, z odczytem trwałego zapotrzebowania między małymi zakresami UID.** Zachować v1, jego kolejki, mailbox lock, checkpoint i pollery. Nie budować nowego schedulera. Najpierw naprawić obsługę zajętej blokady i enqueue komend; następnie umożliwić działającemu backfillowi zakończenie po zatwierdzonej podpartii. Równolegle wdrożyć INBOX-first z ograniczoną bramką startu innych folderów, newest-UID-first oraz szybsze odświeżanie listy podczas initial sync.

Najważniejsze wnioski:

- Różne liczby `priority` w różnych kolejkach nie ustalają wspólnego porządku wykonania. Wspólny zasób komend i synchronizacji to `mailbox-sync` advisory lock; obecnie przegrana zamienia się w błąd i długi retry. [K1–K3]
- ImapFlow 2.0.6 pozwala opuścić iterator między odpowiedziami bez pozostawienia backpressure, ale **nie anuluje wysłanego FETCH**. Pozostałe odpowiedzi są odbierane i odrzucane. Nie daje to szybkiego odzyskania sesji. Bezpieczną jednostką ustąpienia jest zakończony mały FETCH, weryfikacja braków i commit danych z frontier. [L1, K4–K6]
- Dzisiejszy backfill wykonuje tylko jeden zakres UID na job. Gate między obecnymi jobami jest odroczeniem następnej pracy, nie preemption trwającego zakresu. Reakcja wewnątrz tego zakresu wymaga zmiany providera. [K4, K5]
- Content i CID nie używają mailbox locka i tworzą własnych klientów IMAP. Preemption historii nie usuwa ich kolejek, kosztu sanitizacji, blobów ani polling UI. Zysk przez odciążenie Gmaila pozostaje hipotezą. [K9–K11]
- Bez zmian recent/delta komenda nadal może czekać na cały aktywny recent/delta. Proponowane pierwszeństwo jest kooperatywne przy bezpiecznych granicach i dostępie do zasobów, nie globalne natychmiastowe wywłaszczanie. [K2, K7, K12]

## 2. Zakres, metoda i podstawa ustaleń

Przeczytano cały `SYNC_ENGINE_V1_AUDIT.md`, następnie zweryfikowano kluczowe ścieżki w aktualnym źródle. Oznaczenia: **potwierdzone** oznacza analizę kodu, **projekt** — proponowane zachowanie, **hipoteza** — możliwy wpływ bez pomiaru, **nieweryfikowane** — brak wystarczających danych. Opis projektu w kolejnych sekcjach nie oznacza istniejącej funkcjonalności.

Nie wykonywano diagnostyki Gmaila, operacji UI, synchronizacji, testów, zapytań do bazy, migracji ani restartów. Nie importowano composition aplikacji. Nie zmieniono konfiguracji ani kodu. Nie utworzono commita/PR. Jedynym nowym plikiem tej pracy jest ten raport; istniejący nieśledzony audyt pozostawiono bez zmian. Nie używano Receiving Engine v2 jako wzorca.

### Indeks dowodów w repozytorium

Ścieżki są względem katalogu repozytorium. Numery wskazują początki istotnych bloków, nie pełne zakresy.

| ID | Plik i punkt wejścia | Potwierdzone znaczenie |
|---|---|---|
| K1 | `src/modules/mail/infrastructure/{recent-sync,delta-sync,backfill-sync,message-command,content,attachment}-jobs.ts`; `patches/pg-boss@12.33.7.patch` | Osobne kolejki; recent/delta +10, backfill -10; concurrency content 1, attachment 2, command 4, backfill 1. Poprawka stately sprawdza active w tej samej kolejce i key. |
| K2 | `src/modules/mail/infrastructure/mailbox-lock.ts:5` | Reserve sesji, try-lock, throw przy zajętości, unlock/release w finally; brak priorytetu. |
| K3 | `src/modules/mail/infrastructure/coalesced-sync-job.ts:4`; `message-command-jobs.ts:18,42,60` | Coalescing tylko queued; command send bez klucza, lock przed service.run, poller co 30 s. |
| K4 | `src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts:942` | Backfill: read-only select, jeden zakres, SEARCH, FETCH, sprawdzenie missing, sink.chunk, teardown. |
| K5 | `src/modules/mail/application/backfill-sync-service.ts:25`; `backfill-sync-jobs.ts:46,97` | Epoch/frontier, kontynuacja po 5 s, gate recent/delta przed i pod lockiem, repair co 60 s. |
| K6 | `src/modules/mail/application/message-service.ts:367,583` | Transakcja persistBatch, mailbox FOR UPDATE, aktualizacja danych i warunkowe przesunięcie frontier. |
| K7 | `src/modules/mail/application/message-service.ts:153,176,221`; provider `:868` | Routing recent/delta, status po enqueue, batch recent, brak sortowania UID, backfill po sukcesie. |
| K8 | `src/modules/mail/application/mailbox-discovery-service.ts:33,63`; `mailbox-service.ts:145`; `src/composition/worker.ts:74`; `recent-sync-scheduler.ts` | Discovery allSettled, remotePath ASC, dwa miejsca enqueue recent ze stałym priority. |
| K9 | `src/modules/mail/application/message-content-service.ts:124,169`; provider `fetchMessageContent` (`:1369` i dalsze) | Pending/fetching blokuje ponowne request; osobny IMAP, sanitizacja i zapis treści w DB. |
| K10 | `src/modules/mail/application/attachment-service.ts:119,168,183,307,315`; `attachment-lock.ts`; provider `fetchAttachment` | Osobny lock zasobu, stream do storage, blob przed ready, repair pending/fetching. |
| K11 | `src/modules/mail/application/email-rendering-service.ts:30`; `src/components/rich-email-body.tsx:34`; `attachment-list.tsx:24`; `src/shared/application/content-polling.ts:1` | Render zleca CID, czyta gotowe bloby, base64 w HTML; polling render/content 400–2500 ms domyślnie, attachment 2500 ms. |
| K12 | `src/modules/mail/application/delta-sync-service.ts:194`; provider `:1050` i dalsze | Nowe UID i późniejsze uzgadnianie istniejących; praca pod jednym mailbox lockiem. |
| K13 | `src/modules/mail/application/message-command-service.ts:32,142,187,206,308,369,399`; provider `:680` | Trwała komenda, optimistic state, walidacja tożsamości, executing, mutacja, sukces/fail/reconcile, ochrona niepewnego MOVE. |
| K14 | `src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/actions/route.ts:12`; `src/app/api/accounts/[id]/message-commands/route.ts` | Autoryzacja, walidacja akcji, POST 202 i odczyt statusów. |
| K15 | `src/components/mail-client.tsx:736,1042,1160` | Automatyczny mark_read, lista odświeżana co 20 s, detail/content polling. |
| K16 | `src/modules/accounts/infrastructure/imap-client-lifecycle.ts:17` | Guard propaguje return iteratora, zamyka klienta po error, zachowuje pozytywne ack mutacji. |
| K17 | `src/composition/worker-process.ts`; `src/composition/worker.ts`; `src/shared/infrastructure/database/database-worker.ts`; `src/modules/mail/infrastructure/idle-watchers.ts:83` | Rejestracja niezależnych workerów, wspólna baza, INBOX rozpoznawany po remotePath uppercase. |

### Rzeczywista wersja ImapFlow i granice weryfikacji

`package.json` przypina **2.0.6**. `pnpm-lock.yaml:171` wskazuje patch `a35102b6…64acc`; `patches/imapflow@2.0.6.patch` zmienia wyłącznie obsługę STORE/UNCHANGEDSINCE w CJS i ESM, nie FETCH. Lokalny `node_modules/imapflow` wskazuje do katalogu tymczasowego innego checkoutu, a `node_modules/.pnpm/lock.yaml` ma inny hash poprawki. Nie wolno utożsamiać tych artefaktów z zależnością bieżącego main.

**L1:** odczytano w pamięci [opublikowany pakiet imapflow 2.0.6](https://registry.npmjs.org/imapflow/-/imapflow-2.0.6.tgz), bez instalacji i zapisywania plików. `package/dist/esm/imap-flow.js` SHA-256: `a4990e4ee4953b663a196e8e4406e3231c81b1c6d9d3334d5655a40e622f441e`; `commands/fetch.js`: `7f6317f1783179ea6d48a13dc0bfd16363503c56f1b3dedc6d8792d0e8768e98`. Analiza łączy ten kod z patchem repozytorium. Dokładnego artefaktu ImapFlow w działającym kontenerze nie weryfikowano ponownie.

Dokumentacja [FETCH](https://imapflow.com/docs/guides/fetching-messages/) ostrzega przed innymi komendami w pętli iteratora. Wnioski wersyjne poniżej opierają się na L1, nie na założeniu, że dzisiejsza dokumentacja opisuje każdą starszą wersję.

### Weryfikacja wcześniejszego audytu

Potwierdzone: brak INBOX-first, osobne kolejki, długi retry po busy, brak komend w backfill gate, atomowy checkpoint, brak mid-run preemption, content 1/attachment 2, osobne sesje IMAP, duplikujące enqueue CommandPoller oraz brak analogicznego repair content. [K1–K13]

Doprecyzowania: poprawka ImapFlow jest istotna dla mutacji; same lokalne node_modules nie są wiarygodnym dowodem wersji. First persisted nie oznacza first visible — lista ma polling 20 s. Historyczne liczby czasu i liczby połączeń z audytu nie są nowymi pomiarami ani dowodem bottlenecku. Nie ustalono obecnego limitowania Gmaila, dominującego kosztu content/CID, percentyli ani SLA. [K15, L1]

## 3. Przyczyny problemów i polityka rzeczywistego wykonania

**Potwierdzone:** pg-boss wybiera zadania w obrębie danej kolejki; stately i producer coalescing nie rezerwują wspólnego IMAP ani mailbox locka pomiędzy kolejkami. Recent/delta blokują folder przez cały job, backfill przez cały zakres. Try-lock nie ustawia kolejki oczekujących ani nie przekazuje zasobu komendzie. [K1–K3, K7, K12]

**Projekt:** priorytety 1 user action, 2 interactive fetch, 3 INBOX fresh/initial, 4 other fresh, 5 history oznaczają pierwszeństwo przy konkurencji o potrzebny zasób. Komenda folderu A i pobranie treści folderu B mogą pracować równolegle. Nie wstrzymywać całej aplikacji z powodu dowolnego zadania o wyższym numerze ważności.

Wspólny predykat dopuszczenia backfillu powinien uwzględniać trwałe pending/executing komendy tego folderu, gotowy recent/delta tego folderu i initial INBOX tego konta. W ramach ochrony wspólnych zasobów konta może również ustępować faktycznie oczekującemu interactive/fresh tego konta. Retry zaplanowane daleko w przyszłość i osierocone fetching nie mogą blokować historii bezterminowo: wymagają odróżnienia runnable/active od failed/delayed/stale. Naprawa stanów odbywa się przez istniejące pollery, a nie przez uznanie starego MOVE za bezpieczny do powtórzenia. [Projekt na K3, K5, K9, K10, K13]

## 4. Cooperative preemption: co jest możliwe

### Zachowanie biblioteki

**Potwierdzone w L1:** `fetch()` (`imap-flow.js:2733`) uruchamia FETCH asynchronicznie. `yield` przekazuje wiadomość; kontynuacja `next()` odblokowuje parser. `finally` (`:2822`) ustawia aborted, zwalnia lastRes oraz kolejkę. Kolejne odpowiedzi są odrzucane przez callback, który nadal wywołuje next. Kod nie wysyła CANCEL i nie oczekuje w tym finally na zakończenie komendy.

Wcześniejsze `break`/`return` nie pozostawia generatora blokującego parser, ale to **zakończenie konsumpcji, nie transferu**. Można zachować połączenie i pozwolić dokończyć komendę; następna komenda nie stanowi skrótu do natychmiastowego uwolnienia tej sesji. Guard aplikacji wywołuje `iterator.return()` w swoim finally. [L1, K16]

`close()` (`L1:2070` i dalsze) ustawia unusable, czyści mailbox/authentication i kolejki, odrzuca oczekujące operacje oraz zamyka transport. Klienta nie należy dalej traktować jako wybranej, zdrowej sesji: ponowienie musi stworzyć nowego klienta, połączyć się i sprawdzić UIDVALIDITY. Backfill wybiera readOnly i pobiera metadane; nagłówki FETCH używają BODY.PEEK (`commands/fetch.js:38`). Przerwanie takiego odczytu nie jest mutacją skrzynki, ale unieważnia kompletność otrzymanego zakresu. Nie wolno przesunąć frontier za nieodebrane UID. [L1, K4]

Nie proponuję `close()` jako zwykłego ustąpienia. To ścieżka awaryjna z kosztami reconnect i obsługą błędów, a nie kooperacja. Nie wykonywano eksperymentu protokołowego; dokładny czas drain/teardown i zachowanie konkretnego Gmaila pozostają nieweryfikowane.

### Bezpieczne i nieprzerywalne odcinki

**Projekt:** podzielić zakres pojedynczego joba backfill na malejące, rozłączne podzakresy UID. Dla każdego: SEARCH → pełne odebranie FETCH → weryfikacja brakujących UID → `sink.chunk` → commit → sprawdzenie pilniejszej pracy. Sprawdzać również przed pierwszym SEARCH i przed rozpoczęciem kolejnej podpartii. Po sygnale zakończyć metodę normalnym wynikiem yielded; wykonać teardown i dopiero zwolnić mailbox lock.

Nie przerywać w połowie connect/select/search, odpowiedzi FETCH, sprawdzania missing ani transakcji persistBatch. Nie uruchamiać logout/mailboxClose wewnątrz aktywnej pętli FETCH. Po commit wolno ustąpić, również gdy nie wykonano całego pierwotnego zakresu. W czasie FETCH sygnał może być zapamiętany, ale wykonanie czeka do tej granicy. Opóźnienie obejmuje resztę podpartii, DB, teardown i ponowne dopuszczenie pilnej pracy — nie ma liczbowej gwarancji.

Bez zmiany providera można zmniejszyć istniejący chunk i sprawdzać gate między jobami. To prostszy Minimal, ale kosztuje connect/logout i startAfter dla każdej małej porcji, a już wysłany FETCH nadal kończy się w całości. Cooperative utrzymuje jedno połączenie przez kilka podpartii tylko wtedy, gdy nie ma pilniejszej pracy. [K4, K5]

## 5. Sygnał o pilniejszej pracy

| Wariant | Reakcja | Koszt/złożoność | Restart i wiele workerów | Utrata sygnału / trwałość | Nowy scheduler? |
|---|---|---|---|---|---|
| A. Odczyt stanu między podpartiami | Na najbliższej granicy plus SELECT; zgłoszenie tuż po SELECT czeka jeszcze jedną podpartię | Mały; indeksowane EXISTS zamiast pełnych list jobów | Każdy worker odczytuje wspólną bazę; po restarcie odtwarza zapotrzebowanie z komend/jobów | Zakończona już praca może zniknąć i to poprawne; pending trwa. Bez nowej tabeli sygnałów | Nie |
| B. Mapa/EventEmitter w Node | Sygnał w następnym obrocie event loop; zasób oddany dopiero na granicy | Mały, ale trzeba czyścić subskrypcje i znaczniki | Pamięć ginie; web i worker są osobnymi procesami, więc samo emit w API nie wystarczy. Worker może emitować po claim, ale zajęte sloty opóźnią wykrycie | Łatwo stracić impuls; potrzebny fallback A. Trwały stan pracy już istnieje | Nie |
| C. PostgreSQL LISTEN/NOTIFY + odczyt stanu | Po commit powiadomienia i obsłudze listenera; nadal granica podpartii | Średni: dedykowana sesja, reconnect, bootstrap i fallback | Działa między web i wieloma workerami; po reconnect LISTEN, potem snapshot | NOTIFY nie jest trwałą skrzynką odbiorczą. Trwałe komendy/joby są źródłem prawdy, nowe trwałe flagi niepotrzebne | Nie |

Semantyka C: powiadomienia są dostarczane po commit, a utracona sesja traci subskrypcję. Po zestawieniu LISTEN trzeba odczytać stan, by zamknąć wyścig startu. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html).

**Wybór: A.** To również mechanizm kooperatywnego sygnału: callback `shouldYield(accountId, mailboxId)` odpytuje istniejący trwały stan. Provider dostaje callback, nie dostęp do tabel pg-boss. Service/worker dostarcza implementację. Nie ma sensu budować rozproszonego powiadamiania, skoro częstotliwość ustąpienia i tak ogranicza podpartia. B może później ograniczyć odczyty; C jest opcją przyszłą po pomiarach, nie elementem rekomendowanego minimum.

Sygnał nie jest mutexem. Dwa procesy nadal używają tego samego advisory locka; sprawdzenie przed i po jego uzyskaniu pozostaje potrzebne. Zgłoszenie tuż po gate jest dopuszczalnym wyścigiem kooperacji, który kończy się na następnej granicy. Awaria SELECT powinna bezpiecznie odroczyć rozpoczynanie następnej podpartii, z naprawą przez poller, zamiast zgadywać brak pracy.

## 6. Checkpoint i kontynuacja

**Obecny kontrakt:** frontier F oznacza najwyższy jeszcze nieprzetworzony UID. Initial F = UIDNEXT−1. Zakres `[L,F]`, gdzie L = max(1,F−chunkSize+1), jest wyszukiwany i pobierany; następny frontier to L−1. To szerokość przestrzeni UID, nie liczba wiadomości. SEARCH może zwrócić pusty zakres lub UID z lukami. [K4]

`BackfillSyncService.run.selected` sprawdza epoch i zapisuje F jako running. To inicjalizacja bieżącego punktu, nie potwierdzenie przejścia historii. `chunk` przekazuje poprzedni F i nowy F do persistBatch, a zmienną lokalną aktualizuje dopiero po await. `persistBatch` blokuje wiersz mailboxa, zapisuje wiadomości/placements/attachment metadata i warunkowo zmienia frontier w tej samej transakcji. Warunki obejmują oba epoch oraz poprzedni frontier; brak jednego zaktualizowanego wiersza powoduje rollback. Także pusty batch z backfillProgress przechodzi tę ścieżkę. [K5, K6]

**Projekt podpartii:** przy F=1000, pierwotnym L=501 i szerokości podpartii 100 pierwsza jednostka to `[901,1000]`. Dopiero jej kompletny zapis daje F=900. Przy sygnale dalsze `[501,900]` pozostaje do kolejnego uruchomienia. Nie używać minimum UID otrzymanego z częściowo przerwanego FETCH: serwer nie musi oddawać wiadomości w kolejności wysłanej listy, a niewidoczna luka może zawierać nieodebraną wiadomość.

Każda podpartia zachowuje dotychczasową kontrolę missing: brakujący UID potwierdzony przez ponowny SEARCH jako nieobecny nie blokuje postępu; nadal obecny lub błąd SEARCH blokuje checkpoint. Pełny FETCH i kontrola zdrowia klienta przed przekazaniem do sink ograniczają ryzyko zatwierdzenia niekompletnego odczytu. Obecnie końcowe assert jest po sink; nie należy wyjątku po commit interpretować jako cofnięcia zatwierdzonego frontier. [K4, K16]

| Moment awarii/ustąpienia | Wymagany rezultat |
|---|---|
| Przed pierwszą podpartią | F pozostaje bez zmian, nie complete; yielded bez wpisania błędu IMAP |
| W FETCH lub weryfikacji missing | Żaden checkpoint za niekompletny zakres; zwykła awaria, retry od trwałego F |
| W persistBatch | Rollback całej podpartii, żadnego częściowego przesunięcia frontier |
| Po commit, przed enqueue | Dane i nowy F trwają; BackfillPoller odtwarza job |
| Po kilku commitach, potem błąd | Wcześniejsze podpartie pozostają zapisane; start czyta aktualny F z DB, nie stale payload/key |
| UIDVALIDITY zmienione | Dotychczasowy reset stanu backfill i requestRecentSync; nie kontynuować starego epoch |
| F=0 | Complete, bez nowej kontynuacji |

Zachować status pending/complete z persistBatch. Yield nie powinien przechodzić przez ogólny catch ustawiający failed. Czytelniejszy wynik service to `completed | yielded | progressed | ineligible` z frontier niż obecne przeciążone `string|null`; to proponowana zmiana kontraktu, nie nowa maszyna schedulera.

Kontynuować po unlock, używając trwałego F i istniejącego coalescing. Przy yield bez postępu key może być identyczny z aktywnym jobem: nie zakładać, że send zawsze stworzy następny. Stately może mieć queued następcę, ale istniejące retry/pending trzeba rozpoznać; poller pozostaje obowiązkowym repair. Ustąpienie przed startem nie powinno tworzyć gorącej pętli. Obecne 5 s kontynuacji i 60 s repair są wartościami mechanizmu, nie SLA. Nie skracać arbitralnie wszystkich opóźnień historii. [K3, K5]

## 7. INBOX-first i newest-first

**Potwierdzone:** discovery iteruje remotePath ASC i wywołuje równoległe requestSync; await wewnątrz tych wywołań pozwala innym folderom enqueue wcześniej. Recent ma równy priority 10 we web i worker composition. Provider bierze kolejność SEARCH bez sortowania. Pierwszy zapis batch nie czeka na sukces całego recent, ale lista UI odświeża się co 20 s. [K7, K8, K15]

**Projekt minimalny:** wykryć selectable, active INBOX przez tę samą kanoniczną tożsamość co IDLE (`remotePath.toUpperCase() === 'INBOX'`), a nie display name. Await jego enqueue; dopiero potem enqueue innych folderów i jawnie obsłużyć rejected allSettled. Wyższy priority INBOX w kolejce recent **i delta**, we wszystkich producerach i naprawach. Nie ufać priority z payloadu użytkownika.

To zapewnia kolejność prób enqueue w danym discovery, lecz nie first execution. Dlatego dla initial sync dodać małą bramkę w workerze innych folderów tego konta: przed providerem i ponownie pod lockiem sprawdzić initial INBOX. Odroczyć inne recent oraz backfill do zakończenia pierwszej próby initial INBOX, chyba że zadziała ograniczony czas ochronny. Status success/failed, brak INBOX, disabled/nonselectable zwalniają bramkę. **Rekomendowany najprostszy wariant bramki: do końca pierwszej próby, z timeoutem**, używający istniejących statusów i timestampów; timeout jest parametrem do decyzji, nie obietnicą czasu synchronizacji.

Nie czekać na wszystkie retry INBOX. Osierocony running i failed enqueue również muszą zwolnić ochronę po jej terminie. Termin opierać na stałym początku próby/onboardingu, nie przesuwać przy każdej próbie enqueue. Potrzebny repair odroczonych initial jobów; nie kończyć ich bez trwałego następcy. Naprawić równocześnie race `requestRecentSync`: bezwarunkowe pending zapisane po send może nadpisać running/success szybkiego workera. [K7:196–205]

| Gwarancja | Co ją zapewnia / granica |
|---|---|
| First enqueue | Await INBOX przed pozostałymi w discovery; awaria send to jawny fallback, nie udany enqueue |
| First execution | Bramka blokuje start IMAP innych nowych folderów konta przed pierwszą próbą INBOX; priority preferuje INBOX w wolnym slocie. Nie wywłaszcza już aktywnych jobów innych kont |
| First persisted | Malejące UID podzielone na małe partie; pełny FETCH i sink.batch pierwszej partii |
| First visible | Po commit potrzebny odczyt listy/UI; przy initial sync aktywnego INBOX krótszy ograniczony polling zamiast stałych 20 s. Nie utożsamiać commit z renderem |

Opcja zwolnienia bramki już po pierwszym commit INBOX lepiej wykorzysta zasoby, lecz wymaga wiarygodnego znacznika pierwszej partii (oraz ścieżki pustego INBOX). Nie używać przypadkowego istnienia dowolnego placement jako znacznika dla nowej epoki. Nie rekomenduję tej dodatkowej trwałej fazy na pierwszy etap; zakończenie próby z fallbackiem jest prostsze, choć wolny INBOX dłużej opóźni pozostałe foldery.

**Newest-first:** posortować kopię found numerycznie malejąco przed slice. Opcjonalnie pierwsza partia mniejsza od kolejnych. FETCH może zwrócić tę partię w innej kolejności — sink zapisuje cały zbiór, więc priorytet dotyczy doboru UID do pierwszej partii. Wysoki UID oznacza późniejsze dodanie do folderu, nie gwarantowane najnowsze INTERNALDATE: import starej poczty może mieć wysokie UID. UI sortuje po internalDate (`message-service.ts:662`). Ścisła gwarancja kolejności dat wymaga dodatkowego pobrania/sortowania metadanych i nie należy jej obiecywać za koszt prostego sortu UID.

## 8. User-actions-first

### Pełny lifecycle obecnej komendy

POST actions sprawdza właściciela, JSON i sześć obsługiwanych akcji; create sprawdza konto, placement/epoch i mapowanie destination dla archive/trash. Transakcja zapisuje komendę i lokalne flagi/actionHidden. Enqueue po commit może się nie udać, pozostawiając durable pending. API zwraca 202. CommandPoller zbiera pending/executing (dziś 100 najnowszych). Worker odczytuje mailboxId, zdobywa mailbox lock i dopiero wywołuje run. [K13, K14]

Run pomija stan terminalny, odrzuca ponowne executing MOVE jako niepewne, ponownie waliduje konto/epoch/path/destination/placement, ustawia executing i zwiększa attempts. Provider otwiera osobny klient, sprawdza UIDVALIDITY, wykonuje flag add/remove lub MOVE. Sukces zapisuje succeeded, destination UID jeśli dostępne i usuwa źródłowy placement dla MOVE; następnie reconcile source/destination. Błąd prowadzi do odpowiedniej fail/reconcile lub ponowienia flag. `fail` odtwarza optimistic state. Pozytywne ack mutacji jest chronione przez guard przed późniejszym błędem teardown. [K13, K16]

### Projekt dostępu i naprawy kolejki

1. `createMailboxLock` zwraca rozpoznawalny busy, oddzielony od awarii reserve/SQL i callbacka. Busy przed run nie zwiększa attempts komendy i nie jest błędem IMAP. Uwolnić sesję DB przed oczekiwaniem.
2. Dla command/recent/delta kolizja przechodzi przez dedykowaną ścieżkę krótkiego odroczenia z jitterem, poza retry awarii operacji. Można najpierw wykonać ograniczoną liczbę krótkich ponownych try-lock w handlerze; po budżecie zapisać trwałego następcę. Nie trzymać wszystkich slotów command w nieograniczonej pętli na jednym mailboxie.
3. Następca musi istnieć przed uznaniem starego joba za completed. Dla komendy durable pending daje repair, lecz 30 s pollera nie jest szybką ścieżką. Nie obiecywać, że sam poller poprawi latency. Dla recent konieczna jawna naprawa, bo dziś nie ma jej odpowiednika.
4. Deduplikować wszystkie producentskie send (API, poller, busy continuation) przez commandId i jeden transakcyjny producer lock. Sprawdzić queued/retry **i active**. Sam singletonKey przy standard nie wystarcza. Normalny enqueue ma pominąć active; busy continuation świadomie dopuszcza jednego queued następcę własnego aktywnego joba. Bez tego deduplikacja zablokuje własną kontynuację.
5. Najmniejsza opcja zachowuje standard policy i serializuje producentów, sprawdzając żywe joby pod producer lockiem; nie zmieniać policy istniejącej kolejki w ciemno. Pozostawić mailbox lock i terminal-status guard jako ochronę wykonania duplikatów już istniejących. Alternatywne stately wymaga osobnego planu zmiany policy i testów z patchem pg-boss. Nie obiecywać exactly-once z samej deduplikacji.
6. Poller wybiera najstarsze nierozstrzygnięte komendy, pomija żywe joby i naprawia osierocone. Executing MOVE zawsze trafia do istniejącej ścieżki uncertain/reconcile, nigdy do automatycznego powtórzenia zdalnego MOVE.

Busy jest bezpieczny do przeplanowania **tylko gdy nie weszliśmy do run/mutacji**. Błąd po rozpoczęciu operacji podlega dotychczasowym regułom, szczególnie niepewności MOVE. Jitter i krótkie oczekiwanie są mechanizmem, wartości należy dobrać na fixture. [Projekt na K2, K3, K13]

**Dlaczego preemption pomoże:** komenda pending staje się widoczna dla backfillu po commit API, nawet przed claim joba. Backfill zatwierdza podpartię, kończy IMAP, zwalnia lock; command wraca szybko do try-lock. Gate blokuje ponowne wejście historii do czasu rozstrzygnięcia komendy. Bez zmiany busy retry komenda mogłaby nadal spać na backoff mimo zwolnienia zasobu.

Wzmocnić gate recent/delta przed rozpoczęciem pracy na tym samym folderze, aby oczekująca komenda nie przegrywała z nowym fresh jobem. Aktywne recent/delta nadal są nieprzerywalne w tym zakresie projektu. Jeśli właściciel wymaga user-first także podczas ich długich przebiegów, trzeba osobno zaprojektować ustępowanie recent i faz reconcile delta; proste przerwanie runRecentSync nie może oznaczać success częściowego okna. [K7, K12]

## 9. Content, zwykłe załączniki i CID

**Potwierdzone ograniczenia:** content localConcurrency=1 daje head-of-line blocking wszystkich kont obsługiwanych przez dany proces; drugi fetch czeka na zakończenie pierwszego, nawet gdy dotyczy innej skrzynki. Attachment localConcurrency=2 współdzielą kliknięte załączniki i CID. Dwa duże pliki mogą zatrzymać małe obrazki; N obrazków wymaga obsługi w kolejnych turach, choć dokładna liczba tur/czas zależy od błędów i cache. Nie jest to dowód, że te limity dominują w obecnej instancji. [K1, K9, K10]

Ścieżka content: detail → POST request → pending → pg-boss → connect/select/fetch części → sanitizacja → DB ready → następny detail poll → komponent HTML. Content tekstowy jest zapisany w DB, nie w blob storage. Ścieżka CID zaczyna się dopiero podczas renderowania: render zbiera unikalne referencje CID, dopasowuje attachment, zleca missing, zwraca pending. Kolejne render POST czyta gotowe bloby i wstawia base64 w dokument iframe srcDoc. Odświeżenie dokumentu jest konieczne do pokazania nowego CID; samo ready w bazie nie zmienia wyświetlonego HTML. [K9–K11, K15]

| Etap opóźnienia | Dowód | Wniosek projektowy |
|---|---|---|
| Kolejka i dostępność slotu | K1, K9, K10 | Ograniczony wzrost content 1→2 jest kandydatem do izolowanego porównania; nie gwarancją przyspieszenia |
| IMAP connect/auth/select/fetch | Provider fetchMessageContent/fetchAttachment | Każda operacja ma własny klient; wiele CID oznacza wiele sesji, brak puli konta |
| Blob write i ready | K10:377–395 | Ready dopiero po kompletnym blobie; nie publikować niepełnego zasobu w celu pozornego przyspieszenia |
| Sanitizacja i render | K9:210, K11:66–121 | JSDOM, ponowne odczyty blobów i base64 mogą kosztować CPU/IO; skala jest hipotezą |
| UI polling | K11, K15 | Content/render domyślnie od 400 ms do 2500 ms, zwykłe attachments 2500 ms; nie skracać wszystkiego bez kontroli obciążenia |
| Wspólne zasoby | K2, K6, K17 | Reserve DB trzyma sesję przez pracę, persistBatch trzyma row lock; brak dowodu bieżącego wyczerpania |

**Minimal:** naprawa stale pending/fetching content tylko po potwierdzeniu braku żywego joba; ograniczony eksperyment content concurrency 2 na fixture; unikanie ponownego generowania niezmienionego dokumentu i powtarzania kosztownych odczytów gotowych CID podczas pollingu, z zachowaniem klucza polityki sanitizacji i zgód nadawcy. Pierwszy render pokazuje dostępne HTML, nie czeka na wszystkie obrazki. Nie zwiększać bezwarunkowo attachment concurrency, nie usuwać walidacji MIME/limitów ani sandboxa.

Zwykłe załączniki i CID są tym samym poziomem interactive. Nie dawać bezwarunkowego pierwszeństwa wszystkim CID kosztem klikniętego pobrania; opcjonalna preferencja aktualnie oglądanych zasobów wymaga ograniczenia zagłodzenia.

**Preemption dla interactive:** brak bezpośredniego handoff mailbox locka; korzyść możliwa przez zwolnienie sesji historii i odciążenie konta/DB/sieci. Gate na aktywne/runnable interactive tego konta jest ostrożną polityką, lecz może spowolnić historię bez zysku dla UX. Zwiększenie concurrency może zwiększyć liczbę połączeń, CPU i presję Gmaila; nie ustalono bezpiecznego limitu dostawcy dla tej instancji. Nie podaję takiej liczby.

**Interactive fast lane:** istniejące osobne kolejki już izolują sloty workerów. Dodatkowy krok to mały per-account admission limit na sesje IMAP z rezerwą dla komend, interactive i INBOX, a nie nowy scheduler jobów. Wszystkie fabryki klientów, również IDLE/discovery/outgoing, muszą być uwzględnione w budżecie lub jawnie odjęte od niego. Nie trzymać mailbox locka czekając bez końca na permit. Wiele procesów wymaga wspólnego limitu albo jawnie podzielonego budżetu; sama mapa Node mnoży limit. Dlatego ten wariant nie należy do minimum.

## 10. Porównanie wariantów

Liczby to orientacyjna liczba istniejących plików produkcyjnych wymagających zmian, bez plików testów; zakresy zależą od wydzielenia wspólnych helperów. Nie są estymacją czasu implementacji.

| Wariant | Liczba i zakres | Złożoność | Potencjał UX | Ryzyka regresji | Granice IMAP | Testowanie |
|---|---|---|---|---|---|---|
| Minimal | Około 12–17: discovery/recent/delta enqueue, gate, mailbox lock, command/poller, composition, content i UI | Średnia; retry/dedupe i initial gate są najtrudniejsze | Lepszy onboarding, mniej sztucznego backoff, mniej blokowania content | Zgubiony następca, stuck gate, optimistic flags, nadmierny polling | Trwający backfill kończy aktualny zakres; recent/delta nadal blokują | Fake queue/clock/provider, izolowana DB dla dedupe i blokad, UI fixture |
| Cooperative | Minimal + około 3–5: provider, kontrakt domenowy, backfill service/worker, wspólny predykat | Średnia+, lokalna zmiana bez nowego schedulera | Krótsze oczekiwanie komendy/fresh za aktywną historią | Pominięte UID przy złym frontier, błędne complete/failed, lawina kontynuacji | Pełna podpartia i commit muszą się skończyć; brak twardego SLA | Przerwania na każdej granicy, missing UID, crash/restart, epoch, dwa workery |
| Interactive fast lane | Cooperative + około 5–9: admission/fabryka klientów, composition, kolejki interactive/config/telemetria | Wysoka względem celu | Ochrona zasobów konta przy faktycznej presji połączeń; poprawa niezależności kont | Deadlock permit-lock, zły budżet IDLE, starvation, mnożenie limitu na procesach | Więcej slotów aplikacji nie zwiększa przepustowości serwera | Fake limiter i sesje, przeciążenia per account, wiele procesów bez Gmaila |

**Najmniejsze sensowne rozwiązanie spełniające potrzebę ustępowania już działającej historii:** Minimal + podpartie i wariant sygnału A. Sam Minimal nie spełnia mid-run preemption. Fast lane i LISTEN/NOTIFY odłożyć do czasu, gdy metryki pokażą potrzebę.

## 11. Konkretne miejsca przyszłych zmian

Poniższa lista jest projektem, niczego nie zaimplementowano.

| Plik / funkcja | Zmiana |
|---|---|
| `mailbox-discovery-service.ts` / run | Await INBOX enqueue, obsługa nieudanych enqueue, fallback |
| `message-service.ts` / requestRecentSync, runRecentSync | Warunkowy status pending, bramka initial, sygnał końca pierwszej próby; zachować zapis pierwszej partii przed success |
| `recent-sync-scheduler.ts`, `recent-sync-jobs.ts`, `delta-sync-jobs.ts`, `composition/worker.ts` | Spójne wyliczanie priorytetu INBOX dla wszystkich producerów; gate, bezpieczne odroczenie i repair recent |
| `mailbox-lock.ts` / createMailboxLock | Jawny busy, rozdział od exception callbacka, release sesji przed odroczeniem |
| `message-command-jobs.ts` / enqueue, worker, poller | Dedupe commandId, busy successor, brak nieograniczonego czekania w slotach |
| `message-command-service.ts` / pendingIds | Najstarsze pending i recovery executing z zachowaniem uncertain MOVE |
| `coalesced-sync-job.ts` lub mały dedykowany helper | Rozróżnienie zwykłego enqueue i następcy własnego active joba; nie zepsuć semantyki sync queued |
| `backfill-sync-jobs.ts` / worker, BackfillPoller | Wspólny gate komend/fresh, przekazanie shouldYield, bezpieczna kontynuacja bez postępu |
| `accounts/domain/mail-provider.ts` / kontrakty backfill | Callback shouldYield i jawny wynik zakończenia; bez zależności domeny od pg-boss |
| `backfill-sync-service.ts` / run | Obsługa yielded bez failed, aktualny frontier po każdym commit, zachowanie epoch recovery |
| `imap-smtp-mail-provider.ts` / synchronizeBackfillMailbox | Malejące podzakresy, pełny FETCH każdego, missing check, sink i granice ustępowania |
| Ten sam provider / synchronizeRecentMailbox | Sort UID malejąco i ewentualnie mniejsza pierwsza partia |
| `message-service.ts` / persistBatch | Zachować istniejącą atomowość i CAS; zasadniczo bez zmiany algorytmu. Ewentualnie walidacja monotoniczności wejścia |
| `content-jobs.ts`, `message-content-service.ts`, `composition/worker-process.ts` | Kontrolowany concurrency i repair osieroconego content, wiring zależności |
| `email-rendering-service.ts`, `rich-email-body.tsx`, `mail-client.tsx` | Ograniczenie zbędnego renderowania, polling pierwszej listy INBOX, zachowanie anulowania po zmianie widoku |
| `shared/infrastructure/logging/diagnostics.ts` i punkty wywołań | Kategorie busy/yield, bezpieczne czasy faz bez treści poczty |

Ścieżki bez prefiksu należą odpowiednio do `src/modules/mail/application`, `src/modules/mail/infrastructure`, `src/modules/accounts` lub `src/components`, zgodnie z indeksem K. API actions i semantyka mutateMessage nie wymagają przebudowy do kooperatywnego backfillu. Zwiększanie puli DB nie zastępuje sprawdzenia budżetu rezerwacji i dostępności sesji dla persistBatch. [K2, K6, K17]

## 12. Kontrakty zachowania i proponowane testy regresyjne

To specyfikacja przyszłych testów, nie utworzone ani wykonane testy. Provider zawsze fake; testy SQL wyłącznie na osobnej, pustej bazie testowej z odciętą możliwością połączenia do Gmaila. Nie używać domyślnego środowiska aplikacji. Istniejące nazwy plików wskazują miejsca rozszerzenia, nie potwierdzenie izolacji ich konfiguracji.

| Kontrakt / scenariusz | Oczekiwany rezultat | Miejsce |
|---|---|---|
| Komenda pojawia się podczas pierwszego FETCH historii | Bieżąca podpartia kończy się i commit; następny FETCH nie rusza; teardown/unlock; komenda bez sieciowego backoff za busy | `backfill-sync-provider.test.ts`, `backfill-sync-jobs.test.ts` |
| Sygnał przed startem, w SELECT, FETCH, sink, po commit | Brak unsafe break; właściwy F dla każdej granicy; yielded nie failed/complete | Te same + `backfill-sync.integration.test.ts` |
| Rzadkie UID i odpowiedzi w losowej kolejności | Frontier według zamkniętego zakresu, nie minimum częściowej odpowiedzi; żaden obecny UID nie pominięty | Provider fixture |
| Missing nadal istnieje / został expunged przez zewnętrznego klienta | Pierwszy wariant rollback/no checkpoint, drugi może zatwierdzić zakres | Provider fixture |
| Błąd DB i crash po commit przed send | Niekompletna podpartia rollback; commit przetrwał i poller planuje od trwałego F | Backfill integration, fake queue |
| Zmiana UIDVALIDITY pomiędzy wznowieniami | Reset według obecnych reguł, recent, brak mieszania epok | Backfill i incremental sync fixtures |
| Yield bez postępu z tym samym key, wielu producerów i dwa workery | Co najwyżej kontrolowany następca; nie ginie praca, nie ma gorącej pętli; tylko jeden właściciel mailbox locka | Jobs + izolowana DB |
| Busy przed run vs błąd po mutateMessage | Busy nie zwiększa attempts; awaria operacji zachowuje istniejące reguły | `message-commands.integration.test.ts` |
| MOVE ack, potem błąd zapisu/teardown; restart executing | Nigdy automatyczny drugi MOVE; uncertain/reconcile zgodnie z obecnym kontraktem | Commands + `imap-client-lifecycle.test.ts` |
| Wielokrotny poller, queued/retry/active i busy successor | Brak lawiny duplikatów, następca nie zablokowany własnym active, najstarsze pending naprawiane | Command jobs fixture |
| INBOX ostatni w LIST, wolny INBOX, pusty, failed, stale running, brak INBOX | First enqueue/start w warunkach ochrony; pierwsza widoczna partia; fallback zwalnia inne foldery | `recent-sync-jobs.test.ts`, recent provider/UI fixture |
| Worker kończy recent przed powrotem enqueue | Status success nie zostaje nadpisany pending | Recent jobs/integration |
| UID malejące, INTERNALDATE sprzeczne z UID | Pierwsza partia najwyższych UID; brak fałszywego kontraktu sortowania dat | Recent provider fixture |
| Wolny content A i szybki B, wiele CID oraz duży attachment | Ocena head-of-line przy 1/2 slotach; brak dublowania ready; limit sesji obserwowany | Content/attachment provider fixtures |
| CID ready pomiędzy pollami, cache policy zmienione, zmiana selectedId | HTML uzupełniony, bez stale view i obejścia sanitizacji; polling ustaje po gotowości | `email-rendering.test.ts`, `email-rendering-ui.test.tsx` |
| Długi initial sync i gotowy pierwszy batch | Lista odświeża się przed całym recent; brak fałszywego success częściowego okna | Mail-client fixture |
| Pool reserve i callback pod lockiem | Brak wyczerpania wszystkich sesji przez oczekujących; brak deadlocku przy odroczeniu | Izolowany test DB/config |
| Ciągły napływ pilnej pracy, następnie cisza | Historia może czekać podczas presji; po jej ustaniu robi postęp bez resetu frontier | Fake clock/provider/poller |

Metryki przyszłej walidacji: enqueue→claim, claim→lock, lock_busy/requeue count, podpartia SEARCH/FETCH/DB/teardown, yield_requested→unlock, command accepted→remote ack, first INBOX commit→list render, content queue/connect/fetch/sanitize/ready/UI, attachment blob/ready/CID render. Rejestrować identyfikatory techniczne i czasy, bez tematów, adresów, treści ani tokenów. Oddzielać downtime, retry, zaplanowane opóźnienie i pracę. Nie ustalać SLA na podstawie małych historycznych próbek audytu.

## 13. Kwestie do decyzji właściciela

1. Czy INBOX ma mieć ochronę do końca pierwszej próby (rekomendowane minimum), czy tylko do pierwszej partii (dodatkowy znacznik)? Jaki maksymalny czas ochrony innych folderów jest akceptowalny?
2. Jaki budżet pracy jednej podpartii przyjąć na fixture? Szerokość UID i mniejsza pierwsza partia recent są parametrami do pomiaru; nie obiecują stałego czasu.
3. Czy user-actions-first ma obejmować również ustępowanie aktywnego recent/delta? Rekomendacja rozwiązuje aktywny backfill i dopuszczanie nowych jobów, ale nie skraca automatycznie całego reconcile delta.
4. Czy początkowo gate historii ma reagować również na interactive tego konta, mimo niepotwierdzonej konkurencji o IMAP? Rekomendacja: ograniczony, account-scoped gate na rzeczywiście runnable/active pracę, z repair stale stanów; ocenić zysk przed szerszym limiterem.
5. Czy zaakceptować możliwość zagłodzenia historii przy ciągłej pracy pilnej? Twarda gwarancja postępu historii może kolidować z wymaganiem „tylko gdy nie koliduje”; nie wprowadzać ukrytej kwoty historii kosztem UX.
6. Czy podnieść content z 1 do 2 po izolowanej walidacji? Attachment pozostawić początkowo na 2; fast lane uruchamiać dopiero po dowodzie presji wspólnych zasobów.

Rekomendacja końcowa: zachować v1; połączyć naprawę busy/dedupe, INBOX-first i newest-UID-first z odczytem trwałego zapotrzebowania między atomowo zapisywanymi podzakresami backfillu. Nie anulować transakcji, nie używać zerwania IMAP jako standardowej preemption, nie ponawiać niepewnego MOVE. Na tym kończy się praca projektowa.
