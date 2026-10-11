# Rubric: code change

Score each point. Start at 10 and subtract.

- **Solves the issue (−4 if not).** Every acceptance criterion in the issue and spec is met.
- **Tested (−3 if not).** New behaviour has tests that would fail without the change. Edge cases named in the issue are covered.
- **Conventions (−1 to −2).** Follows the project's AGENTS.md and the style of the surrounding code: naming, structure, documentation.
- **Minimal (−1 to −2).** No unrelated changes, dead code, debug output or new dependencies the issue did not ask for.
- **Correct (−1 to −3).** No obvious bugs, unhandled error paths or security problems.

`passed` is true only when the score is at least 7 and nothing in the first two points is missing.
