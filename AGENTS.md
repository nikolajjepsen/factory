# AGENTS.md – ai-factory

Du bygger **ai-factory**: en lokal daemon, der orkestrerer AI-agenter (primært Codex via `codex app-server`) til at bygge software i GitHub-projekter autonomt.

## Læs først

1. `BUILD_PLAN.md` – milepæle, acceptkriterier og trufne beslutninger. Den vinder ved konflikt.
2. `docs/design.md` – hvorfor fabrikken ser ud, som den gør.
3. `docs/mockups/` – kontrolrummets forventede udseende og adfærd.

## Arbejdsgang

- Arbejd én milepæl ad gangen, i rækkefølge. Start hver milepæl med en kort plan, og vent på godkendelse, hvis planen afviger fra `BUILD_PLAN.md`.
- Små PR'er. Hver PR skal holde `pnpm check` grøn.
- Skriv tests sammen med koden. Ekstern I/O (Codex, GitHub, filsystem) skjules bag interfaces, så kernen kan testes uden netværk.
- Er du i tvivl om et eksternt format (fx app-server-svar), så kør det rigtigt, gem svaret som fixture og byg efter det. Gæt ikke.
- Opdater `docs/` og `CHANGELOG.md`, når adfærd ændres.

## Konventioner

- TypeScript strict, ESM, ingen `any` uden en kommentar om hvorfor.
- zod-skemaer ved alle grænser (config, JSON-RPC, GitHub).
- Kode og identifiers på engelsk. Brugerrettede tekster (dashboard, notifikationer) på dansk.
- Leverandørspecifik kode bor kun i `runners/<leverandør>/`. Kernen kender kun `Runner`-interfacet.

## Forbudt

- Commit aldrig secrets, tokens eller indholdet af `~/.codex/`.
- Brug aldrig Nikolajs ChatGPT-login uden for hans egen maskine (ingen cloud-runners med hans login).
- Ingen destruktive git-operationer (`push --force`, `reset --hard` på delte branches) uden for fabrikkens egne worktrees.
- Daemonens API lytter kun på `127.0.0.1` (eller Docker-broen, se M5b) og kræver altid token. Dashboard-containeren publiceres kun på `127.0.0.1`.
- Daemon, `codex app-server`, `gh` og worktrees kører native. De lægges ikke i Docker (M9 undtaget).
- Rør ikke CI-konfiguration eller branch protection uden at sige det tydeligt i PR'en.
