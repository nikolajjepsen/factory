# Changelog

## Unreleased

### Tilføjet

- M0: repo-skelet med `daemon/`, `runners/`, `agents/baseline/`, `dashboard/` og `templates/`.
- `pnpm check` kører typecheck (TypeScript strict), lint (ESLint + Prettier) og tests (Vitest).
- GitHub Actions-workflowet `CI` kører `pnpm check` på pull requests og pushes til `main`.
- CLI-indgangen `factory` med `factory --version` (`pnpm factory --version`).
