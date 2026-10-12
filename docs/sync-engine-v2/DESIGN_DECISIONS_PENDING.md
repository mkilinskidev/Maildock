# Decyzje oczekujące — Initial Inbox / READY / checkpoint

Data: 2026-10-11. Status: **lista do zatwierdzenia projektu; bez zgody na implementację**.
Nadrzędne źródło: [PRODUCT_CONTRACT v0.10](PRODUCT_CONTRACT.md). Dokument zawiera wyłącznie szczegóły/kompromisy jeszcze nieustalone przez kontrakt. Rekomendacja nie jest przyjętą decyzją. Szczegóły: [Initial Inbox](INITIAL_INBOX_DESIGN.md), [Bootstrap/READY](BOOTSTRAP_AND_READY_DESIGN.md), [Checkpoint](CHECKPOINT_DESIGN.md).

## P-01 — Data, cutoff i deterministyczne remisy

**Problem:** 30 dni i „newest” nie określają wewnętrznego timestampu, UTC rolling window, inclusive granicy ani importów. IMAP SINCE ignoruje godzinę/strefę; Gmail query ma sekundowe granice i nie należy bez kwalifikacji utożsamiać wszystkich imported query matches z internalDate.

**Opcje:** (A) internal timestamps i dokładny rolling UTC interval; (B) kalendarzowe dni providera; (C) Date header jako kryterium produktowe.

**Rekomendacja Codexa:** A: zapisać W0/C raz, `C <= INTERNALDATE/internalDate <= W0`; data nagłówka służy prezentacji. Poszerzone provider queries + exact local check. Remisy: IMAP UID desc w epoce, Gmail native ID leksykograficznie asc. Przyszłe/backdated imports pozostają history/current eligible, nie fałszują recency.

**Konsekwencje:** jednorodna interpretacja produktu i powtarzalne wznowienie; query boundary i imported dates wymagają live qualification. UID ordering odkrywania nadal nie jest ordering dat. Szczegóły/koszt: [Initial Inbox §1–4](INITIAL_INBOX_DESIGN.md).

## P-02 — Domena i skończony stopping rule przy ograniczonym odkrywaniu

**Problem:** kontrakt pozwala przybliżenie globalnego top-200, ale nie definiuje zakończenia provider-specific selekcji. Z limitu 200 wyników nie wynika limit discovery. Znalezione 20 recent i 50 old nie dowodzą, że poza zbadanym zbiorem nie ma 120 recent. Gmail list nie daje stable T0 snapshot, a backdated imports przechodzą frozen date query.

**Opcje:** (A) wyczerpująca selekcja/pełny ranking; koszt O(N), w Gmail nadal bez uniwersalnego snapshot proof; (B) provider-specific bounded cohort, date verified i deterministic recorded manifest, jawna zgoda na sampling; (C) bounded porcje i early USABLE, lecz brak hard ceiling całego discovery — selection pending aż do 200 recent lub uzgodnionego exhaustion/fallback.

**Rekomendacja Codexa:** dla IMAP I-B/C: tail UID discovery, date verification, 200 recent albo exhaust frozen H0, fallback do 50 po dowodzie niedoboru. Bez globalnego chronological rank. Dla Gmail G-B/B: uzgodnić observed receipt cohort i fixed date queries, dopuścić zakończenie po 200 verified recent; dla 50–199 wymagane exhaustion uzgodnionej domeny, dla <50 faktycznie uzupełnić do 50 lub potwierdzić brak dostępnych. Jeżeli domena zostanie ograniczona sample ceiling, jawnie zatwierdzić konsekwencję „można pominąć recent poza sample”; bez tej zgody ceiling nie jest completion. Nie uznawać 50 dowolnych za zamiennik 120 recent.

**Konsekwencje:** tanie pierwsze wyniki, deferred mail do historii, brak exact global top/snapshot promise. W IMAP niski UID/sparse/import może dać długi discovery przed selectionComplete; w Gmail bounded list receipts nie pozwalają obiecać wszystkie T0 members. Bez akceptacji B lub dalszego dowodu C **architektura Gmail finite selection nie jest zatwierdzalna**. Fallback minimum nie może zostać po cichu zniesione. [Warianty i konflikt](INITIAL_INBOX_DESIGN.md).

## P-03 — Znaczenie T1/certyfikatu dla base IMAP i minimum capabilities

**Problem:** zwykły IMAP ma UID horizon, ale nie ma persistent event log flag/expunge ani atomic multi-message snapshot. Scalar MODSEQ na serwerze bez capabilities byłby zmyślony. Literalny „wszystkie zmiany w całym INBOX do jednego wall-clock T1” może wymagać nieistniejącej własności.

**Opcje:** (A) zaakceptować scoped finite observation vector dla S/known materialized keys + fixed arrival horizon; późniejsze zmiany danego key naprawia continuous recheck; (B) wymagać kwalifikowanego persistent CONDSTORE/QRESYNC i określić degraded/unsupported bootstrap dla innych; (C) wait-for-quiet/global rescan jako gate — niezgodne z ciągłymi arrivals, odrzucić.

**Rekomendacja Codexa:** A z jawną informacją, że to current-state convergence/certificate, nie account change log; B jako opcjonalna optymalizacja. Reobserve required keys, nie infer flags ze STATUS; continuous known-key sweeps trwale active po T1. Nie reklamować samego arrival UID jako applied flags/removals.

**Konsekwencje:** obsługa base IMAP i finite READY bez globalnej atomowości; późniejsze flag changes mogą już istnieć przy completed milestone. B daje silniejszy replay zmian w kwalifikowanym scope i ogranicza obsługiwane serwery, ale samo QRESYNC także nie obiecuje atomic snapshot wszystkich wiadomości. Wymóg takiego snapshotu wymagałby dalszego dowodu możliwości protokołu, nie tylko wyboru B. [Bootstrap §4](BOOTSTRAP_AND_READY_DESIGN.md), [Checkpoint §2](CHECKPOINT_DESIGN.md).

## P-04 — Operacyjne ceilings i koszt discovery/retry

**Problem:** nawet bounded slices mogą w sumie odpytać miliony sparse UID intervals albo tysiące Gmail stron. Kontrakt nie określa page/candidate/request timeout ceilings, retry budget ani akceptowanego czasu selection pending. Hard cost ceiling może utrudnić completion/fallback.

**Opcje:** (A) małe porcje bez hard total limit, do provider-appropriate exhaustion; (B) total ceiling daje widoczny pending/degraded, retry/continuation i diagnostykę, bez false complete; (C) ceiling kończy bootstrap częściowym sample — wymaga osobnej P-02 zgody.

**Rekomendacja Codexa:** B jako zabezpieczenie operacyjne, nie terminal success; ustalić limity po kwalifikacji. Wartości span 1024 / batch 20 / Gmail 500 candidates / 5 pages są **próbami do benchmarku**, nie zatwierdzonym tuningiem. Osobno quota units per user/project/local day, IMAP command latency/payload/connection occupancy i DB authority budget.

**Konsekwencje:** ochrona przed nieograniczonym zasobowo discovery i retry storms; duży/niestandardowy INBOX może mieć długie visible pending. Nie ma bezwarunkowego terminu READY. Konkretne fairness/reservation percentages/full scheduler pozostają poza tym etapem. [Koszty](INITIAL_INBOX_DESIGN.md), [resource seams](BOOTSTRAP_AND_READY_DESIGN.md#5-same-folder-arrivals-i-zasoby).

## P-05 — Kwalifikacja granic i progi akceptacyjne przed implementacją

**Problem:** statyczny kod i RFC nie potwierdzają zachowania wszystkich live providers, Gmail finite-target traversal pod mutation, query/internalDate imports, wydajności reserved authority lub foreground opportunity w realnych limits. Istniejące fixtures nie obejmują kompletnie projektowanej selekcji i same-folder arrival bypass.

**Opcje:** (A) controlled synthetic fault qualification + autoryzowane odrębnie live staging workload; (B) polegać wyłącznie na dokumentacji/obecnych unit tests; (C) zawęzić initial provider capability support do już kwalifikowanych serwerów/projektów.

**Rekomendacja Codexa:** A, z C jeśli nie da się udowodnić konkretnej ścieżki. Uzgodnić workload/date/import cases, effective quota/connection configuration i mierzalne p95/p99 service opportunity/detection/materialization/UI targets. Sprawdzić history traversal `(C,H1]` do pierwszego >H1/EOF, changed/expired tokens, fragment >500, loss session po remote read, unknown no-effect i 15k removals w tym samym INBOX podczas arrivals/user actions.

**Konsekwencje:** dowody konieczne do zatwierdzenia implementacji; 5 s IMAP / 30 s Gmail z kontraktu nadal provisional, nie nowe SLA. Żadnych operacji na kontach, DB czy testów destrukcyjnych nie autoryzuje ten dokument. [Acceptance i crash matrix](BOOTSTRAP_AND_READY_DESIGN.md#8-scenariusze-akceptacyjne-do-przyszlej-walidacji), [Checkpoint §6](CHECKPOINT_DESIGN.md).

## Decyzje już rozstrzygnięte — nie wymagają ponownego pytania

Nie wracamy do fresh-only launch MI, TypeScript/Node.js, lazy bodies, PostgreSQL/pg-boss bez nowej infrastruktury, protected individual actions/current-INBOX, conditional history leftovers, USABLE≠READY, fixed T1, braku unresolved selected items przy READY, historii eligible po completed materialized selection ani approved sequential intents RC-009. Ścisły applied-only checkpoint jest rekomendowaną zgodną interpretacją IF-004; proponowana redakcja CR-001/IF-004 w [Checkpoint §1](CHECKPOINT_DESIGN.md) usuwa sprzeczność bez zmiany tych gwarancji. Pełny scheduler, DDL i release runbook są przyszłą pracą, nie nową listą decyzji produktowych w tym zadaniu.

## Self-review zestawu dokumentów

| Pytanie użytkownika | Wynik przeglądu |
| --- | --- |
| Czy spełnia v0.10 bez ukrytych zmian? | Zatwierdzone USABLE/READY/history/RA/MI respektowane; P-01–03 oznaczają wymagane szczegóły/kompromisy, nie przyjęte nowe wymagania. W pełni zatwierdzalny projekt zależy od ich rozstrzygnięcia |
| Czy capabilities są rzeczywiste? | Base UID/SEARCH/FETCH, optional SORT/CONDSTORE/QRESYNC; Gmail list bez sort/snapshot/endHistoryId; wyraźnie oddzielone od obecnego adaptera |
| Czy obiecuje universal stable IMAP UUID? | Nie; epoch/move identity tylko z proof, cached references oddzielne od remote identity |
| Czy checkpoint jest pomieszany z historią/stagingiem? | Trzy niezależne wskaźniki; zero pending required effects dla applied C; scoped base IMAP certificate jawny |
| Czy READY osiągalne przy arrivals? | Required domain/target nie rosną po freeze; arrivals bypass drain. Provider health, valid reference, accepted selection rule i execution opportunity są warunkami; brak unconditional gwarancji przy capacity exhaustion |
| Czy first mail poprzedza full reconciliation? | Commit first batch daje USABLE; READY atomowo po proof, empty inbox wyjątek |
| Czy historia blokuje ten sam INBOX? | Bounded authority + independent current probes/materialization; frozen cleanup cursor nie determinuje całego wyboru pracy |
| Czy quota/connections pominięto? | Koszty weighted GET/list/history, local day i shared quotas; DB authority/pool1/IDLE/content/actions opisane; tuning nie zmyślony |
| Czy prostsze od v1? | Jeden durable eligibility model, scoped bounded authority, receipts i trzy osobne postępy; brak brokerów, private queue SQL, lease heartbeat, shadow mail, enum per phase/job per item |
| Dowód wykonania / granice | Statyczne czytanie kodu/testów/DDL i oficjalnych specs; brak runtime/live/destructive tests. Nie twierdzimy, że prototyp istnieje lub SLA zmierzono |

Self-review wskazał istotny nieusuwalny samą dokumentacją trade-off: provider-neutral gwarancja małego total discovery cost, dokładnego global top200/fallback oraz atomic T0 membership snapshot nie została udowodniona. Ten zestaw służy właśnie wyborowi kompromisu przed pierwszą linią implementacji.
