# Stage 4 -- Build ONE feature (isolated worktree, looped until gates green).

You are on a feature branch in an isolated git worktree. Read SPEC.md, ACCEPTANCE.md,
PLAN.md, and the design tokens. Implement the current feature so machine gates pass:
tests green, lint clean (no emoji, tokens only, a11y), UI checks pass.

Rules:
- Your gate is THIS feature's own test target ONLY (see state/gates/<feature>). Sibling
  features' test files import src/ modules that do NOT exist in this worktree -- that is
  expected and NOT your job to fix. Make only your feature's own tests + typecheck green.
  Do NOT run the whole-repo `npm test`; run your feature's test file(s).
- Use approved design tokens; never hardcode colors or add emoji.
- Make the SMALLEST change that turns the relevant failing tests green.
- If a genuinely hard architecture/debug problem blocks you, STOP and write the blocker
  to state/BLOCKED-<feature>.md for me to escalate to a stronger model. Do not guess wildly.
- Do not touch files outside this feature's scope. Commit LOCALLY; do not push.
