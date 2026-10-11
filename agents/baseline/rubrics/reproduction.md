# Rubric: bug reproduction

Score each point. Start at 10 and subtract.

- **Reproduces the bug (−5 if not).** The new test exercises the behaviour the issue describes, and it fails today for that reason, not because of a typo, a missing import or a wrong setup.
- **Will pass when fixed (−2 if not).** The assertion states the correct behaviour, so the test turns green once the bug is fixed.
- **Tests only (−3 if not).** No production code was changed.
- **Focused (−1 to −2).** The test is small, named after the bug and placed with the related tests.

`passed` is true only when the score is at least 7 and the first and third points hold.
