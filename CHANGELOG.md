# Changelog

## Unreleased

### Tilføjet

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
