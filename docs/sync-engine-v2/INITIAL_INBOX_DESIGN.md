# Initial Inbox Window — projekt selekcji

Data: 2026-10-11. Status: **propozycja do akceptacji; bez implementacji i kwalifikacji live**.
Podstawa: aktualny `sync-engine-v2`, [kontrakt v0.10](PRODUCT_CONTRACT.md), sekcje IIW/IS/BR/RA. Starsze audyty są materiałem dowodowym, nie nadrzędną decyzją produktu: [C-01/C-02/M-02/M-05](INDEPENDENT_REVIEW.md), [audyt v1](CONTRACT_REVIEW_AND_V1_AUDIT.md), [macierz](PROVIDER_CAPABILITIES.md).

## 1. Co jest zatwierdzone, a co proponujemy

30 dni / maksymalnie 200 / uzupełnienie do 50 pozostaje celem materializacji metadata, flag i membership. Nie pobieramy z tego powodu treści ani binarnych załączników. USABLE może poprzedzać dowód zakończenia selekcji. Historia tego konta rusza dopiero po ukończeniu i bezpiecznej materializacji selekcji, z wolnych zasobów; READY nie jest jej bramką. Wiadomości bieżące są obsługiwane niezależnie od limitu 200 — limit dotyczy **początkowej selekcji**, nie wszystkich lokalnych wierszy INBOX. [Kontrakt: IIW, IS-001–006, RI, RA](PRODUCT_CONTRACT.md).

Rekomendacja: IMAP **I-B: UID jako kolejność odkrywania z weryfikacją INTERNALDATE**, Gmail **G-B: zamrażany zbiór potwierdzonych kandydatów z ograniczonych zapytań**. To propozycje, nie deklaracja zgodności bez warunków. G-B wymaga decyzji P-02 o skończonej domenie selekcji; I-B może wymagać dużej liczby małych porcji zanim udowodni niedobór recent. Nie proponujemy ogólnej gwarancji globalnego top-200. [Decyzje P-01–04](DESIGN_DECISIONS_PENDING.md).

### Dokładna interpretacja liczb

Proponowana data odniesienia `W0` pochodzi z jednego zapisanego zegara PostgreSQL; `C = W0 − 30 × 24h`. Eligible recent ma `C <= internal timestamp <= W0`. Data nagłówka Date służy prezentacji, nie temu filtrowi. Daty przyszłe są odroczone do historii/normalnego sync, a nie uznawane za nowe przyjścia. To wymaga akceptacji P-01, ponieważ kontrakt pozostawia definicję daty otwartą.

Dla uzgodnionej domeny D, `R` oznacza potwierdzone recent, `O` starsze; docelowa liczba:

| Liczba recent w D | Wynik |
| --- | --- |
| >=200 | 200 recent według uzgodnionej kolejności selekcji |
| 50–199 | wszystkie recent, bez starszych |
| 0–49 | wszystkie recent + do `50 − |R|` starszych, jeśli istnieją |
| INBOX pusty | brak wiadomości, ale selekcja może być ukończona i READY osiągnięte bez USABLE |

Tie-break prezentacji/kandydatów: IMAP `(INTERNALDATE desc, UID desc)` w jednej epocie; Gmail `(internalDate desc, native id leksykograficznie asc)`. Native ID nie koduje czasu. I-B odkrywa po UID desc, więc nie realizuje globalnego sortu po dacie. G-B sortuje tylko rozpoznany zbiór. Równe daty nie uzasadniają rozszerzenia wyniku ponad 200.

Usunięty/przeniesiony wybrany element kończy się potwierdzonym terminalnym wynikiem, nie sztucznym wierszem INBOX. **Nie dobieramy w nieskończoność zastępstw po zamrożeniu selekcji**. Liczba aktualnie widocznych wiadomości może wtedy spaść poniżej 50/200: to skutek authority i BR-T03, nie rezygnacja z fallbacku. Przed zamrożeniem uzupełniamy z tej samej domeny, po nim zmiany należą do reconciliation. [Bootstrap §2–5](BOOTSTRAP_AND_READY_DESIGN.md).

## 2. Dowody i ograniczenia obecnego kodu

| Dowód | Własność / granica |
| --- | --- |
| [IMAP executeImapSlice](../../src/modules/accounts/infrastructure/imap-sync-slice.ts), `selected`, `search`, fazy messages/reconcile | v1 zamraża UIDNEXT−1, skanuje UID rosnąco z SINCE, pobiera ograniczone grupy; nie wybiera top-200/fallback |
| [ImapSliceSyncService](../../src/modules/mail/application/imap-slice-sync-service.ts), `selected`, `completed` | cutoff i JSON progress są trwałe, recent success nie dowodzi pełnej reconciliation |
| [IMAP normalizeMessage](../../src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts) | wymagane INTERNALDATE/size, BODYSTRUCTURE i opcjonalne EMAILID; nie dowód dedup po EMAILID |
| [GmailClient](../../src/modules/accounts/infrastructure/gmail-client.ts), `messages`, `message`, `history`, `GMAIL_QUOTA_COST` | list <=100, query q, Spam/Trash true, bez labelIds w interfejsie; full z ograniczonym fields zachowuje strukturę bez body data |
| [GmailSyncService](../../src/modules/mail/application/gmail-sync-service.ts), `bootstrap`, `inventory` | baseline przed inventory, recent account-wide po after; nie INBOX 30/200/50 |
| [testy IMAP](../../tests/imap-resumable-sync.integration.test.ts), przypadki fixed horizon/replay | dowodzą zakresu fixture, nie kolejności INTERNALDATE na serwerach |
| [testy Gmail](../../tests/gmail-provider.integration.test.ts), staging/expiry/repeated cursor | syntetyczne strony nie dowodzą stabilności Gmail live |

Przeczytane [ADR 0004](../adr/0004-postgresql-background-jobs-with-pg-boss.md), [0008](../adr/0008-initial-sync-and-mail-storage-policy.md), [0011](../adr/0011-progressive-mail-storage-without-retained-incoming-raw-mime.md), [0012](../adr/0012-native-gmail-receive-transport.md), [0013](../adr/0013-gmail-message-identity-and-label-membership.md), [0014](../adr/0014-gmail-account-history-and-progressive-sync.md), [0015](../adr/0015-gmail-smtp-first-and-local-drafts.md), [0016](../adr/0016-synchronization-priority-and-local-count-contract.md) zachowują rationale lazy content, native identity i pg-boss. Dawne configurable recent/P0 burst/obowiązek raw MIME nie zastępują v0.10; ADR 0008 jest superseded, 0012–15 proposed. Sending/drafts są poza tym projektem.

## 3. IMAP — dwa realistyczne warianty

### I-A: globalna selekcja po INTERNALDATE

Po EXAMINE zapisz `(UIDVALIDITY E, H0=UIDNEXT−1, W0)`. Każde zapytanie ma jawny zakres `1:H0`; gdy H0=0 nie wysyłaj zakresu `1:0` (IMAP odwraca zakresy). UIDs nie są ciągłe. APPEND może zachować starą datę, ale nowe UID będą poza H0. [RFC 9051 §2.3.1.1, §6.3.12, §6.4.4](https://www.rfc-editor.org/rfc/rfc9051).

Z SORT: UID SORT ARRIVAL zwraca kolejność dat wewnętrznych, DATE dotyczy daty wysłania i jest niewłaściwe. Zwykły SORT zwraca cały wynik, nie limit 200. Wziąć ostatnie/najnowsze IDs, pobrać daty przy granicach i metadata do 200. Native tie-break SORT to sequence number, REVERSE ARRIVAL nie odwraca automatycznie remisu; jawnie stosować własny tie-break po UID w grupie równych dat. Trzeba rozpoznać całą grupę graniczną, jeśli ma znaczenie dla dokładnego rankingu. [RFC 5256 §3](https://www.rfc-editor.org/rfc/rfc5256).

Bez SORT: UID SEARCH + małe FETCH `(UID INTERNALDATE)` dla wszystkich kandydatów, utrzymanie top-200 lokalnie, potem pełne metadata wybranych. SINCE nie filtruje godzin/stref: jest tylko filtrem szerokim. Aby uzyskać UTC przedział, poszerzyć daty co najmniej o dzień z obu stron i sprawdzić rzeczywisty timestamp; błędne/nietypowe daty wymagają jawnego retry/odroczenia, nie dowodu kompletności. Exact ranking starszych do 50 także może wymagać przeglądu całej starszej populacji. [RFC 9051 §6.4.4](https://www.rfc-editor.org/rfc/rfc9051).

Zaletą jest dokładny ranking **obserwowanej** populacji ograniczonej UID; nadal nie snapshot membership z T0 (expunge może nastąpić podczas skanu). Wadą jest czas server-side search/sort i payload O(N) IDs/dat. Można wcześniej pokazać osobny mały provisional batch, ale to dodatkowa praca, nie dowód ukończenia I-A. Opcjonalne rozszerzenia ograniczające wyniki wymagają osobnej kwalifikacji adaptera; nie zakładamy ich obecności.

### I-B: od końca UID, daty weryfikowane, wynik bounded

1. Trwale zamroź E/H0/W0. Odkrywaj **malejące, liczbowe przedziały UID**, np. span 1024 jako punkt benchmarku, nie approved default. SEARCH danego przedziału nie może zwrócić więcej niż span UID. Nie używaj `*` jako zamrożonego końca.
2. Pobieraj małe grupy date-only/metadata, np. 20. Sprawdzaj C/W0, odkrywanie recent według UID desc, sort na ekranie po dacie. Pierwszy poprawny batch commit daje USABLE. Osobno przechowuj do 50 starszych kandydatów jako rezerwę fallback; nie licz ich jako finalized recent.
3. Zakończ recent, gdy jest 200 potwierdzonych eligible IDs albo skan `1:H0` wyczerpany. Samo znalezienie 50 starszych i 20 recent **nie** dowodzi, że w niskich UID nie ma kolejnych 120 recent. Jeżeli recent wyczerpany i <50, pobierz brakujące starsze w kolejności UID desc; nie musisz ustalać globalnego top po dacie, ale ta kolejność wymaga P-02.
4. Zapisywanie kandydata + przesunięcie granicy odkrywania jest atomowe; nieznane FETCH po SEARCH pozostaje pending, brak musi być potwierdzony w tej samej epoce. Restart wznawia przedział/grupę, nie nową datę W0. Zakończona selekcja zapisuje listę wybranych i terminalne wyniki, nie sam licznik.

Wariant prosty bazuje na capabilities już używanych przez adapter. Daje niski koszt **jednej porcji**, nie uniwersalnie mały koszt **całego dowodu selekcji**. Przy nietypowych datach skan może odwiedzić wszystkie przedziały; sparse UID aż do 2³²−1 są najgorszym przypadkiem. Adaptacyjne większe puste przedziały oszczędzają round-trip, lecz zwiększają potencjalny rozmiar odpowiedzi; pełny SEARCH ma O(N) wynik i nie jest bezkosztowym wyjściem. Operacyjny ceiling zatrzymuje/retry selekcję, a nie pozwala ogłosić complete. Zmiana na „sample z tail UID” jest alternatywą wymagającą P-02/P-04.

Wczesne stare wiadomości mogą być provisional USABLE gdy recent nieznane; ich finalna klasyfikacja jest deferred/history, jeśli znajdziemy >=50 recent. Do 200 finalnych initial IDs; UI uczciwie rozróżnia provisional od finalized i nie usuwa zachowanego metadata/cache wyłącznie dla poprawienia liczby. Nie obiecujemy, że finalny zbiór = pierwsza strona UI.

### Koszt IMAP

Nie ma uniwersalnej quota jednostek IMAP. Liczymy komendy, round-trip, liczbę zwróconych IDs/dat/metadata, zajętość połączenia i czas serwera osobno.

| Wariant | Odkrywanie | Materializacja | Najgorszy przypadek |
| --- | --- | --- | --- |
| I-A z SORT | EXAMINE + 1–2 SORT/SEARCH; O(N) IDs, nieznany koszt serwera | `ceil(S/b)` FETCH metadata + weryfikacje dat/remisów/absence | pełny sort dużego INBOX przed dowodem; nie limit 200 kosztu serwera |
| I-A bez SORT | `ceil(N/b)` date-only FETCH + SEARCH | do 200 metadata | O(N) dat; fallback może objąć 50k starszych |
| I-B | K SEARCH przedziałów + `ceil(D/b)` bounded FETCH dla D kandydatów | <=200 finalized metadata; provisional może dodać koszt | K do `ceil(H0/span)`, D do N; UID sparse/importy, nie O(200) |

Przykład I-B: 200 recent w ostatnich 1024 UID => 1 SEARCH i około 10 FETCH grup po 20 + EXAMINE/epoch checks. 20 recent i 100 starszych, ale dates rozproszone po całym UID horizon => dowód 20 wymaga wyczerpania zakresu, nawet jeśli pierwszych 50 pokazano szybko. Połączenia IDLE, mutation, content i authority DB wchodzą do budżetu; nie wolno zajmować wszystkich sesji długim SORT. Timeout nie dowodzi wyczerpania zbioru.

## 4. Gmail REST — dwa realistyczne warianty

### G-A: pełna enumeracja i ranking po internalDate

Zapisz W0 i H0 (account history baseline przed listowaniem), zapytaj messages.list dla INBOX oraz przedziału dat, deduplikuj IDs, GET daty i aktualne labelIds, utrzymuj top-200 po internalDate. Fallback: jeżeli recent rzeczywiście wyczerpany i <50, enumeruj starszych, GET daty, dobierz do 50. Używaj sekund epoch w q, z marginesem granicy sekundy, potem dokładny filtr ms z GET; nie używaj względnego newer_than:30d zmieniającego się po restarcie. [Filtering](https://developers.google.com/workspace/gmail/api/guides/filtering), [Message.internalDate](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).

messages.list nie daje dat, parametrów sort ani snapshot tokenu; resultSizeEstimate jest oszacowaniem, nie dowodem wyczerpania. Wyczerpanie paginacji plus replay history naprawia zmiany poznanych IDs; nie stanowi ogólnego dowodu kompletnej membership listy z T0 na niestabilnych stronach. H0 nie jest parametrem snapshot messages.list, a historyId wiadomości to ostatnia zmiana, nie data jej utworzenia. List query po czasie nie wyklucza backdated importu po T0. Ten wariant daje dokładny top rozpoznanego zbioru i koszt O(N), ale nie obietnicę historycznego snapshotu. [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

### G-B: skończony zbiór receiptów, recent najpierw, fallback jawny

Proponujemy zamrażać **tożsamości faktycznie odkryte**, nie wymyślony Gmail snapshot z W0. Preferowane zapytania obejmują INBOX i kolejne stałe przedziały dat od W0 wstecz do C; q jest wskazówką odkrywania, GET.internalDate weryfikuje eligibility. Granice query poszerzamy o sekundę i deduplikujemy. Nie zakładamy, że każde query jest idealnym filtrem internalDate bez kwalifikacji importów/dat — P-01. Istniejący client wymaga przyszłego wystawienia labelIds lub pozostania przy `in:inbox`, bez zmiany OAuth scope na gmail.metadata (nie pozwala q).

1. Pierwszy mały list/GET batch daje USABLE. Za każdym razem trwale stage IDs **razem** z nextPageToken/parametrami query. Nie sortuj pierwszej strony, nazywając ją globalnym top.
2. Kandydaci z kolejnych recent zapytań są weryfikowani GET, deduplikowani, klasyfikowani current INBOX/removed/missing. Materializuj max200 recent w rozpoznanej domenie, wcześniej wyświetlaj małe grupy. Chronologicznie malejące **zapytania datowe** ograniczają zależność od nieudokumentowanej kolejności listy, ale pojedynczy gęsty przedział nadal może mieć wiele stron.
3. Jeżeli recent zapytania zostały wyczerpane i potwierdzono <50 recent, przejdź do starszych zapytań, do 50 total albo wyczerpania. Fallback nie jest „pierwsze 50 z całego konta”. Obejmuje tylko INBOX; identyczne timestampy deduplikujemy po ID, nie po czasie.
4. Proponowany **łączny limit odkrytych kandydatów**, np. 500 GET / 5 stron po 100 jako wariant pomiarowy, tworzy skończoną domenę D. Dopiero akceptacja P-02 pozwoli zakończyć selection według tej domeny. Jeśli limit minął i liczność/fallback nadal nieustalone, obecny kontrakt IS-004 wymaga pozostawić selection pending; nie oznaczamy READY na podstawie exhaustion budżetu.
5. Zamrożony finalny manifest D/S nie rośnie od kolejnych arrivals. Nowe messagesAdded/INBOX labelAdded idą przez current sync. Import discovered po W0 może być w D, jeśli spełnia datę; to jawna obserwowana kohorta, **nie** deklaracja membership at T0. Eliminacja post-T0 imports na podstawie kompletnego replay wymaga dodatkowej pracy; samo historyId z GET nie wystarcza.

Rekomendacja P-02: dopuścić bounded observed cohort dla Gmail, z zachowaniem celu 30/200/50 i niewyczerpanym fallbackiem jako blokadą, kiedy <50 total nie jest potwierdzone. Po akceptacji można uznać 200 distinct verified recent za zakończenie bez globalnego rankingu; jeżeli jest 50–199, wymagane jest wyczerpanie uzgodnionych recent queries lub wyraźna zgoda na sample. **Nie rekomendujemy** reguły „50 dowolnych = complete” ignorującej potencjalne 120 recent. Universal low total cost + dokładna liczność + stabilny T0 snapshot pozostają niewykazane.

### Wznowienie i wadliwe strony

Manifest, query/bucket, page token, dedup IDs i terminalne wyniki są w PostgreSQL. Restart nie przesuwa W0/C/H0. Invalid/repeated token: restart danego query z zachowaniem receiptów i dedup, nie masowe usunięcie danych. Limit prób/page budget kończy porcję widocznym pending/error. Po crash przed staging powtórzona strona może być inna: nie udajemy odzyskania identycznej remote strony; utrwalona część kohorty pozostaje stabilna. Dla manifestu już finalnego nie wznowimy discovery, tylko unresolved items/reconciliation. [GmailSyncRepository.stagePage](../../src/modules/mail/infrastructure/gmail-sync-repository.ts) ma transactional token/run guards i fragment digest; to przydatna własność, nie gotowa selekcja v2.

### Koszt Gmail

Według sprawdzonej 2026-10-11 [tabeli quota](https://developers.google.com/workspace/gmail/api/reference/quota): list=5, GET=20, history.list=2, profile=1, labels.list/get=1. `Q = 5L + 20G + 2P + A`, gdzie L to **wszystkie** list requests (także puste buckety), G wszystkie GET, P history pages, A discovery/profile/counters. Każdy retry kosztuje ponownie; HTTP batching nie usuwa kosztu indywidualnych GET. Liczby poniżej nie zawierają T1 reconciliation, retries ani content.

| Przypadek | Requesty / koszt |
| --- | --- |
| 200 IDs, 2 strony po 100, po jednym GET | 202 requests, 4010 units + A |
| 50 IDs, 1 list + 50 GET | 51 requests, 1005 units + A; recent/fallback queries mogą dodać strony |
| G-B próba do 500 kandydatów, 5 pełnych stron | 505 requests, 10025 units + A; osobne date buckets/puste listy dodają 5 każda |
| G-A 50k IDs, 100 stron po API max500 + GET wszystkich dat | 50100 requests, 1000500 units + A; obecny client max100: 500 stron, 1002500 units + A |
| Brak recent w dużym starym INBOX | G-B może znaleźć 50 szybko, ale nie gwarantuje newest50; G-A pełny ranking może kosztować jak wyżej |

API maxResults=500 to możliwość protokołu, adapter ma 100. Koszty nie dowodzą czasu wykonania. Effective user/project quota i local daily ceilings są osobnymi ograniczeniami; po zmianach Google z maja 2026 projekty mogą mieć różne limity. Nie dziedziczymy wspólnego background 70% jako rezerwy current-INBOX. [gmail-quota.ts](../../src/modules/mail/infrastructure/gmail-quota.ts), [kontrakt RA-06/08](PRODUCT_CONTRACT.md).

## 5. Scenariusze i decyzje przed akceptacją

| Scenariusz | Obowiązkowe zachowanie |
| --- | --- |
| Imported old date + wysoki UID / nowe Gmail ID | data nie staje się recent od nowego ID; current arrival nadal obsługiwane, deferred import zachowany do historii |
| Recent z niskim UID | I-B nie obiecuje globalnego top; <200 dowód wymaga dalszego skanu, nie cutoff po UID |
| 1000 identycznych timestampów | tie po locatorze; do200, bez dedup po timestampie; Gmail nie przesuwa cutoff wyłącznie do ostatniej daty strony |
| 20 recent, 100 older | docelowo50; nie wolno uznać 20 za complete tylko z powodu limitu kosztu |
| 120 recent | 120 finalnych, nie 50 dowolnych; sample wymaga decyzji |
| Usunięcie po zamrożeniu S | terminal absent/removed, bez resurrection i bez nieskończonego replacement loop |
| Restart / token invalid | zachowaj utrwalone S i postęp, replay bez duplikatów; unknown pozostaje unknown |
| Przyjścia w czasie selection | current path działa od T0; S nie rozszerza się od live arrivals |

**Konflikt wymagający akceptacji:** na dowolnym IMAP/Gmail nie wykazano jednocześnie stałego małego całkowitego kosztu, exact global top200, exact fallback newest50 i stable snapshot membership. Kontrakt akceptuje kompromis rankingu, lecz nie każdy stopping rule. P-01 definiuje datę; P-02 domenę/ordering/complete; P-04 reakcję na ceiling. Bez tych decyzji to projekt do krytycznego przeglądu, nie gotowy algorytm produkcyjny. [READY/handoff](BOOTSTRAP_AND_READY_DESIGN.md), [checkpoint](CHECKPOINT_DESIGN.md).
