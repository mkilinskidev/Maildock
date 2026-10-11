# Maildock Sync Engine v2 — niezależny audyt dokumentacji

Data: 2026-10-11. Status: **audyt statyczny; warunkowa gotowość do projektowania, brak zgody na implementację**.

Zakres: [Issue #5](https://github.com/mkilinskidev/Maildock/issues/5), trzy dokumenty v2, powiązane ADR, rzeczywiste ścieżki TypeScript/Node.js, PostgreSQL, pg-boss i istniejące testy. Audyt nie przyjmuje wcześniejszych rekomendacji jako dowodu.

## Podstawa i granice weryfikacji

- Aktualne `origin/sync-engine-v2`: `7ef7db5424637057cdbf9dcb3d46c242bc50277a`; punkt wyjścia gałęzi `review/sync-engine-v2-contract`.
- Referencja `origin/archive/sync-engine-v1-final`: `743804ac7478e6a48066e7563f047bc3c8b7cef0`, zgodna z issue. Różnica względem punktu wyjścia obejmuje wyłącznie trzy dokumenty v2. Kod audytowany na obu referencjach jest identyczny.
- Przeczytano w całości [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md), [CONTRACT_REVIEW_AND_V1_AUDIT.md](CONTRACT_REVIEW_AND_V1_AUDIT.md) i [PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md). Odwołania do ich sekcji i identyfikatorów odnoszą się do tego punktu wyjścia.
- Odwołania `L…` poniżej oznaczają linie źródeł w powyższym commicie, a nie linie wygenerowanych plików `dist-worker`. Przeanalizowano produkcyjne połączenia composition → producer → admission → worker → service → provider → persistence oraz istotne testy i migracje. Nie jest to pełny audyt bezpieczeństwa wszystkich funkcji aplikacji.
- **Zweryfikowane** oznacza potwierdzenie tekstem dokumentu, kodem, schematem lub oficjalną specyfikacją. **Wniosek statyczny** oznacza konsekwencję wskazanej ścieżki kodu, bez pomiaru działającego systemu. **Hipoteza** wymaga reprodukcji i nie jest diagnozą incydentu.
- Testy zostały przeanalizowane, ale nie uruchomione. Nie wykonano migracji, operacji na bazie, logowania OAuth, zapytań do kont pocztowych ani testów live. Wyniki wcześniejszych raportów są dowodem zakresu ich pomiarów, nie wynikiem tego audytu.
- Oficjalne źródła protokołów sprawdzono przez publiczną dokumentację; nie sprawdzono faktycznych limitów projektu Google użytkownika.

## Ocena ogólna

Kierunek jest właściwy: wymiana warstwy odbierania, zachowanie TypeScript/Node.js, danych i pozostałych funkcji, oddzielenie checkpointu od postępu oraz brak obowiązkowego Pub/Sub. Dokumenty uczciwie zaznaczają brak diagnozy live.

Nie są jednak jeszcze jednoznaczną podstawą do zatwierdzenia architektury. Najważniejsze braki dotyczą znaczenia selekcji IIW, granicy gotowości, wyjątków w polityce zasobów oraz obsługiwanej bazy wejściowej migracji. Macierz opisuje część możliwości protokołu bez dostatecznej informacji o ograniczeniach obecnego adaptera. Ogólne stwierdzenie poprzedniego audytu, że nie ma bezpośredniej sprzeczności, wymaga korekty: warunek checkpointu ma dwie różne wersje, a gwarancja postępu historii nie jest wszędzie warunkowa.

## Critical — blokady rozstrzygnięcia architektury

### C-01. IIW nie ma jeszcze operacyjnej definicji „newest”; limit 200 nie ogranicza kosztu odkrywania

**Zweryfikowane:** Product Contract, „Eligibility and bounds” oraz „Open decisions” pkt 1–2, zatwierdza liczby 30/200/50, ale pozostawia datę i ordering otwarte. Obecny IMAP skanuje rosnące zakresy UID od kursora do zamrożonego UIDNEXT, z `SINCE`; nie wybiera najnowszych 200 ani uzupełnienia do 50. Zob. [imap-sync-slice.ts](../../src/modules/accounts/infrastructure/imap-sync-slice.ts), L64–78, L107–154, oraz [imap-slice-sync-service.ts](../../src/modules/mail/application/imap-slice-sync-service.ts), L192–223. Gmail recent używa samego `after:…` dla całego konta: [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L837–861. Żaden z tych fragmentów nie realizuje v2 IIW.

**Dowód protokołowy:** IMAP `SINCE` porównuje datę wewnętrzną bez czasu i strefy; UID porządkuje przydzielanie identyfikatorów, nie musi odpowiadać `INTERNALDATE`, np. po imporcie. [RFC 9051, §2.3.1.1 i §6.4.4](https://www.rfc-editor.org/rfc/rfc9051). Gmail `internalDate` określa kolejność w INBOX, ale przy imporcie może pochodzić z nagłówka Date; [Message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages). Referencja [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) nie definiuje parametru sortowania ani stabilnego snapshotu stron. Sortowanie tylko pierwszej strony nie dowodzi globalnego top-200.

**Wniosek statyczny:** mała liczba materializowanych wiadomości nie gwarantuje małej liczby wyszukiwań/GET ani szybkiego pierwszego ekranu. Wymuszenie idealnego sortowania według daty na każdym IMAP może wymagać znacznie szerszej enumeracji. Nie jest dowiedzione, że hybrydowy IIW można tanio uzyskać wszędzie.

**Działanie:** przed wyborem architektury rozstrzygnąć datę, cutoff, tie-break i dopuszczalne ordering per provider. Zapisać osobno limit wyniku i ograniczenie kosztu odkrywania. Sprawdzić import/backdating, rzadkie UID, daty graniczne i równe timestampy. Jeżeli produkt akceptuje ordering po UID dla IMAP, musi to być jawna decyzja, a nie ukryte przybliżenie „newest”. Nie zwiększać zakresu funkcji.

### C-02. INBOX READY potrzebuje skończonej granicy reconciliation i jawnych wyników dla znikających wiadomości

**Zweryfikowane:** warunek 4 gotowości obejmuje zmiany obserwowane od bootstrap reference, a IF-010 i IIW-09 wymagają osiągnięcia gotowości przy ciągłych przyjściach. Warunek 2 wymaga zapisania membershipów wybranych wiadomości, które mogą w międzyczasie opuścić INBOX lub zostać usunięte; warunek 3 dopuszcza nierozwiązany element z „controlled recovery path”. Nie wskazano, jaki dokładnie zbiór zmian musi być zakończony ani czy taki recovery path wystarcza do READY.

**Kod pokazujący różnicę obecnego milestone:** [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L871–889, ustawia `recentReady` po recent inventory i dopiero rozpoczyna history replay. IMAP kończy recent po fazie messages i STATUS; nie wykonuje w niej pełnej reconciliation flag/presence: [imap-sync-slice.ts](../../src/modules/accounts/infrastructure/imap-sync-slice.ts), L155–207. Te flagi v1 nie są odpowiednikiem sześciu warunków v2.

**Wniosek:** warunki mogą być zgodne po wyznaczeniu skończonej granicy cut-over, ale ich zgodność nie jest jeszcze zdefiniowana. Czekanie na wszystkie stale dopływające zmiany może uniemożliwić READY; zapisanie starej membership wyłącznie po to, aby spełnić pkt 2 narusza authority.

**Działanie:** określić skończony zakres reconciliation do READY i przekazanie późniejszych zmian do ciągłego sync. Określić terminalne wyniki wybranego elementu: zapisany aktualny stan, potwierdzona utrata membership/absence albo widoczna blokada; rozstrzygnąć dopuszczalność nierozwiązanego elementu. Ujednolicić bramkę historii: IIW-01 wymaga materialization **i readiness**, natomiast akapit Resource allocation mówi tylko o materialization. Nie uzależniać READY od ciszy w skrzynce.

### C-03. Polityka zasobów ma sprzeczną liveness historii i nieokreślone miejsce zaakceptowanych komend

**Zweryfikowane:** „Priority invariant” mówi, że historia nie może permanentnie głodować, IF-006 wymaga zapobiegania permanent starvation, ale RI-003 przyznaje jej wyłącznie wolną przepustowość. Przy stale pełnym zapotrzebowaniu INBOX nie ma wolnej przepustowości. RC-012 zakłada convergence komend, IF-006 ochronę zasobów także dla commands, a globalne Inbox First nie określa minimalnej możliwości wykonania pojedynczej zaakceptowanej komendy/content. Poprzedni audyt PC-03/04 trafnie wykrywa problem, lecz nie rozwiązuje go w kontrakcie.

**Kod:** v1 celowo dopuszcza niższe klasy po 8 admissions lub 60 s, nawet przy oczekującym P0: [sync-admission.ts](../../src/modules/mail/infrastructure/sync-admission.ts), L75–87, L234–238, oraz [gmail-priority-decision.ts](../../src/modules/mail/infrastructure/gmail-priority-decision.ts), L26–33. To nie jest ścisłe „history only with leftovers”. Ponadto Gmail sync ustępuje, gdy istnieje jakakolwiek pending/executing komenda konta: [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L162–192; commands i sync dzielą account lock: [gmail-message-commands.ts](../../src/modules/mail/application/gmail-message-commands.ts), L274–302.

**Działanie:** wybrać warunkowy postęp historii przy dostępnych zasobach albo jawny wyjątek z przydziałem mimo INBOX demand. Ustalić możliwość wykonania pojedynczych zaakceptowanych akcji i odczytu treści oraz zachowanie bulk. Nazwać „current INBOX” tak, aby zależności jego odkrycia, np. konto-wide Gmail history, były dopuszczone. Nie odziedziczyć progów 8/60 jako nowej polityki bez decyzji. To rozstrzygnięcia istniejących obietnic, nie propozycja kolejnego algorytmu schedulera.

### C-04. „Zachować istniejące konta” nie określa obsługiwanej instalacji wejściowej; obecny kod blokuje legacy upgrade

**Zweryfikowane:** poprzedni audyt PC-10 wskazuje konflikt fresh-install ADR z v2, ale pomija wykonywalną barierę. [native-release-guard.ts](../../src/shared/infrastructure/database/native-release-guard.ts), L5–10 i L15–55, odrzuca zapełnioną bazę bez zweryfikowanej native foundation. Jest uruchamiany przed migracjami w [migrate.ts](../../src/shared/infrastructure/database/migrate.ts), L1–19, i przy worker startup: [worker-process.ts](../../src/composition/worker-process.ts), L24–30. To read-only odmowa, nie kasowanie danych.

**Tożsamość:** [receive-transport.ts](../../src/modules/accounts/domain/receive-transport.ts), L37–53, dopuszcza Google OAuth tylko jako `gmail_smtp`; legacy `imap_smtp` + Google nie jest obsługiwane. [ADR 0012](../adr/0012-native-gmail-receive-transport.md), L10–22, i [ADR 0013](../adr/0013-gmail-message-identity-and-label-membership.md), L10–26, świadomie wyłączają legacy conversion i preservation po reset. Issue utrzymuje `main` na stable v1.0.0, podczas gdy punkt startowy v2 zawiera native Gmail foundation.

**Działanie:** wskazać, czy v2 ma aktualizować instalacje stable/main, native v1-final, czy obie; opisać ich schematy/tożsamości i bezpieczne wejście. Samo usunięcie guardu nie jest strategią migracji. Zaplanować ochronę UUID, blob namespace, credentials, pending/uncertain commands i sends oraz zatrzymanie starych receiverów. Rollback musi określić pasujący binary/schema; nie obiecywać downgrade stable na native DB. Bez tego nie zatwierdzać projektu persistence/cut-over. Żadnej konwersji ani zmiany guardu w tym audycie.

## Major — istotne korekty i ryzyka

### M-01. Opis recent-first ukrywa konkretne różnice bootstrapu v1

**Zweryfikowane:** Gmail bootstrap zapisuje baseline i recent cutoff, a recent inventory obejmuje wszystkie foldery, także Spam/Trash: [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L417–445 i L837–861; [gmail-client.ts](../../src/modules/accounts/infrastructure/gmail-client.ts), L395–405. Intake przyznaje inventory klasę 2: [gmail-sync-repository.ts](../../src/modules/mail/infrastructure/gmail-sync-repository.ts), L193–206. Dedykowane `inbox_reconcile` wymaga `recent_ready`: [gmail-priority-decision.ts](../../src/modules/mail/infrastructure/gmail-priority-decision.ts), L35–47. Jednak history discovery może przeplatać recent inventory po 60 s — stwierdzenie „Gmail nie serwisuje nowych wiadomości przed recentReady” byłoby zbyt mocne.

**IMAP:** discovery najpierw **enqueue** INBOX, następnie inne foldery, nie czeka na wykonanie INBOX: [mailbox-discovery-service.ts](../../src/modules/mail/application/mailbox-discovery-service.ts), L74–92. Backfill eligibility jest per mailbox `recentSyncStatus=success`, nie per account INBOX READY: [backfill-sync-jobs.ts](../../src/modules/mail/infrastructure/backfill-sync-jobs.ts), L175–187; [backfill-sync-service.ts](../../src/modules/mail/application/backfill-sync-service.ts), L40–48. IDLE i delta są gated przez recent success: [idle-watchers.ts](../../src/modules/mail/infrastructure/idle-watchers.ts), L70–96; [delta-sync-jobs.ts](../../src/modules/mail/infrastructure/delta-sync-jobs.ts), L206–224; [imap-slice-sync-service.ts](../../src/modules/mail/application/imap-slice-sync-service.ts), L59–73. Recent ma zamrożony UID horizon, więc późniejsze UID czekają na następny mechanizm.

**Działanie:** zastąpić ogólne „preserve initial-window behavior” listą tego, co rzeczywiście jest do zachowania (durable horizon/replay), i tego, co trzeba przeprojektować (selekcja, bramka konta, freshness przed READY). P2 podczas Gmail recent może oznaczać recent INBOX metadata, nie historyczny import. Sama etykieta P2 nie dowodzi zgłoszonego naruszenia. Reprodukcja musi rejestrować typ żądania, zapytanie, fazę i faktyczną materializację.

### M-02. Bounded slice nie dowodzi bounded opportunity dla nowych wiadomości w tym samym INBOX

**Zweryfikowane:** IMAP delta najpierw przetwarza UID do stałego frontier, potem w kolejnych slices skanuje lokalne flagi/absence. Późniejsze UID nie są sprawdzane w fazie reconcile: [imap-sync-slice.ts](../../src/modules/accounts/infrastructure/imap-sync-slice.ts), L107–211. Testy wprost opisują przyjścia czekające na kolejny cykl: [imap-resumable-sync.integration.test.ts](../../tests/imap-resumable-sync.integration.test.ts), L316–346. Global admission nie rozróżnia nowego maila i starej reconciliation w tej samej kolejce INBOX.

**Gmail:** `inbox_started_at` utrzymuje wybór inbox reconciliation aż do zakończenia paginacji i weryfikacji starych lokalnych placements: [gmail-priority-decision.ts](../../src/modules/mail/infrastructure/gmail-priority-decision.ts), L37–38; [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L701–760. Pojedynczy slice jest ograniczony do 12, lecz cały przegląd nie jest ograniczony do IIW.

**Wniosek statyczny:** fairness między kontami i krótkie slices nie wystarczają do obsługi arrivals w środku długiego sweep tego samego INBOX. **Hipoteza:** przy 15 000 zmianach może to powodować duży lag; wielkość opóźnienia i przyczyna rzeczywistego incydentu pozostają niezmierzone.

**Działanie:** w projekcie wskazać, gdzie świeże przyjścia uzyskują dostęp w trakcie długiej reconciliation tego samego folderu, bez niebezpiecznego przeskakiwania checkpointu. Scenariusz akceptacyjny musi obejmować jedno konto/jeden INBOX, nie tylko A-backfill/B-arrival.

### M-03. Admission v1 jest mocniejszy niż queue labels, lecz nie obejmuje całej przepustowości

**Zweryfikowane:** [sync-admission.ts](../../src/modules/mail/infrastructure/sync-admission.ts), L16–22, L28–87, implementuje globalną liczbę active sync jobs, maksymalnie capacity-1 lower jobs i wykluczenie równoczesnego sync jednego konta. To realny mechanizm admission; nie wolno redukować v1 do „tylko osobnych kolejek”. Przechwytywanie SQL i patch dependency są potwierdzone: L95–180 oraz [patch pg-boss](../../patches/pg-boss@12.33.7.patch).

Ochrona dotyczy tylko pięciu sync queues. Nie obejmuje commands, content, attachments, outgoing/Sent-copy ani stałych połączeń IDLE. [worker-process.ts](../../src/composition/worker-process.ts), L114–169, rejestruje je niezależnie. Admission blokuje również INBOX tego samego konta, gdy jego inny sync jest active (SQL L33–34). W L82 dolny slot pozostaje chroniony nawet bez oczekującego P0, co ogranicza wykorzystanie wolnej pojemności względem RI-003.

**Działanie:** opisać dokładny obszar gwarancji i pomierzyć jego granice; zachować semantykę potrzebnych zabezpieczeń przy zastępowaniu SQL interception. Ocena prostszego rozwiązania musi uwzględniać wszystkie konsumenty i stałe connections, nie tylko liczbę sync workers. Nie usuwać pg-boss automatycznie — ADR 0004 uzasadnia trwałą kolejkę bez dodatkowej infrastruktury.

### M-04. Brak rezerwy Gmail INBOX jest potwierdzony; lokalny daily cap może zatrzymać odbiór na resztę dnia

**Zweryfikowane:** każdy receive slice tworzy client z `interactive=false`, także inbox: [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L158–160. [gmail-quota.ts](../../src/modules/mail/infrastructure/gmail-quota.ts), L120–158, dopuszcza background do 70% wspólnego user/project budget i daily cap; historia i freshness nie mają oddzielnego dostępu. Po wyczerpaniu daily cap zwracany jest czas do następnego dnia, L124–131. Default daily cap wynosi 2 000 000, L29–34; background ma 1 400 000. To limit aplikacji, nie odpowiedź Google.

Wspólny ledger i project lock są rzeczywiste, L57–71, L82–118; nie dowodzą sprawiedliwego podziału per konto. Przy koszcie GET=20 z [gmail-client.ts](../../src/modules/accounts/infrastructure/gmail-client.ts), L84–95, 15 000 exact GET kosztuje 300 000 jednostek, poza list/history/counters/retry. To rachunek kosztu, nie pomiar incydentu.

**Działanie:** wcześniejsze „appear to share” zastąpić pewnym ustaleniem o wspólnym background budget. Decyzja RI musi objąć daily cap/burst/backoff i moment konsumpcji, a nie tylko wolne worker slots. Odróżnić celowy lokalny limit od provider refusal. Oficjalne [Gmail quotas](https://developers.google.com/workspace/gmail/api/reference/quota) potwierdzają zmianę z maja 2026 i różnice projektów; opis daily billing threshold nie upoważnia do utożsamienia go z lokalnym hard stop.

### M-05. CR-001 dopuszcza checkpoint z unfinished work, IF-004 i macierz tego zabraniają

**Zweryfikowane:** CR-001 pozwala advance po trwałym zapisaniu unresolved work z replay guarantee. IF-004 pozwala advance tylko po trwałym applied changes; macierz „Durable checkpoint” mówi „never advance past unfinished covered work”. Są to różne kontrakty, a „prefer” nie ustala obowiązującej wersji.

**Kod:** Gmail odróżnia staging cursor/candidate od `historyId`; final checkpoint wymaga braku pending work: [gmail-sync-repository.ts](../../src/modules/mail/infrastructure/gmail-sync-repository.ts), L96–129, L224–245; [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L1087–1120. IMAP messages i checkpoint mogą być oddzielnymi transakcjami, z bezpiecznym replay: [imap-slice-sync-service.ts](../../src/modules/mail/application/imap-slice-sync-service.ts), L94–122, L257–269, L390–445; [imap-resumable-sync.integration.test.ts](../../tests/imap-resumable-sync.integration.test.ts), L288–315, L401–417. Nie należy obiecywać atomowego „batch+cursor” we wszystkich istniejących ścieżkach.

**Działanie:** wybrać jedną definicję applied checkpoint. Jeśli dopuszczona jest trwała kolejka przejętych zmian, nazwać jej intake cursor osobno i zdefiniować retencję/replay także po wygaśnięciu historii. Nie traktować account revision, UID frontier i MODSEQ jako jednego wskaźnika. Sam last UID nie pokrywa flag/deletions.

### M-06. Optimistic contract rozszerza obecne zachowanie; receive-only scope wymaga jawnego wyjątku

**Zweryfikowane:** RC-009 i RC-T02 wymagają obsługi kolejnych zaakceptowanych intencji, np. read → unread. Obecnie obaj producenci odrzucają drugą akcję, jeśli pierwsza pending/executing: [message-command-service.ts](../../src/modules/mail/application/message-command-service.ts), L104–117; [gmail-message-commands.ts](../../src/modules/mail/application/gmail-message-commands.ts), L106–119. Sequence fields/guards nie oznaczają, że UI/API przyjmuje taką sekwencję.

Durable acceptance istnieje, a nieudany enqueue jest naprawialny: pierwszy service L190–206, Gmail L240–241, poller [message-command-jobs.ts](../../src/modules/mail/infrastructure/message-command-jobs.ts), L77–79. Gmail nakłada pending intents na zdalne flags: [gmail-projector.ts](../../src/modules/mail/infrastructure/gmail-projector.ts), L406–429. Nie ma osobnego command status `uncertain`: [schema.ts](../../src/shared/infrastructure/database/schema.ts), L1411–1412; IMAP MOVE z niepewnym wynikiem przechodzi do failed z wyjaśnieniem i reconciliation, service L271–279, L444–448. Gmail po wyczerpaniu prób przywraca original flags, nie deklaruje niezależnego resolved remote state: commands L413–428.

**Działanie:** jawnie rozstrzygnąć, czy sequential acceptance jest zatwierdzonym rozszerzeniem poza receiver, czy v2 zachowuje obecny reject-until-terminal. Ustalić API/UI dla uncertain i retry. Nie przenosić statusu „failed” jako dowodu, że serwer nie zastosował operacji. Zmiany niezbędne do RC muszą być wymienione jako konkretna adaptacja, zamiast jednocześnie obiecywać nietknięcie message actions.

### M-07. Preservation i no-duplicates wymagają wyjątku dla nieudowodnionej tożsamości IMAP

**Zweryfikowane:** RC-008 rozpoznaje ograniczenie MOVE, ale CR-002/IIW-05 i ogólne preservation mogą nadal być czytane jako gwarancja jednej wiadomości przy każdej zmianie UID. Obecny IMAP przy nowym placement tworzy nowy message UUID: [message-service.ts](../../src/modules/mail/application/message-service.ts), L475–483 i L523–551. Na UIDVALIDITY reset usuwa stare placements: [imap-slice-sync-service.ts](../../src/modules/mail/application/imap-slice-sync-service.ts), L144–175. Wiadomości/cache mogą pozostać, ale powiązanie nowej epoki z dawnymi UUID nie jest przez to odzyskane. Provider pobiera opcjonalne `emailId`, ale nie należy utożsamiać odczytu pola ze stosowaniem go do deduplication.

**Dowód protokołowy:** [RFC 6851](https://www.rfc-editor.org/rfc/rfc6851) i [RFC 8474](https://www.rfc-editor.org/rfc/rfc8474) pozwalają na mapping lub opcjonalną stabilną tożsamość; nie gwarantują dostępności takiego dowodu na każdym serwerze. RFC Message-ID nie jest unikalnym kluczem remote message.

**Działanie:** ograniczyć idempotence replay do sprawdzonego locatora/generacji; oddzielić zachowanie lokalnych referencji od dowodu identity nowego remote placement. Ustalić zachowanie przy external move/rename/reset bez mappingu. Nie deduplikować heurystycznie po Message-ID, subject/date/size. Gmail native identity ma silniejszą podstawę — partial unique index [schema.ts](../../src/shared/infrastructure/database/schema.ts), L1025–1027, i projector L325–399.

### M-08. Capability Matrix wymaga doprecyzowania rzeczywistych interfejsów i fallbacków

**Zweryfikowane porównanie P / R / D:**

| Obszar | P — protokół | R — obecny kod | D — rozstrzygnięcie v2 |
| --- | --- | --- | --- |
| Gmail IIW | `labelIds`, `q`, paginacja; list zwraca IDs; `gmail.metadata` nie dopuszcza `q` | `GmailClient.messages(query,pageToken,maxResults)` nie wystawia `labelIds`, ogranicza request do 100, ustawia Spam/Trash true; inbox service używa `q=in:inbox` | Obecna sygnatura nie jest pełnym kontraktem IIW; ustalić query/scope, ordering i baseline. Limit wyniku 200 nie musi oznaczać jednej strony |
| Gmail metadata | GET posiada różne formaty | `message()` używa `format=full` z ograniczonym `fields`, bez body data dla metadata; nie używa `format=metadata` | Zachować MIME structure/part handles potrzebne do lazy content, nie zmieniać na okrojone metadata bez analizy |
| IMAP delta | CONDSTORE/QRESYNC są optymalizacjami protokołu | Produkcyjna composition wybiera resumable slice; ten fetchuje flags per lokalny UID, bez `CHANGEDSINCE`/`VANISHED` | Nie deklarować zaimplementowanego QRESYNC ani zakładać jego kosztu. Stara nieslice ścieżka nie opisuje aktywnej ścieżki |
| IMAP archive/trash/move | MOVE jest opcjonalny; COPY+DELETE to osobny mechanizm | Adapter wymaga MOVE, nie implementuje takiego fallbacku | Jawnie wskazać unsupported controls bez MOVE albo osobno zatwierdzić rozszerzenie; nie obiecywać zachowania każdej akcji na każdym IMAP |
| Gmail archive/delete | Remove INBOX/labels, Trash, permanent delete to różne operacje | Adapter/command actions nie wystawiają permanent delete; „move” tylko Gmail | Nie projektować bulk permanent-delete API na podstawie scenariusza remote deletions |
| Checkpoint/identity | Gmail history konto-wide; IMAP mailbox+epoch | Discriminated locators rzeczywiście istnieją w domain; Gmail service i client są poza mailbox MailProvider | Wspólny kontrakt produktu/persistence, niewielkie provider-specific seams; nie giant generic `syncMailbox()` |

**Referencje kodu:** [gmail-client.ts](../../src/modules/accounts/infrastructure/gmail-client.ts), L395–445; [imap-sync-slice.ts](../../src/modules/accounts/infrastructure/imap-sync-slice.ts), L155–200; [delta-sync-service.ts](../../src/modules/mail/application/delta-sync-service.ts), L52–73; [imap-smtp-mail-provider.ts](../../src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts), L765–784, L934–951; [receive-transport.ts](../../src/modules/accounts/domain/receive-transport.ts), L75–95, L114–133, L194–215. Oficjalne [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162).

**Działanie:** dopisać do macierzy te ograniczenia i odsyłacze do konkretnych metod. „Metadata” jako cel produktu jest poprawne, lecz nie oznacza identycznego formatu API. Kompatybilność OAuth scope sprawdzić względem obecnego grantu; nie proponować jego zmiany bez potrzeby.

### M-09. Rezerwa connection i authority publication są różne dla IMAP i Gmail

**Zweryfikowane:** [mailbox-lock.ts](../../src/modules/mail/infrastructure/mailbox-lock.ts), L11–24, rezerwuje połączenie z głównego pool, ale callback `work()` nie dostaje tej sesji. IMAP services używają osobno `database` pool. [database-worker.ts](../../src/shared/infrastructure/database/database-worker.ts), L8–20, używa `databasePoolSize`; config dopuszcza 1: [config.ts](../../src/shared/infrastructure/config/config.ts), L91. Przy pool=1 callback wymagający DB nie ma wolnego połączenia dopóki lock nie zostanie zwolniony. To wniosek z zasobów i wywołań, nie pomiar deadlocku PostgreSQL.

Gmail tworzy **osobne** connection authority per lock i przekazuje zbudowany na nim DB do pracy: [gmail-account-lock.ts](../../src/modules/mail/infrastructure/gmail-account-lock.ts), L14–35, L57–65, L90–100. Pool=1 w testach Gmail nie dowodzi pool=1 dla IMAP. Sesje authority zwiększają całkowitą liczbę connections ponad pool size. IMAP lock nie ma analogicznej walidacji PID/held lock przed każdą publication; revision fence nie jest dowodem żywej sesji lock.

**Działanie:** w modelu zasobów uwzględnić reserved sessions, osobne pools i IDLE. Określić ważność authority przy utracie lock session, nie tylko przy zmianie account revision. Nie przenosić gmailowych deklaracji pool=1 i fencing na wszystkie ścieżki. Potencjalną utratę authority IMAP potwierdzić fault injection w przyszłym środowisku izolowanym.

### M-10. Continuous server sync jest realne, ale poller 1 s nie daje Gmail freshness 1 s lub 30 s

**Zweryfikowane:** GmailPoller sprawdza eligible rows co sekundę, a nie wykonuje history GET każdą sekundę: [gmail-sync-jobs.ts](../../src/modules/mail/infrastructure/gmail-sync-jobs.ts), L60–88. Normalny completed history ustawia następne sprawdzenie za 60 s: [gmail-sync-service.ts](../../src/modules/mail/application/gmail-sync-service.ts), L1102–1111. Inbox sweep jest due po 60 s: priority SQL L37–38. Wszystkie browser tabs mogą być zamknięte; pollers są uruchamiane przez worker, ale dopiero po instance MFA readiness: [worker-process.ts](../../src/composition/worker-process.ts), L107–113, L165–185. To zamierzona granica security, nie browser gate.

UI już ma propagation bez reload: [mail-client.tsx](../../src/components/mail-client.tsx), L971–1091, polling co 10 s i visibility wake; coherent snapshots używają [mail-publication-service.ts](../../src/modules/mail/application/mail-publication-service.ts) oraz [0042_mail_publication.sql](../../db/migrations/0042_mail_publication.sql). Receive redesign nie powinien przypadkiem usunąć publication/revision semantics.

**Działanie:** oddzielić repair-poll frequency od provider cadence i latency. Gmail 30 s jest nowym celem do pomiaru, nie current guarantee. Doprecyzować IF-001 jako pracę w gotowej, działającej instancji, zachowując istniejące MFA pause. Nie obejmować nową „freshness” flagą successes z enqueue lub zakończenia nieistotnego slice.

### M-11. „Sending/drafts preserved” ukrywa istniejący wyjątek Gmail Sent-copy

**Zweryfikowane:** macierz trafnie mówi o SMTP i local drafts, ale nie wymienia zachowania opcji `maildock` dla Gmail. [sent-copy-service.ts](../../src/modules/mail/application/sent-copy-service.ts), L70–89, po wysłaniu ustawia tę kopię na failed i zaleca server-managed Sent; nie wykonuje rekomendowanego w [ADR 0015](../adr/0015-gmail-smtp-first-and-local-drafts.md), L16–20, confirmation/custom label flow. ADR pozostaje proposed i zawiera nierozstrzygniętą politykę UI.

**Działanie:** zapisać, co v2 zachowuje jako istniejące zachowanie i co jest otwartą decyzją. Nie dodawać Gmail API send, cloud drafts ani automatycznego resend, aby „naprawić” receive engine. Zapewnić dalszą obsługę SENT history i outgoing correlation bez scalania received identity po RFC Message-ID; projector L549–589. Brak kopii lub delayed Sent observation nie oznacza niepowodzenia SMTP.

## Minor — niedopowiedzenia i usprawnienia

### N-01. Błędna ścieżka receive-transport w poprzednim audycie

Tabela „Code seams”, wiersz `src/modules/accounts/infrastructure/receive-transport.ts`, wskazuje nieistniejący plik. Właściwy to [domain/receive-transport.ts](../../src/modules/accounts/domain/receive-transport.ts); job policy jest w [receive-job-policy.ts](../../src/modules/mail/infrastructure/receive-job-policy.ts). **Działanie:** poprawić odwołanie przy przyszłej redakcji dokumentu.

### N-02. „Preserve cached MIME” nie oznacza pełnych źródeł przychodzących

[ADR 0011](../adr/0011-progressive-mail-storage-without-retained-incoming-raw-mime.md), L14–22, zastępuje raw incoming MIME retention z ADR 0008. Odbiór przechowuje metadata, structure i on-demand display representation; outgoing ma immutable MIME snapshot. **Działanie:** opisać preservation jako zachowanie tego, co faktycznie jest zapisane, bez obietnicy regenerowania dowolnej wiadomości offline lub obowiązkowego pobierania pełnego raw MIME.

### N-03. Test acceptance nie określa jeszcze niektórych istotnych wariantów

Istniejące IIW/CR/RC scenariusze warto uzupełnić o zastosowania już wynikające z kontraktu: zniknięcie wybranego elementu przed fetch, przyjście do **tego samego** INBOX podczas długiej reconciliation, przerwę po durable acceptance przed enqueue, pending command przy disable/reconnect, label/folder rename lub usunięcie podczas pracy, granicę cutoff i imported mail. **Działanie:** przypisać je do istniejących invariantów, zamiast tworzyć nowe klasy priority/stany dla każdego wariantu. Nie są to testy wykonywane przez ten audyt.

### N-04. Dokumenty potrzebują jasnej hierarchii decyzji

Issue #5 zawiera starszą propozycję porównania Python/backend rewrite, sprzeczną z aktualnym zakresem użytkownika i Product Contract. ADR 0012–0015 są proposed, choć ich znaczna część istnieje w kodzie; ADR 0016 opisuje wcześniejsze fazy i P0/P1/P2. **Działanie:** przy późniejszej redakcji określić nadrzędność aktualnego kontraktu i rozstrzygnięć, a ADR traktować jako historyczne rationale z oznaczeniem accepted/proposed. Nie przenosić roadmap phase names do v2 work states. Ten audyt nie zmienia issue ani ADR.

## Verified strengths — potwierdzone mocne strony

| Założenie | Zweryfikowany dowód i praktyczna granica |
| --- | --- |
| Zachowanie stacku i ograniczenie rewrite do receiving | Composition rozdziela providers, receiver services, content, commands, SMTP/drafts. [worker.ts](../../src/composition/worker.ts), L89–126, L151–198. Nie ma dowodu uzasadniającego zmianę języka/backendu |
| Wake hint nie jest checkpointem | IDLE exists/flags/expunge tylko budzą pracę, [idle-watchers.ts](../../src/modules/mail/infrastructure/idle-watchers.ts), L174–176; periodic Delta/Gmail pollers i persisted progress naprawiają część luk. [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177) potwierdza charakter sygnału, nie durable log |
| Gmail account-wide history i osobne inventory | Baseline przed enumeracją, stagePage transactional guards, final checkpoint po unresolved-work check; sync service L417–445, L966–1050, L1087–1120. API [history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) potwierdza increasing IDs i expiry/404; nie są to ciągłe numery |
| Brak mass deletion na podstawie częściowej listy | Gmail inventory i inbox wykonują exact GET dla starych niewidzianych IDs, service L739–759, L891–928. Tombstone usuwa placements, pozostawia canonical message, projector L592–600. IMAP sprawdza absence i epoch przed removals, slice L175–193 |
| Native Gmail canonical identity i labels osobno | Partial unique index account/native-ID, schema L1025–1027; memberships L1185–1187; projektor aktualizuje istniejący UUID i nie usuwa canonical row przy label loss. Silniejsza podstawa niż heurystyki Message-ID |
| Revision fencing i idempotent replay mają implementację | Domain `assertAccountWork`, L56–72; Gmail provider publication L19–30; IMAP guarded persistence. Nie dowodzą same w sobie braku wszystkich stale-worker races, patrz M-09 |
| Quota accounting jest weighted i trwałe | Koszty endpoints zgodne z aktualną oficjalną tabelą; reserve ledger i clock po project lock. [gmail-client.ts](../../src/modules/accounts/infrastructure/gmail-client.ts), L84–95; quota L57–71, L161–200. Nie jest to rezerwa INBOX, patrz M-04 |
| Lazy body/attachments i lokalne drafts/outgoing | ADR 0011/0015 oraz content generation/attempt guards, [message-content-service.ts](../../src/modules/mail/application/message-content-service.ts), L227–310, L344–377. Zachowanie tych granic zmniejsza zakres przebudowy |
| UI propagation i uczciwe liczniki mają już wspólną podstawę | Publication snapshots i lokalne counts z coverage; [mail-publication-service.ts](../../src/modules/mail/application/mail-publication-service.ts), L120–182; DB trigger i browser polling. Nie ma potrzeby nowego event bus wyłącznie dla IF-008 |
| Audyt v1 nie udaje diagnozy incydentu | Poprzedni dokument jawnie określa zakres statyczny, brak live traffic i root-cause evidence. To poprawne zastrzeżenie, które należy zachować po doprecyzowaniu konkretnych ograniczeń |

## Zakres dowodów testowych i przyczyna incydentu

Przeczytane testy potwierdzają, jakie własności autorzy próbowali sprawdzić. Nie należy utożsamiać obecności testu z wynikiem jego uruchomienia teraz ani z kwalifikacją live.

| Materiał | Co rzeczywiście obejmuje | Czego nie dowodzi |
| --- | --- | --- |
| [sync-admission.integration.test.ts](../../tests/sync-admission.integration.test.ts), L128–261, L482–608 | Real pg-boss/PostgreSQL, claim/fairness/cross-queue exclusion, polling beyond 20, enqueue INBOX przed innymi | Faktycznego kosztu providerów, shared API quotas i wykonania pełnego bootstrapu IIW |
| [gmail-provider.integration.test.ts](../../tests/gmail-provider.integration.test.ts), L53–85, L674–873, L1295–1337 | Disposable PostgreSQL, pool=1 dla Gmail, synthetic HTTP, history expiry/staging/replay, recent-first | Deterministycznego newest-200 na Gmail live ani świeżej instalacji z rzeczywistą kolejką, OAuth i wszystkimi pollerami |
| Ten sam test, L873–899 | Wstrzyknięty staged backlog i `inventoryPhase=recent`, wykazuje interleaving history przed recentReady | Naturalnej chronologii cold start i opóźnień pierwszego history probe |
| [imap-resumable-sync.integration.test.ts](../../tests/imap-resumable-sync.integration.test.ts), L288–429, L488–612; [imap-resumable-sync.test.ts](../../tests/imap-resumable-sync.test.ts) | Durable replay/checkpoint failures, fixed horizon, epoch reset, admission i slices; provider fixtures | Realnych server limits, dat/moves/imports wszystkich IMAP, 5 s SLA oraz pool=1 całej IMAP composition |
| [message-commands.integration.test.ts](../../tests/message-commands.integration.test.ts), L237–432 | Idempotent flags, conditional conflicts, uncertain MOVE bez replay, wspólny mailbox lock | Przyjmowania read→unread podczas pending, które obecny producer odrzuca |
| [mail-publication.integration.test.ts](../../tests/mail-publication.integration.test.ts), L265–408; [deployment review](../validation/sync-priority-phase-4-deployment-review.md), L19–39 | MVCC snapshots, rollback/commit publications; opisane lokalne i synthetic workload measurements | End-to-end delivery SLA lub diagnozy live P2-before-INBOX |

**Niepotwierdzona hipoteza incydentu:** zależności discovery → recent inventory/P2 → eligibility, same-account exclusion, długie reconciliation, wspólny background budget i pending-command gating mogą tłumaczyć opóźnienia. Nie ustalono, który mechanizm wystąpił w obserwowanym przypadku. Worker startup order, liczba testów ani priorytet jednego joba nie są wystarczającym dowodem przyczynowym.

**Rekomendowana późniejsza reprodukcja:** tylko izolowana instalacja i dane testowe, osobno IMAP/Gmail; skorelowane czasy eligibility, admission, lock, pierwszego provider request INBOX, discovery, commit i UI publication; account revision, inventory/history phase, effective quota/backoff. Scenariusze cold start, ten sam INBOX z 15 000 zmian i co najmniej dwa konta. Odróżnić próbę, sukces reconciliation i materialization. Bez tego nie pisać „przyczyną jest scheduler/pg-boss”.

## Mapa ryzyk migracji i granica usuwania v1

| Element | Konkretny punkt styku | Ryzyko zmiany/usunięcia i działanie |
| --- | --- | --- |
| Accounts, Google/Microsoft OAuth | Domain transport routing L37–72; [google-oauth.ts](../../src/modules/accounts/infrastructure/google-oauth.ts), zapis `gmail_smtp`; generated `receive_transport` i ownership constraints w [0036](../../db/migrations/0036_military_daimon_hellstrom.sql) | Zmiana receiver nie może rekonstruować credentials ani zmienić OAuth subject/account. Wybrać obsługiwane legacy/native wejścia; nie używać domain inference lub niejawnego IMAP fallback |
| Message/mailbox UUID, memberships | Schema L1025–1038, L1129–1190; Gmail projector L325–399; IMAP persist L523–551 | Re-enumeration nie może tworzyć nowych Gmail UUID. Dla IMAP jawnie obsłużyć brak identity proof. Zmiana mailbox path/label name nie uzasadnia nowego UUID, jeśli trwały klucz został potwierdzony |
| Bodies, attachment locators, blobs i pins | Schema L179–241, L1256–1284, L1778–1797; content generations; [attachment-service.ts](../../src/modules/mail/application/attachment-service.ts) | Nawet gdy message row ocaleje, uszkodzenie source UID/epoch/part lub blob reference może uniemożliwić download/forward. Zachować zweryfikowany cached content i outgoing/draft pins; nie global purge/re-download |
| Pending/executing user actions | Schema L1290–1418; obaj command services; account revision | Wygaszenie starych jobów bez obsługi trwałych commands gubi zaakceptowaną intencję; blind retry niepewnego MOVE jest niebezpieczne. Zdefiniować adoption/cancel/re-observe z widocznym wynikiem |
| Outgoing i Sent-copy | [outgoing-message-service.ts](../../src/modules/mail/application/outgoing-message-service.ts), immutable MIME/status; Sent-copy L70–145; Gmail projector outgoing correlation | Receiver cut-over nie może ponowić uncertain SMTP ani APPEND. Odróżnić delivery od copy status, zachować snapshot i destinations już rozpoczętych operacji |
| Queues i durable receive progress | Versioned payloads; recent/delta/backfill continuations; Gmail state/work; sync admission policy | Stary worker może nadal publikować po uruchomieniu v2. Zdefiniować zatrzymanie starego consumer, revision/run fences i disposition zaległych jobów. Nie usuwać wspólnego pg-boss schema, gdy obsługuje sending/content/actions |
| Search/conversations/notifications/UI | Shared messages/placements, publication trigger 0042, [conversation-service.ts](../../src/modules/mail/application/conversation-service.ts) | Zmiana projekcji może zmienić counts, visibility, dedup i badges bez zmiany frontend kodu. Zachować authority i coverage; unikać ponownych powiadomień z history replay |
| DB authority, guard, restore i rollout | Native release guard; migration hashes; [native-schema-verification.ts](../../src/shared/infrastructure/database/native-schema-verification.ts); worker MFA lifecycle | Usunięcie guardu/constraints „dla uproszczenia” niszczy ochronę zgodności. Zaplanować upgrade i restore z binary/schema/blob namespace; zachować istniejące migration hashes i safety readiness |

Ta mapa nie zatwierdza migracji. Nie wolno wnioskować, że tabelę/lock/poller można usunąć, bo ma w nazwie „sync”: te same seams obsługują actions, attachments, Sent i UI publication.

## Czy projekt prowadzi do uproszczenia?

**Tak na poziomie granic produktu, jeszcze nie jako udowodniony projekt wykonawczy.** Brak obowiązkowego brokera poza PostgreSQL, lazy content i zachowanie reszty aplikacji ograniczają zakres. Wspólny product/persistence contract z różnymi IMAP/Gmail cursors jest lepszą podstawą niż imitowanie UID w Gmail.

Główne ryzyko to odtworzenie v1 w nowych nazwach: bootstrap phases × freshness states × coverage × recovery × command lifecycle, oddzielne P0/P1/P2 w admission i providerze, podwójne fairness counters i rozproszone retry clocks. Nie każdy wymiar prezentacji potrzebuje niezależnej state machine lub tabeli. W v1 te mechanizmy mają konkretne cele; usuwanie ich bez zastąpienia gwarancji też nie jest uproszczeniem.

Przy przeglądzie wariantów architektury wymagać uzasadnienia każdego trwałego pola, locka, pollera, kolejki i abstrakcji przez istniejący invariant lub konkretny crash gap. Odróżnić stan trwały od statusu wyliczanego dla UI. Zapisać jedno miejsce rozstrzygania eligibility/budget policy, pozostawiając provider-specific enumeration/identity. Porównać prosty, ograniczony cykl pracy z większą strukturą dopiero po sprawdzeniu starvation i crash scenarios. Nie wybierać tutaj algorytmu ani tworzyć universal resource unit.

Nie ma podstaw do wymagania nowego event bus, osobnej kolejki dla każdej fazy, brokerów, shadow message store, zmiany języka, cloud drafts lub API sending. Jeśli implementacja później ich potrzebuje, musi wskazać brakującą gwarancję i koszt prostszego wariantu.

## Gotowość i decyzje wymagające rozstrzygnięcia

**Gotowe do rozpoczęcia ograniczonego projektowania wariantów i planu pomiarów. Niegotowe do zatwierdzenia architektury, zamrożenia schematu ani rozpoczęcia implementacji.** Nie trzeba znać finalnego scheduler algorithm ani SLA przed pierwszym szkicem; trzeba jawnie zidentyfikować założenia i rozstrzygnąć C-01–C-04 przed uznaniem szkicu za zgodny z kontraktem. Runtime pozostaje TypeScript/Node.js.

1. Jaka instalacja jest wejściem upgrade: stable/main, native v1-final czy obie? Jakie dane/UUID/credentials muszą zachować tożsamość i jak działa rollback?
2. Co oznacza newest i 30 dni dla każdego providera; jakie tie-break i koszt selekcji są akceptowane?
3. Jaki jest zamrożony bootstrap reference oraz skończona granica reconciliation do READY? Co z remote missing/removed selected item i nierozwiązanym fetch?
4. Czy history gate wymaga pełnego READY, czy tylko materialization, i jak obejmuje inne foldery tego samego konta?
5. Czy historia ma wyłącznie conditional liveness przy leftovers, czy jawny udział pod stale pełnym INBOX demand?
6. Jaką możliwość wykonania mają pojedyncze zaakceptowane commands/content; jak bulk ustępuje INBOX bez globalnego pending-command gate?
7. Która definicja checkpointu obowiązuje: applied-only czy durable-intake z osobnym applied watermark? Co pozostaje replayable po cursor expiry?
8. Czy RC-009 zatwierdza nowe sequential acceptance; jak API/UI rozróżnia failure od uncertain remote outcome?
9. Jaka preservation/dedup jest gwarantowana dla IMAP bez MOVE mapping/OBJECTID i po UIDVALIDITY reset? Jak zachować lokalne referencje bez nieudowodnionego remote match?
10. Jak zapewnić świeże przyjścia w **tym samym INBOX** podczas długiego sweep/expiry recovery i uwzględnić provider/project/day limits, DB reservations, IDLE i commands?
11. Co pozostaje unsupported per transport, w tym IMAP bez MOVE i Gmail `maildock` Sent-copy; jakie minimalne adaptacje poza receiver są zatwierdzone?
12. Jakie workload, warunki zdrowego providera i p50/p95/p99/service-opportunity/UI/recovery targets będą mierzone? Jak uwzględnić existing MFA pause i zmienne provider limits?

W tym audycie wprowadzono wyłącznie niniejszy dokument. Trzy źródłowe dokumenty, kod, migracje, baza i konta pozostają bez zmian. Nie wykonano push, PR ani merge.
