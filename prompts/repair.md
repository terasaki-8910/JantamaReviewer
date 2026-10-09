# Repair -- a machine gate failed. Fix the CAUSE. No scope creep, no cheating.

A gate (tests / typecheck / lint) failed; its exact output is appended below. Make the
SMALLEST change that makes THAT gate pass:

- Fix the real cause. Do NOT weaken, skip, `.only`, delete, or loosen a test, and do NOT
  edit ACCEPTANCE.md, to force a green. That is cheating the gate, not passing it.
- If it is a config issue (e.g. lint not ignoring `_`-prefixed unused vars, or not
  ignoring runtime dirs like `state/`), fix the config. If it is a code bug, fix the code.
- Touch ONLY what this failure needs; leave unrelated files alone.
- Commit locally (do not push).
- If you genuinely cannot fix it (needs a human decision, external secret, or the test
  itself is wrong in a way you must not unilaterally change), write a short
  state/BLOCKED-<what>.md explaining the exact blocker, and stop.

Read the appended gate output carefully -- it names the file, line, and rule/assert.
