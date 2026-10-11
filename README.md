# ai-factory

En lokal AI-fabrik: Nikolaj sætter mål og prioriteter i GitHub, og agenter (primært Codex) analyserer, specificerer, koder, tester, reviewer og dokumenterer.

## Kom i gang (bootstrapping)

Fabrikken kan ikke bygge sig selv endnu, så de første milepæle bygges interaktivt:

```bash
cd ~/dev/ai-factory
git init && gh repo create ai-factory --private --source . --push   # valgfrit, men anbefalet
codex
```

Første prompt til Codex (eller Claude Code):

> Læs AGENTS.md og BUILD_PLAN.md. Lav en plan for M0, og byg den, når jeg har godkendt.

Fortsæt milepæl for milepæl. Efter M3 kan fabrikken begynde at tage sine egne issues.

## Filer

- `BUILD_PLAN.md` – milepæle og acceptkriterier
- `AGENTS.md` / `CLAUDE.md` – regler for agenterne
- `docs/design.md` – designdokumentet
- `docs/mockups/` – kontrolrummet

## Arkitektur i én linje

Daemonen (motoren) kører native på Mac'en, hvor Codex-loginet bor. Kontrolrummet kører i Docker og taler med daemonens API (`direct`) eller kun med GitHub (`github`).
