# AI-fabrikken – byggeplan

Denne plan er ordren til den agent, der bygger fabrikken (Codex eller Claude Code, kørt interaktivt af Nikolaj). Fabrikken kan ikke bygge sig selv endnu. Det er M0–M5's job at nå dertil.

- Baggrund og designvalg: `docs/design.md`
- Kontrolrummets udseende og adfærd: `docs/mockups/kontrolrum.dc.html` (se `docs/mockups/README.md`)
- Ved konflikt mellem dokumenterne vinder **denne fil**.

## Beslutninger, der er truffet

| Emne | Beslutning |
| --- | --- |
| Sprog/runtime | Node 22 LTS, TypeScript strict, ESM, pnpm |
| Test/lint | Vitest, ESLint, Prettier. `pnpm check` = typecheck + lint + test |
| Validering | zod for al ekstern input (config, JSON-RPC, GitHub-svar) |
| Persistens | SQLite (better-sqlite3) i `~/.ai-factory/state.db` |
| GitHub | `gh` CLI-login + Octokit (REST + GraphQL til Projects v2 og sub-issues) |
| Codex | `codex app-server` over stdio (JSON-RPC/JSONL), Nikolajs eget ChatGPT Plus-login |
| Daemon-API | Hono på `127.0.0.1:4712`: `GET /state`, `GET /events` (SSE), `POST /commands`. Bearer-token påkrævet |
| Dashboard | Separat pakke `dashboard/`, kører i en container under **OrbStack**. Tynd klient uden egen state. Frontend-build med esbuild (Preact) er tilladt |
| Container-runtime | OrbStack. Dashboardet nås på `https://dashboard.ai-factory.orb.local`. Docker Desktop understøttes som fallback |
| Motor | Daemon, `codex app-server`, `gh` og worktrees kører **native** på macOS, aldrig i Docker (M9 undtaget) |
| Arbejdstid | Døgnet rundt. Ingen kvote reserveres til Nikolaj |
| Projekter | Projektagnostisk fra dag ét: `projects.yml` i fabrikken, `.factory/` i hvert projekt. Boardets rækkefølge er prioriteten på tværs af projekter |
| Workflows | Deklarative YAML-filer fortolket af en workflow-motor i daemonen. Ordforrådet er kode, kombinationen er konfiguration |
| Første projekt | `loge-app` (toy-feature: medlemsliste med profilbillede) |

## Milepæle

Hver milepæl er en eller flere PR'er. En milepæl er færdig, når **alle** acceptkriterier er opfyldt og `pnpm check` er grøn.

### M0 – Skelet

- Repo-struktur som i `docs/design.md` (daemon/, runners/, agents/baseline/, dashboard/, templates/).
- `pnpm check`, GitHub Actions CI der kører den, branch protection-noter i README.
- CLI-indgang `factory` (commander eller citty) med `factory --version`.

**Accept:** `pnpm i && pnpm check` er grøn lokalt og i CI. `pnpm factory --version` virker.

### M1 – Codex app-server-klient og kvote

- `runners/codex/appServerClient.ts`: starter `codex app-server`, laver `initialize` + `initialized`, korrelerer request-id'er, håndterer notifikationer, genstarter processen ved crash med backoff.
- `account/rateLimits/read` → normaliseret `QuotaSnapshot`:
  `{ fiveHour: { usedPercent, resetsAt }, weekly: { usedPercent, resetsAt }, fetchedAt }`.
  - Vinduerne identificeres på `window_minutes` (300 og 10080), **ikke** på `primary`/`secondary`.
  - Felter accepteres i både snake_case og camelCase (`used_percent`/`usedPercent`, `resets_at`/`resetsAt`, `window_minutes`/`windowDurationMins`). `resets_at` kan være unix-sekunder.
  - Lyt også på `account/rateLimits/updated`, hvis den findes.
- CLI: `factory quota` udskriver begge vinduer med "% tilbage" og nulstillingstid i lokal tid.
- Gem det rå svar fra første kørsel som fixture under `test/fixtures/` og skriv tests mod den.

**Accept:** `factory quota` viser de samme tal og nulstillingstider som `/status` i en interaktiv Codex-session (±1 %).

### M2 – Runner-kontrakt og Codex-runner

- Fælles interface `Runner.run(task): AsyncIterable<RunEvent>` → slutter med `RunReport { status: 'success'|'failed'|'interrupted', summary, testsRun, branch, commits }`.
- Codex-runner via app-server threads/turns. Arbejdsmappe = et git worktree pr. opgave under `~/.ai-factory/worktrees/<projekt>/<issue>`. Sandkasse: skriveadgang kun til worktree, ingen interaktive godkendelser.
- `interrupt()` → `turn/interrupt`. Arbejdet committes som WIP på branchen.
- Rolle-prompt bygges af: agentfil (M6) + issue-tekst + spec + projektets `AGENTS.md`.
- CLI: `factory run --project loge-app --issue 12 --role implementer`.

**Accept:** Mod et testrepo kan `factory run` løse et simpelt issue ("tilføj en funktion + test"), pushe branch og åbne PR. Ctrl-C/interrupt efterlader en ren WIP-commit.

### M3 – Daemon og workflow-motor

Flowet må **ikke** hårdkodes. Daemonen fortolker workflow-filer, og M3 leverer motoren, et fast ordforråd og et baseline-workflow.

**Workflow-filer**

- Placering og arv: `agents/baseline/workflows/*.yml` (fabrikken) → `<projekt>/.factory/workflows/*.yml` (override pr. fil-id) → pr. issue med `/factory workflow #N <navn>`.
- Valg af workflow: label `workflow:<navn>`, ellers issue-type (`feature`, `bug`, `chore`), ellers `feature`.
- Skema (zod) med klare fejlbeskeder. `factory workflow validate` validerer alle filer, og CI kører den.

```yaml
# eksempel: agents/baseline/workflows/feature.yml
stages:
  - id: implement
    agent: implementer
    strategy: direct              # direct | plan_then_code
    gates:
      - ci
      - review: { agent: reviewer, rubric: rubrics/code.md, min_score: 7 }
    on_fail: [retry_with_feedback x3, escalate: human]
```

**Ordforråd (minimum i M3)**

| Nøgle | Adfærd |
| --- | --- |
| `agent: <navn>` | Opløs agentfil (baseline indtil M6) og kør en turn via runneren |
| `strategy: direct` | Agenten løser opgaven i én turn |
| `strategy: plan_then_code` | Første turn skriver en plan (`PLAN.md` på branchen), planens gates køres (`on: plan`), derefter koder anden turn efter planen |
| gate `ci` | Vent på GitHub-checks på PR'en. Rød → fejl med CI-loggens relevante uddrag som feedback |
| gate `review: { agent, rubric, min_score, on? }` | Kør kritiker-/reviewer-agent med output + rubrik. Den svarer med JSON `{ score, passed, feedback[] }` (zod-valideret). Under `min_score` → fejl |
| gate `human: always \| approve_pr` | Label `factory:needs-you`, notifikation, vent på svar/godkendelse. Afvisning → fejl med Nikolajs tekst som feedback |
| `retry_with_feedback xN` | Kør stagen igen med al feedback indtil nu tilføjet prompten, højst N gange |
| `switch_strategy: <s>` | Kør stagen igen med en anden strategy |
| `switch_runner: <r>` | Kør stagen igen på en anden runner (fejler pænt, hvis runneren ikke findes) |
| `switch_agent: <navn>` | Kør stagen igen med en anden agent (fx en specialist) |
| `escalate: human` | Label `factory:blocked`, notifikation, stop |

- Motoren er en generisk løkke: for hver stage → kør agent → kør gates i rækkefølge → første fejlede gate tager næste trin på eskaleringsstigen → stigen tom = `factory:blocked`.
- Hvert forsøg logges i SQLite: `run_id, issue, stage, attempt, agent, runner, strategy, gate, score, passed, feedback, tokens, duration`. Dette er datagrundlaget for M7b.
- Nye ord i ordforrådet tilføjes som almindelige features med tests, aldrig som specialtilfælde i motoren.

**Baseline-workflows i M3:** `feature` (implement med ci + review), `bugfix` (kræver en test, der reproducerer fejlen, før fix), `chore` (kun ci). `analysis`/`spec`/`plan`-stages kommer i M7.

**Daemon**

- Tilstandsmaskine: `running | idle | paused | waiting_quota | error` (+ `offline` udledt af heartbeat).
- Loop: hent top-issue fra GitHub Project-kolonnen "Klar" (rækkefølge = prioritet), spring over hvis afhængigheder (sub-issues/"blocked by") ikke er lukkede eller label `factory:hold`.
- Når alle stages er godkendt: label `factory:ready-to-merge` og notifikation.
- Heartbeat hvert minut til et fastgjort issue "Factory Status" i fabrikkens repo (redigeres, ikke nye kommentarer).
- ChatOps fra Nikolaj (tjek forfatter): `/factory pause|resume|status|stop #N|retry #N [--runner x]|hold #N|focus <projekt>|workflow #N <navn>|reject #N "<feedback>"`. `reject` tæller som en fejlet gate på den aktuelle stage og bruger teksten som feedback. Kommandoer tjekkes mellem trin.
- Nødbremse: label `factory:halt` på et projektrepo eller fil `~/.ai-factory/HALT`.
- Kører som launchd-agent på macOS (`factory install-service`).

**Accept:**
- Toy-issue i et testrepo går fra "Klar" til en grøn, reviewet PR uden menneskelig indgriben.
- En ændring **kun** i en workflow-fil (fx tilføj en review-gate eller skift `strategy`) ændrer næste kørsels forløb, synligt i loggen, uden kodeændringer.
- En simuleret fejlende gate går op ad eskaleringsstigen i den angivne rækkefølge og ender i `factory:blocked`.
- `/factory pause`, `/factory reject` og `factory:halt` virker inden for ét trin.

### M4 – Kvotepolitik

- Læs kvote før hver ny opgave og hvert 5. minut.
- Regler (fra `factory.yml`): `pause_below_5h: 15%`, `reserve_for_me: 0%`, `pacing: even` (ugekvoten fordeles jævnt over resterende dage til nulstilling).
- Under grænsen: `waiting_quota` med `next_start` = Codex' nulstillingstid (eller næste døgn ved pacing). Kørende turn afsluttes, nye startes ikke.
- Fallback: fang "usage limit"-fejl og gør det samme.

**Accept:** Unit-tests dækker pacing-beregningen. Simuleret snapshot under grænsen sender daemonen i `waiting_quota` med korrekt `next_start`.

### M5a – Daemon-API

- Hono-server i daemonen på `127.0.0.1:4712` (port i `factory.yml`).
  - `GET /state` → hele tilstanden: mode, heartbeat, aktuel opgave + trin + iteration, kø pr. projekt, venter-på-dig, kvote-snapshot + pacing, dagens tal, seneste log.
  - `GET /events` → SSE med samme objekter som delta-events.
  - `POST /commands` → `{ "command": "pause" | "resume" | "halt" | "stop" | "retry" | "hold" | "focus", "issue"?, "project"?, "runner"? }`.
- Kommandoerne går gennem **samme handler** som ChatOps. Der er ét kontrolsystem.
- Bearer-token fra `~/.ai-factory/api-token` (genereres ved første start, `factory api-token` viser det). Uden gyldigt token: 401.
- zod-skemaer for state og kommandoer i en delt pakke `packages/protocol`, som dashboardet importerer.

**Accept:** `curl` med token kan læse state, følge events og pause/genoptage fabrikken. Uden token: 401.

### M5b – Kontrolrummet (container)

- Separat pakke `dashboard/` med egen `Dockerfile` (node:22-slim, non-root bruger) og `docker-compose.yml` i repo-roden med `name: ai-factory` og service-navnet `dashboard`, så OrbStack giver domænet `dashboard.ai-factory.orb.local`.
- Dashboardet lytter på port 80 i containeren, så OrbStack-domænet virker uden portnummer. OrbStack sørger selv for HTTPS.
- Tema "Natskift", **kun dark mode** (ingen light mode). Tokens, skrifttyper og layout står i `docs/mockups/README.md`.
- Dashboard som i mockuppen: status-pill + heartbeat + næste start, knapper (Pause/Genoptag, Nødstop, Skift runner), "Arbejder på nu" med trin og iteration, to kvotemålere (5h og uge, pacing-budget), kø med op-knap og Hold, "Venter på dig", "I dag", log, projektvælger + fokus-knap.
- To tilstande via `FACTORY_MODE`:
  - `direct` (default): `FACTORY_API_URL=http://host.orb.internal:4712` + `FACTORY_API_TOKEN`. Live via SSE. (`host.docker.internal` virker også og bruges på Docker Desktop.)
  - `github`: læser "Factory Status"-issuet og sender kommandoer som `/factory`-kommentarer. Kræver `GITHUB_TOKEN` med adgang til fabrikkens repo. Op til 1 min forsinkelse. Kan køre hvor som helst (NAS, sky).
- Dashboardet viser tydeligt, hvilken tilstand det kører i, og hvor gammel den viste status er.
- Ingen `ports:` i compose under OrbStack: domænet er nok. En valgfri compose-profil `docker-desktop` publicerer på `127.0.0.1:4711` (aldrig `0.0.0.0`).
- Verificér, at containeren når daemonen bundet til værtens `127.0.0.1` via `host.orb.internal`. Gør den ikke, binder daemonen også til containernetværkets gateway, stadig med token. Dokumentér valget.

**Accept:** `docker compose up dashboard` giver et kørende kontrolrum på `https://dashboard.ai-factory.orb.local` i `direct`-tilstand mod en native daemon. Alle knapper har samme effekt som deres ChatOps-kommando. Samme image virker i `github`-tilstand uden adgang til daemonen.

### M6 – Flere projekter og agent-lag

- `projects.yml`: pr. projekt `repo` og `path`. Ingen vægte eller kvoteandele.
- Tænd/sluk pr. projekt: `/factory enable|disable <projekt>` og en kontakt pr. projekt i kontrolrummet. Gemmes i daemonens database ligesom pause og fokus. Et slukket projekt får ingen nye trin.
- `<projekt>/.factory/project.yml`: `ci` (tjek-kommandoen, agenten skal have grøn) og `runners` pr. rolle. Antallet af forsøg styres kun i workflow-filerne.
- Agentfiler (markdown + frontmatter): `extends`, `scope.labels`, `context`, `runner`. Opløsning: mest specifikke match på `area:`-label → projektagent → `agents/baseline/<rolle>.md`.
- Planlægning på tværs: boardets rækkefølge i "Klar" gælder på tværs af projekter. `focus` og tænd/sluk bestemmer, hvilke projekter der tages fra.

**Accept:** To testprojekter kører side om side: køen følger boardets rækkefølge, `focus` og tænd/sluk. En domæneagent vælges for et issue med matchende `area:`-label, ellers baseline.

### M7 – Produktafdelingen

- Workflowet `idea` (label `idea`, kortet lægges i "Klar" som alle andre): analyst (Decision Brief-kommentar, venter på Nikolajs svar) → spec (PR med `specs/<feature>.md` + ADR'er, venter på merge) → planner (sub-issues med afhængigheder og `area:`-labels, sat til "Klar"). Idé-issuet bliver selv epic'en.
- Nyt i ordforrådet: stage-nøglen `output: pr | comment | issues`, gaten `human: answer` (Nikolajs første kommentar efter briefen er svaret) og gaten `human: merge` (kørslens PR er merget). Hver stages output gives videre til de næste.
- Skabeloner i `templates/`: decision-brief, spec, adr, issue. Agentfiler henter dem med `templates:`, og et projekt kan overskrive dem i `.factory/templates/`.
- Analysten læser `docs/vision.md` og spørger kun om dyre eller smagsprægede valg. Resten bliver til antagelser.

**Accept:** Issue "Jeg vil have et galleri" ender som epic med sub-issues efter én runde svar fra Nikolaj.

### M7b – Kvalitetsløkken

- Kritiker-agent `agents/baseline/critic.md`: bedømmer et output mod en rubrik og svarer i gate-JSON-formatet. Kører på en anden runner end forfatteren, når det er muligt.
- Rubrikker som markdown i `agents/baseline/rubrics/` og `<projekt>/.factory/rubrics/`: `decision-brief.md`, `spec.md`, `impl-plan.md`, `code.md`. Hvert punkt har point, så scoren kan forklares.
- `feature`-workflowet udvides med review-gates på analyse, spec og plan.
- Nøgletal pr. stage og projekt i kontrolrummet: first-pass rate, iterationer i snit, kvoteforbrug, menneskelige afvisninger efter godkendt kritik (= for slap rubrik).
- Forslagsløkke: når samme type feedback går igen (≥ 3 gange inden for 30 dage, grupperet af en agent), åbner fabrikken en PR mod den relevante rubrik, agentfil eller workflow-fil med begrundelse og eksempler. Fabrikken merger aldrig sine egne forslag.

**Accept:** Tre ens `/factory reject`-begrundelser på analyser giver én PR med et konkret forslag til `decision-brief.md`. Nøgletallene vises i kontrolrummet.

### M8 – Notifikationer

- ntfy (topic i config): `needs_decision`, `blocked`, `quota_exhausted`, `pr_ready`, `error`. Stille tid 23:00–07:00 (samles til morgen).

**Accept:** Hver hændelsestype giver præcis én notifikation med link.

### M9 – Containere som sandkasse (efter dogfooding)

- Valgfri `sandbox: container` i `project.yml`: hver opgave kører i sin egen kortlivede container med kun worktree'et mountet.
- Codex-login gives ind som read-only mount eller kortlivet kopi. Undersøg først, hvordan Codex' egen sandkasse og loginfornyelse opfører sig i en Linux-container.
- Daemonen bliver native og styrer containerne via Docker-API'et.

**Accept:** Et issue løses i container-sandkasse med samme resultat som native. Agenten kan ikke læse filer uden for sit worktree.

## Derefter: dogfooding

1. Opret `loge-app` med `.factory/`, `AGENTS.md` og `docs/vision.md`.
2. Kør toy-featuren "medlemsliste med profilbillede" gennem hele båndet.
3. Gate til loge-appen: fabrikken kører et natskift selv.

## Uden for scope (indtil videre)

- Banking/PSD2 (egen zone, mennesket reviewer al kode).
- Claude-runner (kontrakten skal gøre den triviel at tilføje senere).
- Cloud-hosting af daemonen.
