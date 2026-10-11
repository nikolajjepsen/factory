# AI-fabrikken – designdokument

Oct 11, 2026 · @Nikolaj

## Formål og principper

Fabrikken bygger logens app (socialt netværk, begivenheder, galleri, økonomi) autonomt. Nikolaj sætter mål, krav og accept, og agenterne står for analyse, spec, kode, test, review og dokumentation.

- **Mennesket ejer *hvad* og *hvornår det er godt nok*.** Vision, prioritering, beslutninger i Decision Briefs og merge.
- **Roller er faste, motorer kan skiftes.** Ingen leverandør er hårdkodet i flowet.
- **CI er den neutrale dommer.** Tests, typer og lint afgør, om noget er færdigt, ikke modellens selvtillid.
- **Alt er synligt og kan overrules.** Status, kø og kvote kan ses, og fabrikken kan stoppes fra telefonen.
- **Autonomi skrues op gradvist.** Først med menneskelig merge-gate, senere auto-merge af små ændringer.
- **Kedelig stack.** Det, agenterne kender bedst: Next.js + TypeScript + Supabase.

## Arkitektur

Agenterne kører på Nikolajs egen maskine, og CI kører i skyen. Codex-abonnementet er personligt, så det bliver der, hvor han er logget ind.

- **GitHub** er rattet: issues, Project-board, PR'er, sub-issues og ChatOps-kommentarer.
- **Factory-daemon** (lille Node-proces lokalt) poller boardet, laver et git worktree pr. opgave, kører den rigtige runner og pusher resultatet.
- **CI** (GitHub-hosted runners) kører lint, typecheck, unit- og e2e-tests og preview-deploy. Den har ikke brug for AI.
- **Dashboard** serveres af daemonen lokalt og læser den samme status, som skrives til GitHub.

### Repo-struktur

```
ai-factory/                 fabrikkens eget repo (installeres én gang)
  daemon/                   kø, tilstandsmaskine, heartbeat, kvote
  runners/                  codex (app-server), claude (CLI), …
  agents/baseline/          generalister: analyst, spec, planner, implementer, reviewer, tester, docs
  dashboard/                kontrolrummet
  templates/                decision-brief, spec, adr, issue
  projects.yml              tilkoblede projekter

<projekt>/                  fx loge-app
  .factory/project.yml      tjek-kommando, runners pr. rolle
  .factory/agents/          projekt- og domæneagenter (valgfrit)
  AGENTS.md                 projektets grundlov (CLAUDE.md → @AGENTS.md)
  docs/vision.md  docs/adr/  specs/
```

### Flere projekter og agent-lag

Fabrikken er projektagnostisk. Den ejer motoren, og hvert projekt ejer sin egen viden.

- **Agent-arv:** `baseline/implementer` → `<projekt>/implementer` → domænespecialist (fx `galleri`). En agent er en fil med `extends`, `scope` (labels), `context` og evt. `runner`. Se `docs/agents.md`.
- **Routing:** planneren sætter `area:`-labels. Daemonen vælger den mest specifikke agent, der matcher, og falder ellers tilbage til baseline.
- **Læring:** gentagne review-fund i et domæne bliver til en PR mod specialistens fil, som Nikolaj godkender.
- **Portefølje:** `projects.yml` lister projekterne. Boardets rækkefølge er prioriteten på tværs af dem. `focus` låser fabrikken til ét projekt, og hvert projekt kan tændes og slukkes. Projekterne er isoleret med egne worktrees og secrets.

## Leverandørneutralitet

Rollerne er faste, og motoren vælges pr. rolle i `factory.yml`. Codex er primær motor nu. Claude og andre kan tilføjes som nye runners uden at ændre flowet.

```yaml
roles:
  analyst:     { runner: codex }
  planner:     { runner: codex }
  implementer: { runner: codex }
  reviewer:    { runner: codex-cloud }   # @codex review; senere evt. claude
  docs:        { runner: codex }
limits:
  max_fix_iterations: 3
```

- **AGENTS.md er grundloven.** Codex læser den direkte, og Claude Code via `@AGENTS.md` i CLAUDE.md. Konventioner, stack og forbud står ét sted.
- **Én kontrakt for alle runners.** Input: rolle-prompt, issue/spec og repo. Output: branch/PR plus JSON-rapport (`status`, `summary`, `tests_run`).
- **Ingen leverandørfeatures i kernen.** Tool-specifikke tricks hører hjemme inde i en adapter.
- **Bland med vilje.** Reviewer bør være en anden motor end implementer, når det er muligt.
- **Codex via abonnement.** `codex exec` kører lokalt på Nikolajs login. Personligt login lægges ikke i en cloud-runner. Kommer der en API-nøgle senere, kan daemonen flytte i skyen.

## Produktafdelingen

En løs idé bliver til issues, der er klar til at bygge, i fire trin. Nikolaj er kun involveret, når der skal træffes beslutninger.

1. **Idé.** Nikolaj opretter et issue med label `idea`, fx "Jeg vil have et galleri".
2. **Decision Brief.** Analyst-agenten kommenterer med de få spørgsmål, der betyder noget (2–3 muligheder hver og en anbefaling), plus synlige antagelser for resten.
3. **Spec.** Efter svarene laver spec-agenten en PR med `specs/<feature>.md` og eventuelle ADR'er. Spec'en reviewes og merges ligesom kode.
4. **Plan.** Planner-agenten opretter en epic med sub-issues og afhængigheder og sætter dem til `factory:ready`.

**Regler for analysten**

- Spørg kun, hvis valget er dyrt at lave om eller er en smagssag. Alt andet er en antagelse, som kan overrules.
- Brug `docs/vision.md` som ramme (9 brugere, privat, mobil først, lav drift).
- Arkitekturvalg (fx "skal hosting kunne skiftes?") bliver til ADR'er.
- Sub-issues er vertikale snit, som kan testes hver for sig.

### Eksempel: galleri

| Spørgsmål | Anbefaling | Alternativer |
| --- | --- | --- |
| Struktur | Begivenheder + et løst album | Kun begivenheder; frit med tags |
| Hosting | Supabase Storage bag `StorageProvider`-interface | Direkte S3; Google Photos-sync |
| Video | Nej i v1 | Korte klip ≤ 60 sek. |
| Hvem må slette | Kun uploaderen | Alle; admin |

Antagelser: upload af flere billeder fra mobil, WebP-komprimering med thumbnail og 2048 px-version, original gemmes, EXIF-dato placerer billedet på tidslinjen, GPS fjernes, kommentarer ja, likes nej.

Resultat efter svar: en epic med 6 sub-issues (storage-adapter, upload-pipeline, datamodel, visning, tidslinje, rettigheder + e2e). Daemonen tager kun issues, hvor alle afhængigheder er lukkede.

## Samlebåndet

Et issue går fra `factory:ready` til en PR, der er klar til merge. Hvert trin kan sende opgaven tilbage, og et loft på iterationer stopper uendelige fix-loops.

| Rolle | Input | Output | Sender tilbage når |
| --- | --- | --- | --- |
| Implementer | Sub-issue + spec + AGENTS.md | Branch + PR + JSON-rapport | – |
| CI | PR | Grøn/rød status | Lint, typer eller tests fejler |
| Reviewer | PR-diff + spec | Godkendt eller ændringer | Koden afviger fra spec eller konventioner |
| Tester | Acceptkriterier | Playwright e2e-tests | Kriterier mangler testdækning |
| Docs | Merget ændring | Opdateret `docs/` + changelog | – |

**Guardrails**

- Strict TypeScript, lint og unit-tests. e2e-tests udledes direkte af acceptkriterierne.
- Branch protection: ingen merge til `main` uden grøn CI og reviewer-godkendelse.
- `max_fix_iterations: 3` pr. opgave. Derefter går opgaven til `blocked`, og Nikolaj får besked.
- Nikolaj er merge-gate i starten. Auto-merge af små ændringer slås til, når der er tillid.
- Agenter må aldrig røre secrets, produktionsdata eller CI-konfiguration uden en menneskelig review.

## Kontrolrummet

GitHub er rattet, daemonen er motoren, og dashboardet er instrumentbrættet. Der er ét kontrolsystem og to måder at betjene det på: kommentarer og knapper.

**Prioritering.** GitHub Projects med kolonnerne Idea → Afklaring → Klar → I gang → Review → Done og felterne `Priority` (P0–P3), `Runner` og `Budget`. Rækkefølgen i Klar er arbejdsrækkefølgen. Daemonen læser prioriteringen og bestemmer den aldrig selv.

**ChatOps.** Kun kommentarer fra Nikolaj udføres. De tjekkes mellem trin, aldrig midt i et commit.

```
/factory pause | resume | status
/factory stop #24          afbryd, gem arbejdet på branchen
/factory retry #24 --runner claude
/factory hold #25          spring over indtil videre
```

Nødbremse: label `factory:halt` på repoet eller en lokal `HALT`-fil stopper alt med det samme.

**Status og forbindelse.** Daemonen er altid i én tilstand: `running`, `idle`, `paused`, `waiting_quota`, `sleeping`, `error`. Hvert minut skrives et heartbeat (tid, tilstand, opgave, næste start) til et fastgjort "Factory Status"-issue. Er heartbeat ældre end 5 minutter, vises `offline`.

**Kvote.** Daemonen holder en `codex app-server` kørende og læser `account/rateLimits/read` før hver opgave og hvert 5. minut. Svaret giver 5-timers- og ugevinduet med brugt procent og nulstillingstid (vinduerne identificeres på `window_minutes`). Er 5h-vinduet under 15 %, eller er dagens pacing-budget brugt, skifter den til `waiting_quota` med `next_start` = Codex' egen nulstillingstid. Der reserveres ingen kvote til Nikolaj. App-serveren bruges også til at køre agenterne (threads/turns), så `/factory stop` bliver et rent `turn/interrupt`.

**Arbejdstid og notifikationer**

```yaml
schedule:
  active: always             # fabrikken kører døgnet rundt
  quiet_notifications: "23:00-07:00"
quota:
  source: codex-app-server
  reserve_for_me: 0%
  pause_below_5h: 15%
  pacing: even               # fordel ugekvoten jævnt over resterende dage
notify:
  channel: ntfy
  on: [needs_decision, blocked, quota_exhausted, pr_ready, error]
```

**Dashboard.** Viser tilstand og heartbeat, aktuel opgave og iteration, køen, hvad der venter på Nikolaj, kvoteforbrug, næste start og på pause, dagens PR'er og fejl, samt knapper til Pause, Halt, Skift runner og Log. Dashboardet bygges som en af fabrikkens første egne opgaver.

## Sikkerhed og risici

| Risiko | Konsekvens | Modtræk |
| --- | --- | --- |
| Kvoten brændes af i fix-loops | Fabrikken står stille i dagevis | Iterationsloft, kø, `waiting_quota`, kvote læst fra app-serveren |
| Agent lækker eller misbruger secrets | Kompromitteret konto eller data | Agenter ser aldrig rigtige credentials. Secrets ligger kun i CI og hosting |
| Bankingkode med fejl | Forkerte saldi, tab af tillid | PSD2 via en aggregator. Kode reviewes manuelt. Kun læseadgang |
| Maskinen er slukket | Intet arbejde bliver lavet | Accepteret. Offline vises via heartbeat |
| Abonnementsvilkår | Adgang lukkes | Codex køres kun lokalt på eget login. Vilkår tjekkes før start |
| Kvalitet glider over tid | Teknisk gæld | Cross-vendor review, ADR'er, CI som dommer |

Banking er en egen zone. Valg af aggregator (fx Tink eller Mastercard Open Banking), og om den accepterer en privatkonto, undersøges, før del 2 specificeres.

## Faseplan og næste skridt

Fabrikken bygges i fire faser. Hver gate skal være nået, før næste fase begynder, og loge-appen kommer først, når fabrikken kan køre et natskift uden hjælp.

_(Faseplan-diagram: Fase 0 Fundament → Fase 1 Produktafdeling → Fase 2 Kontrolrum → Fase 3 Loge-appen. Gates: toy-feature merget · galleri-epic planlagt · natskift kører selv.)_

Fase 0 er i gang. Toy-featuren er "medlemsliste med profilbillede".

### Næste skridt

- [ ] Bekræft, at Codex-abonnementet tillader lokal headless brug
- [ ] Opret repo og GitHub Project-board
- [ ] Skriv `docs/vision.md`
- [ ] Skriv `AGENTS.md` og rolle-prompts
- [ ] Byg daemon v0 med codex-runner
- [ ] Kør toy-featuren igennem hele samlebåndet
