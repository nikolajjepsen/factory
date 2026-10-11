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
| Dashboard | Separat pakke `dashboard/`, kører i Docker. Tynd klient uden egen state, ingen frontend-build |
| Motor | Daemon, `codex app-server`, `gh` og worktrees kører **native** på macOS, aldrig i Docker (M9 undtaget) |
| Arbejdstid | Døgnet rundt. Ingen kvote reserveres til Nikolaj |
| Projekter | Projektagnostisk fra dag ét: `projects.yml` i fabrikken, `.factory/` i hvert projekt |
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

### M3 – Daemon og samlebånd

- Tilstandsmaskine: `running | idle | paused | waiting_quota | error` (+ `offline` udledt af heartbeat).
- Loop: hent top-issue fra GitHub Project-kolonnen "Klar" (rækkefølge = prioritet), spring over hvis afhængigheder (sub-issues/"blocked by") ikke er lukkede eller label `factory:hold`.
- Flow: implementer → PR → vent på CI → rød: tilbage til implementer (maks `max_fix_iterations`, default 3) → grøn: reviewer → ændringer: tilbage → godkendt: label `factory:ready-to-merge` og notifikation. Over loftet: label `factory:blocked`.
- Heartbeat hvert minut til et fastgjort issue "Factory Status" i fabrikkens repo (redigeres, ikke nye kommentarer).
- ChatOps fra Nikolaj (tjek forfatter): `/factory pause|resume|status|stop #N|retry #N [--runner x]|hold #N|focus <projekt>`. Kommandoer tjekkes mellem trin.
- Nødbremse: label `factory:halt` på et projektrepo eller fil `~/.ai-factory/HALT`.
- Kører som launchd-agent på macOS (`factory install-service`).

**Accept:** Toy-issue i et testrepo går fra "Klar" til en grøn, reviewet PR uden menneskelig indgriben. `/factory pause` og `factory:halt` virker inden for ét trin.

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

- Separat pakke `dashboard/` med egen `Dockerfile` (node:22-slim, non-root bruger) og `docker-compose.yml` i repo-roden.
- Dashboard som i mockuppen: status-pill + heartbeat + næste start, knapper (Pause/Genoptag, Nødstop, Skift runner), "Arbejder på nu" med trin og iteration, to kvotemålere (5h og uge, pacing-budget), kø med op-knap og Hold, "Venter på dig", "I dag", log, projektvælger + fokus-knap.
- To tilstande via `FACTORY_MODE`:
  - `direct` (default): `FACTORY_API_URL=http://host.docker.internal:4712` + `FACTORY_API_TOKEN`. Live via SSE.
  - `github`: læser "Factory Status"-issuet og sender kommandoer som `/factory`-kommentarer. Kræver `GITHUB_TOKEN` med adgang til fabrikkens repo. Op til 1 min forsinkelse. Kan køre hvor som helst (NAS, sky).
- Dashboardet viser tydeligt, hvilken tilstand det kører i, og hvor gammel den viste status er.
- Dashboardet publiceres på `127.0.0.1:4711` i compose (ikke `0.0.0.0`).
- Verificér, at containeren når en service bundet til værtens `127.0.0.1` via `host.docker.internal` på Docker Desktop. Gør den ikke, binder daemonen også til Docker-broen, stadig med token. Dokumentér valget.

**Accept:** `docker compose up dashboard` giver et kørende kontrolrum i `direct`-tilstand mod en native daemon. Alle knapper har samme effekt som deres ChatOps-kommando. Samme image virker i `github`-tilstand uden adgang til daemonen.

### M6 – Flere projekter og agent-lag

- `projects.yml`: `focus`, og pr. projekt `repo`, `path`, `weight`, `quota_share`.
- `<projekt>/.factory/project.yml`: CI-kommando, runners pr. rolle, `max_fix_iterations`.
- Agentfiler (markdown + frontmatter): `extends`, `scope.labels`, `scope.paths`, `context`, `runner`. Opløsning: mest specifikke match på `area:`-label/sti → projektagent → `agents/baseline/<rolle>.md`.
- Planlægning på tværs: vægtet round-robin, respekter `quota_share` og `focus`.

**Accept:** To testprojekter kører side om side med korrekt fordeling. En domæneagent vælges for et issue med matchende `area:`-label, ellers baseline.

### M7 – Produktafdelingen

- Roller: analyst (issue `idea` → Decision Brief-kommentar), spec (svar → PR med `specs/<feature>.md` + ADR'er), planner (merget spec → epic + sub-issues med afhængigheder og `area:`-labels, sat til "Klar").
- Skabeloner i `templates/`: decision-brief, spec, adr, issue.
- Analysten læser `docs/vision.md` og spørger kun om dyre eller smagsprægede valg. Resten bliver til antagelser.

**Accept:** Issue "Jeg vil have et galleri" ender som epic med sub-issues efter én runde svar fra Nikolaj.

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
