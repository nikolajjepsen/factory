# runners/

Adaptere til de motorer, der udfører agenternes arbejde. Hver leverandør har sin egen mappe, fx `runners/codex/` (M1–M2).

Leverandørspecifik kode bor kun her. Kernen i `daemon/` kender kun `Runner`-interfacet (M2).
