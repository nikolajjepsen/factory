# Changelog

## Unreleased

### Tilføjet

- M1: `factory quota` viser Codex-kvoten (% tilbage og nulstillingstid i lokal tid) for 5-timers- og ugevinduet. `--json` udskriver det normaliserede snapshot, og `--raw` det rå svar.
- M1: `AppServerClient` taler JSON-RPC med `codex app-server` over stdio, svarer på serverens requests og genstarter processen med backoff ved nedbrud. Se `docs/codex-app-server.md`.
- M1: Kvoten normaliseres til `QuotaSnapshot`. Vinduerne findes på varighed, felter accepteres i camelCase og snake_case, og `account/rateLimits/updated` flettes ind.
- M1: Anonymiserede fixtures fra en rigtig app-server ligger i `test/fixtures/codex/`.
- M0: repo-skelet med `daemon/`, `runners/`, `agents/baseline/`, `dashboard/` og `templates/`.
- `pnpm check` kører typecheck (TypeScript strict), lint (ESLint + Prettier) og tests (Vitest).
- GitHub Actions-workflowet `CI` kører `pnpm check` på pull requests og pushes til `main`.
- CLI-indgangen `factory` med `factory --version` (`pnpm factory --version`).
