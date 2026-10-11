# Changelog

## Unreleased

### Tilføjet

- M7: Produktafdelingen. Workflowet `idea` (label `idea`) går fra idé til Decision Brief (analyst), til spec-PR med `specs/<feature>.md` og ADR'er (spec) og til sub-issues med afhængigheder og `area:`-labels i Ready (planner). Idé-issuet bliver epic'en. Se "Produktafdelingen" i `docs/workflows.md`.
- M7: Stage-nøglen `output: pr | comment | issues` og gaterne `human: answer` (ejerens første kommentar er svaret) og `human: merge` (kørslens PR er merget). Hver stages output gives videre til de senere stages.
- M7: Skabelonerne `decision-brief`, `spec`, `adr` og `issue` i `templates/`. Agentfiler henter dem med `templates:`, og et projekt kan overskrive dem i `.factory/templates/`.
- M7: Kontrolrummet og statusissuet viser, hvad en kørsel venter på (svar, merge eller godkendelse). En planlagt epic flyttes ikke til "In review".

### Rettet

- En parkeret human-gate, der bestod, blev evalueret igen i samme trin. Ved `approve_pr` kunne et ældre review dermed tælle igen. Nu bruges den første evaluering.
- Et review, der bad om ændringer, fik også den næste turn til at fejle, fordi kørslen glemte, hvornår den sidst ventede. Human-gates tæller nu kun svar efter den seneste turn.

- M6: Tænd/sluk pr. projekt med `/factory enable <projekt>` og `/factory disable <projekt>` og en kontakt ved hvert projekt i kontrolrummet. Et slukket projekt får ingen nye trin, og daemonen går videre med de andre. Indstillingen gemmes i daemonens database. `projects` i tilstanden har `enabled`.
- M6: Agent-laget. Agentfiler har `extends`, `scope.labels`, `context` og `runner`. En stage og en review-gate får den projektagent, hvis `scope.labels` matcher flest af issuets labels, ellers projektets fil for rollen, ellers baseline. Loggen og forsøgsloggen viser den valgte agent og grunden. Se `docs/agents.md`.
- M6: `<projekt>/.factory/project.yml` med `ci` (tjek-kommandoen, som kommer med i agentens prompt) og `runners` pr. rolle. Runneren vælges i rækkefølgen override, stage, agentfil, `project.yml`, `default_runner`.
- M6: `factory workflow validate` tjekker også projektets agentfiler og `project.yml`. Ukendte felter er en fejl.
- M6: Boardets rækkefølge i "Ready" er prioriteten på tværs af projekter. `weight` og `quota_share` fra den oprindelige plan udgår.

- M5b: Kontrolrummet i `dashboard/` (Hono-server og Preact-UI bygget med esbuild) som container under OrbStack på `https://dashboard.ai-factory.orb.local`. Tema "Natskift": status og heartbeat, Pause/Genoptag, Nødstop, Skift runner, "Venter på dig", "Arbejder på nu" med workflowets trin, kø med op-knap og Hold, kvotemålere med dagsbudget og boost, dagens tal, log, projekter og fokus. Se `dashboard/README.md`.
- M5b: `direct`-tilstand følger daemonens API live. `github`-tilstand læser "Factory Status"-issuet og sender kommandoer som `/factory`-kommentarer, uden adgang til daemonen.
- M5b: `docker-compose.yml` (`name: ai-factory`, servicen `dashboard`, tokenet som secret, ingen porte) og profilen `docker-desktop` på `127.0.0.1:4711`.
- M5b: Nye kommandoer `/factory up #N` (ryk kortet én plads op i Ready på boardet) og `/factory release #N` (frigiv et kort på hold).
- M5b: Tilstanden har `projects`, `runners`, `halted`, `held` pr. kort og trin og runner for den aktuelle opgave. Statusissuets JSON læses med det delte skema.
- M5b: `/factory resume` sletter `~/.ai-factory/HALT`.
- M5a: Daemonens API på `127.0.0.1:4712` (`api.port` i `factory.yml`): `GET /state`, `GET /events` (SSE med hele tilstanden ved forbindelse og derefter kun ændrede felter og nye loglinjer) og `POST /commands` gennem samme handler som ChatOps. Kræver bearer-tokenet fra `~/.ai-factory/api-token` (`0600`), ellers `401`. `factory api-token` viser det. Se `docs/api.md`.
- M5a: Pakken `packages/protocol` (`@ai-factory/protocol`) med zod-skemaer for tilstand, events og kommandoer. Repoet er nu et pnpm-workspace.
- M5a: Tilstanden har `today` (PR'er i dag, merged, first-pass), og statusissuet viser dem. `reason` er altid med (`null` uden grund).
- M5a: Kvoten læses igen efter hvert trin, og Codex' push-opdateringer flettes ind, så kvotetallene er friske.
- M5a: `pause` og `resume` skifter tilstand med det samme, alle kommandoer logges ét sted, og en kommando vækker en daemon, der sover mellem gennemløb.
- M4: Kvotepolitik. Daemonen læser Codex-kvoten før hvert trin og hvert 5. minut, mens den venter, og går i `waiting_quota` med `nextStart`, når 5-timersvinduet er under `pause_below_5h`, ugekvoten er nede på `reserve_for_me`, eller dagens pacing-budget er brugt. En kørende turn får lov at blive færdig. Se `docs/daemon.md`.
- M4: Pacing `even` fordeler ugekvoten jævnt over tiden til nulstilling. En dag, der starter midt i døgnet, får kun andelen af sine resterende timer. Budgettet fastsættes ved dagens start og gemmes.
- M4: Sikkerhedsnet. En Codex-turn, der stopper på "usage limit" (`codexErrorInfo: "usageLimitExceeded"`), gemmes som `WIP: … (quota)`. Den tæller ikke som et fejlet forsøg og bruger ikke stigen. Trinnet tages om, når kvoten er tilbage.
- M4: `/factory boost [3h|90m|off]` tilsidesætter fabrikkens egne kvoteregler til midnat eller i en given tid. Codex' egen grænse gælder stadig.
- M4: `factory.yml` har sektionen `quota` (`pause_below_5h`, `reserve_for_me`, `pacing`). Statusissuet viser kvoten, dagens budget, næste start og en aktiv boost.
- M3b: `factory daemon` henter arbejde fra GitHub-boardet i prioriteret rækkefølge, springer kort med `factory:hold`, åbne afhængigheder (sub-issues og "blocked by") eller anden fokus over, flytter kortet til "In progress" og videre til "In review", når workflowet er færdigt. Se `docs/daemon.md`.
- M3b: Heartbeat hvert minut til det fastgjorte issue "Factory Status" med en dansk oversigt og tilstanden som JSON.
- M3b: ChatOps fra ejeren: `/factory pause | resume | status | halt | stop | retry [--runner] | hold | focus | workflow | reject | approve`. Én handler, som M5a's API også skal bruge.
- M3b: Nødbremse via `~/.ai-factory/HALT` eller labelet `factory:halt` på et åbent issue. Den afbryder også et kørende trin.
- M3b: `factory install-service` og `factory uninstall-service` installerer daemonen som launchd-agent.
- M3a: Workflow-motoren fortolker `agents/baseline/workflows/*.yml` og `<projekt>/.factory/workflows/*.yml` (override pr. fil-id) med ordforrådet `agent`, `strategy` (`direct`, `plan_then_code`), gates (`ci`, `review`, `human`) og eskaleringsstigen (`retry_with_feedback xN`, `switch_strategy`, `switch_runner`, `switch_agent`, `escalate: human`). Se `docs/workflows.md`.
- M3a: `factory run` kører nu issuets workflow. `--role` kører som før kun én turn. `--workflow` vælger workflow.
- M3a: Kørsler gemmes i SQLite (`~/.ai-factory/state.db`) og kan genoptages. Hver agent-turn og gate logges i `attempts`. `factory log` viser loggen.
- M3a: `factory workflow validate` validerer workflows, agenter og rubrikker. CI kører den (**ændring i `.github/workflows/ci.yml`**).
- M3a: Baseline-workflows `feature`, `bugfix` og `chore`, agenterne `reviewer` og `reproducer` og rubrikkerne `code`, `reproduction` og `plan`.
- M3a: `factory.yml` med board, `owner_login`, `status_repo`, `default_runner` og CI-timeout.
- Runner-kontrakten understøtter læseopgaver (`readOnly`): skrivebeskyttet sandkasse, eget svarskema, ingen commit.
- M2: `factory run --project <navn> --issue <n> [--role implementer]` løser et issue i et git worktree, pusher branchen og åbner en PR. Ctrl-C afbryder turnen og gemmer arbejdet som en WIP-commit. Se `docs/runner.md`.
- M2: Runner-kontrakten (`Runner.run(task): AsyncIterable<RunEvent>` → `RunReport`) og Codex-runneren via app-server threads/turns med sandkasse kun til worktree'et og strukturerede slutrapporter (`outputSchema`).
- Fabrikkens kommentarer får en skjult markør, så ChatOps aldrig udfører fabrikkens egne eksempler. Statusissuet og kommentarerne bruger ikke emojis.
- M2: Fabrikken committer selv som `ai-factory` efter hver turn. Agenten kan ikke committe fra sandkassen.
- M2: `projects.yml` med `repo` og `path` pr. projekt, og baseline-agenten `agents/baseline/implementer.md`.
- M1: `factory quota` viser Codex-kvoten (% tilbage og nulstillingstid i lokal tid) for 5-timers- og ugevinduet. `--json` udskriver det normaliserede snapshot, og `--raw` det rå svar.
- M1: `AppServerClient` taler JSON-RPC med `codex app-server` over stdio, svarer på serverens requests og genstarter processen med backoff ved nedbrud. Se `docs/codex-app-server.md`.
- M1: Kvoten normaliseres til `QuotaSnapshot`. Vinduerne findes på varighed, felter accepteres i camelCase og snake_case, og `account/rateLimits/updated` flettes ind.
- M1: Anonymiserede fixtures fra en rigtig app-server ligger i `test/fixtures/codex/`.
- M0: repo-skelet med `daemon/`, `runners/`, `agents/baseline/`, `dashboard/` og `templates/`.
- `pnpm check` kører typecheck (TypeScript strict), lint (ESLint + Prettier) og tests (Vitest).
- GitHub Actions-workflowet `CI` kører `pnpm check` på pull requests og pushes til `main`.
- CLI-indgangen `factory` med `factory --version` (`pnpm factory --version`).
