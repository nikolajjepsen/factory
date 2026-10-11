# Runner-kontrakten

En runner udfører én agent-turn. Kernen kender kun interfacet i `daemon/runner/runner.ts`, og leverandørkoden bor i `runners/<leverandør>/`. Codex er den første runner (`runners/codex/codexRunner.ts`).

## Kontrakten

- `Runner.run(task): AsyncIterable<RunEvent>`. Den sidste hændelse er altid `report` med en `RunReport`: `status` (`success | failed | interrupted`), `summary`, `testsRun`, `branch`, `commits` og evt. `tokens`.
- `quotaExhausted: true` på en fejlet `RunReport` betyder, at leverandørens kvote slap op. Motoren kaster så `QuotaExhaustedError` i stedet for at bruge stigen, og daemonen venter på kvoten (se `docs/daemon.md`).
- `RunTask` indeholder den færdige prompt, et `Workspace` (git worktree) og et valgfrit `AbortSignal`. Afbrydes signalet, stopper runneren turnen.
- Agenten afleverer sin slutrapport som JSON efter skemaet `AgentReport`: `status` (`done | blocked`), `summary` (dansk), `testsRun` og `commitMessage`. Codex håndhæver skemaet via `outputSchema` på `turn/start`.

## Hvem committer

**Fabrikken committer, aldrig agenten.** Codex' sandkasse giver kun skriveadgang til worktree-mappen, og git skriver commits i hovedrepoets `.git`. Agenten kan derfor ikke committe, og det er meningen.

Efter hver turn kalder runneren `finishRun` (`daemon/runner/finishRun.ts`), som committer alt i worktree'et som `ai-factory <factory@ai-factory.invalid>`:

| Udfald | Commit-besked | Status |
| --- | --- | --- |
| Agenten svarer `done` | agentens `commitMessage` | `success` |
| Agenten svarer `blocked` | `WIP: <projekt>#<issue> (blocked)` | `failed` |
| Afbrudt (Ctrl-C, `/factory stop`) | `WIP: <projekt>#<issue> (interrupted)` | `interrupted` |
| Turnen fejler, timeout, ugyldig rapport eller app-server-nedbrud | `WIP: <projekt>#<issue> (failed)` | `failed` |
| Kvoten slipper op ("usage limit") | `WIP: <projekt>#<issue> (quota)` | `failed` med `quotaExhausted` |

Er der intet ændret, laves ingen commit.

## Codex-runneren

- En kortlivet tråd (`thread/start` med `ephemeral: true`) med `cwd` = worktree'et, `approvalPolicy: never` og `sandbox: workspace-write`.
- `turn/start` sætter `sandboxPolicy` med `writableRoots: [worktree]`. Netværk er slået fra, medmindre `--network` gives.
- Afbrydelse sender `turn/interrupt`. Serveren svarer `{}` og sender derefter `turn/completed` med `status: "interrupted"`.
- En turn, der varer over 60 minutter, afbrydes og rapporteres som fejlet.
- Går app-serveren ned midt i en turn, rapporteres kørslen som fejlet med en WIP-commit.

## Fra issue til PR

`runIssue` (`daemon/run/runIssue.ts`) binder det sammen, og både `factory run` og M3's motor bruger den:

1. Hent issuet. Det skal være åbent.
2. Opret eller genbrug worktree'et `~/.ai-factory/worktrees/<projekt>/<issue>` på branchen `factory/<issue>-<slug>`, baseret på `origin/<default-branch>`.
3. Byg prompten: agentfil (`agents/baseline/<rolle>.md`) + issue + spec (første `specs/*.md`, issuet nævner) + projektets `AGENTS.md` + evt. feedback fra tidligere forsøg.
4. Kør runneren.
5. Ved `success` med commits: push branchen (aldrig `--force`) og åbn en PR, der lukker issuet. Findes der allerede en åben PR for branchen, genbruges den.

## CLI

```bash
pnpm factory run --project ekvilibrium --issue 1            # rolle: implementer
pnpm factory run --project ekvilibrium --issue 1 --network  # med netværk i sandkassen
```

Første Ctrl-C afbryder turnen og gemmer WIP. Andet Ctrl-C stopper med det samme. Exitkoden er 0 ved succes, 1 ved fejl og 130 ved afbrydelse.
