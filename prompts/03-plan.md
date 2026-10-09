# Stage 3 -- Plan. NO implementation.

Read SPEC.md and ACCEPTANCE.md. Produce (exact paths matter -- run.sh reads them):
- PLAN.md (repo root): decompose into the smallest useful feature units; note
  dependencies. Root, so it is committed and visible inside build worktrees.
- state/features.txt: the NEXT buildable WAVE -- the unbuilt features whose dependencies
  are ALL already committed in main (inspect which src/ modules already exist). One
  feature per line, mutually independent (disjoint files, no shared mutable state) so they
  build in parallel worktrees. Dependent features stay in PLAN.md notes until their wave.
  **If every feature in PLAN.md already exists in main, write an EMPTY state/features.txt**
  -- that signals the driver the project is fully built and to stop. Re-running plan after
  a wave merges naturally advances to the next wave.
- state/gates/<feature>: for EACH feature in features.txt, a shell snippet that gates
  ONLY that feature -- run just its own test file(s) and typecheck/lint its own source
  (e.g. `npx vitest run tests/chunk.test.ts` plus eslint/tsc on that feature's files).
  A single-feature worktree does NOT contain sibling features' code, so the whole-repo
  `npm test` can NEVER pass there -- that is why the per-feature gate is mandatory.
  Cross-cutting / e2e tests belong to integration acceptance, not to any one feature.
  If a feature has no unit test, gate it on typecheck of its own files only.

Keep each feature small enough to verify against ACCEPTANCE.md.
