# Codex app-server-fixtures

Rå svar fra en rigtig `codex app-server`, optaget 2026-10-11 med `codex-cli 0.162.1` på et ChatGPT Plus-login.

| Fil | Indhold |
| --- | --- |
| `app-server-transcript.jsonl` | Serverens stdout-linjer i rækkefølge: svar på `initialize`, en uopfordret notifikation, svar på `account/rateLimits/read` og notifikationen `account/updated`. |
| `rate-limits-read.json` | `result` fra `account/rateLimits/read`, pænt formateret. |
| `turn-completed.jsonl` | En hel turn i et git worktree med `outputSchema`: opret en fil, kør `cat`, forsøg `git commit` (blokeret af sandkassen). Begge retninger (`dir: in/out`). |
| `turn-interrupted.jsonl` | En turn, der afbrydes med `turn/interrupt` under en `sleep 60`. |
| `app-server-errors.jsonl` | Fejlsvar: kald før `initialize`, ukendt metode (svaret er forkortet af serveren selv) og `initialize` to gange. |

## Anonymisering

Repoet er offentligt. Disse felter er erstattet med pladsholdere, og alt andet er uændret, også tal og tidspunkter:

- `accountId`, `installationId`, `serverName`
- id'erne på `rateLimitResetCredits.credits[]`
- `userAgent` (terminalnavn fjernet) og `codexHome`
- stier: den midlertidige mappe er `/tmp/ai-factory-fixture`, og hjemmemappen er `/Users/example`
- i turn-optagelserne er kun de første tre `item/agentMessage/delta` beholdt

## Optag igen

Efter en Codex-opgradering:

```bash
pnpm factory quota --raw > /tmp/rate-limits-read.json
```

Anonymisér felterne ovenfor, og erstat `rate-limits-read.json`. Kør derefter `pnpm check`. `codex app-server generate-ts --out <mappe>` viser de aktuelle protokoltyper.
