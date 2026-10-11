# templates/

Skabeloner til produktafdelingen (M7). Agentfiler henter dem med `templates:` i frontmatter, og et projekt kan overskrive en skabelon med `.factory/templates/<navn>.md`.

| Skabelon | Bruges af | Bliver til |
| --- | --- | --- |
| `decision-brief.md` | analyst | kommentaren på idé-issuet |
| `spec.md` | spec | `specs/<feature>.md` i spec-PR'en |
| `adr.md` | spec | `docs/adr/<nummer>-<navn>.md` |
| `issue.md` | planner | beskrivelsen af hvert sub-issue |
