# Stage 0 -- Intake (interactive, GUIDED CHOICE). DO NOT write feature code.

I start with a rough one-line description of what I want. From there, DRIVE the intake
as a series of decisions -- do NOT make me spec everything from scratch.

How to run intake (guided choice):
- Handle ONE decision at a time (or a small batch). For each, PRESENT 2-4 concrete
  options with a one-line tradeoff each, mark your recommended default, and ask me to
  pick. Always allow "or I specify my own."
- ORDER BY IMPACT: high-impact, hard-to-reverse decisions FIRST (language/stack, core
  approach, scope boundaries); cosmetic/detail decisions LAST. Surfacing a mismatch
  early is cheap; late rework is expensive.
- Keep options realistic and specific to what I described -- no generic menus.
- Question my premises; separate "can build" from "should build"; propose scope cuts.
- Mark anything unverified as unverified. Do not invent facts.
- Write every artifact (SPEC.md, ACCEPTANCE.md, code, comments, commits) in the language
  set in CLAUDE.md > Language (default English), no matter what language I chat in.

Once decisions are settled and internally consistent, produce:
- SPEC.md -- what we build; scope IN and explicitly OUT; constraints.
- ACCEPTANCE.md -- machine-judgeable acceptance criteria, each phrased pass/fail and
  checkable by a test or a lint rule. No vague criteria.
- If this project has a UI: design_brief.md -- a few concrete do/avoid rules. Import my
  global UI rules if present: @~/.claude/rules/ui.md
- CLAUDE.md Commands: once the stack is chosen, fill in the test/lint commands and show
  them for my confirmation. I set the project name + one-line purpose by hand; you fill
  the stack-dependent parts -- never guess them before the stack is decided.
- .claude/settings.json permissions: once the stack is chosen, check whether its install/
  test/lint/build commands (e.g. `pnpm install`, `cargo test`, `poetry install`) are
  covered by the existing allow-list. If not, propose the missing entries and show them
  for my confirmation before adding -- headless build/repair agents cannot get an
  unlisted command approved mid-run (no TTY to prompt) and will silently stall instead
  of fixing the gate.
- The moment the stack is decided, check docs/recipes/ for a doc matching it (e.g.
  docs/recipes/tauri-desktop-app.md for a Tauri + pnpm desktop app). If one matches, read
  it now and fold its known gotchas/patterns into SPEC.md/the stack decision itself,
  rather than rediscovering them later during build. This is a one-time intake check --
  don't re-read it every session; CLAUDE.md's "Stack recipes" line is only a fallback
  reminder for later sessions that skipped this step.
- .gitignore: propose PROJECT-SPECIFIC ignore rules to add on top of the base file, and
  show them for my approval before appending. The build stage commits with `git add -A`,
  so anything untracked and NOT ignored WILL be committed (and copied into every build
  worktree). Ignore large test fixtures / binaries (sample audio/video, datasets),
  generated output, and local data dirs -- name the exact paths from SPEC (e.g. the test
  media file). Keep test SOURCE files tracked (worktrees need them). Secrets (`.env`) are
  already ignored by the base file; never commit them.

## Tooling proposal (only AFTER SPEC/ACCEPTANCE are agreed -- PROPOSE, never install)
Once SPEC.md and ACCEPTANCE.md are settled, look at what THIS project builds and
propose the tools (MCP servers, plugins, skills) that fit it.
- Tailor to the project. Infer from SPEC: e.g. web UI -> a browser/visual-check tool;
  RDF/SPARQL -> a SPARQL validate tool; iOS -> the Xcode tool; a large codebase ->
  a code-search tool. Do NOT propose a generic catalog.
- Selection rule: add a tool ONLY if it grounds the model against a source of truth
  (real docs, a real endpoint, real rendered output) or enforces a deterministic
  check. Reject tools that merely add more generation or convenience. Keep the
  standing set small -- more tools = more context, slower, larger trust surface.
- Present the proposal as a short list, one sentence of reasoning per line, and WAIT
  for my approval. Revise on my feedback.

You DO NOT install, add, or enable anything yourself. After I approve, write exactly
two files and stop:
- state/TOOLING.md -- the approved list, grouped (MCP / plugins / skills), each line
  with its reason and its scope (project .mcp.json / user / plugin).
- state/init-tools.sh -- the exact commands to add the approved tools, each preceded
  by a comment saying what it does. Begin the file with:
    #!/usr/bin/env sh
    # REVIEW before running. Nothing here has been executed. You run it yourself.
    set -eu
  For project-scope MCP servers, write them into .mcp.json instead; they appear as
  "Pending approval" on next launch and I approve them interactively (expected).
Nothing takes effect until I approve and I (the human) run init-tools.sh myself.
