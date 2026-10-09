<div align="right">

[![日本語](https://img.shields.io/badge/lang-%E6%97%A5%E6%9C%AC%E8%AA%9E-bc002d?style=flat-square)](./README.md)

</div>

# claude-pipeline-template

A **GitHub template repository** for driving ONE project from a rough idea to a
gated, tested result with Claude Code. Multiple projects run in parallel simply as
separate repos (no shared state). Ralph-style iteration is used *inside* the build
stage only, bounded and gated by tests -- not as an ungated overnight loop.

## Files
- `pipeline.yaml`  -- declarative spec (source of truth). Keep in sync with run.sh.
- `scripts/run.sh` -- POSIX driver: advances stages, stops at human gates (notifies).
- `scripts/gates.sh` -- machine gates (tests / lint / ui). Customize per project.
- `prompts/0X-*.md` -- the "contract" for each stage.
- `CLAUDE.md`      -- project memory (imports your global UI rules).
- `.claude/settings.json` -- SCOPED permissions (see Safety). Not global skip-permissions.
- `Makefile`       -- optional shortcuts (`make plan`, `make build`, `make auto`, ...).

## One-time GLOBAL setup (per machine, NOT in this repo)
1. Stop the git co-author trailer everywhere:
   `~/.claude/settings.json`  ->  { "includeCoAuthoredBy": false }
2. Shared UI direction across all projects:
   copy `docs/ui-rules.starter.md` to `~/.claude/rules/ui.md` and refine it over time.
   `~/.claude/CLAUDE.md` / `~/.claude/rules/` load in every project; scope the UI rule
   to frontend globs so it only loads for UI work (see the rules-directory docs).

## Per-project use
1. On GitHub: make this a Template repository (Settings -> Template repository).
2. For each new project: "Use this template" -> new repo -> clone.
3. In `CLAUDE.md`, set ONLY the project name and a one-line purpose by hand (leave the
   test/lint commands blank -- intake fills them once the stack is chosen, for you to
   confirm). Output language is set in the `Language` field (default English, separate
   from the chat language). If it has a UI, run `touch state/has_ui`.
4. Run the pipeline:  `sh scripts/run.sh all`   (or stage by stage: `... intake`, etc.)
   To run it hands-off, use `sh scripts/run.sh auto` (see "Unattended run" below).
   Intake is GUIDED-CHOICE: start from a one-line description; Claude offers options at
   each decision and you just pick (high-impact decisions first, details later). You can
   always specify your own instead.
5. At the end of intake, Claude PROPOSES per-project tools (MCP/plugins/skills). On your
   approval it writes `state/TOOLING.md` (the proposal) and `state/init-tools.sh` (the add
   commands). To install, review them and run `sh state/init-tools.sh` YOURSELF (never auto).
   Intake also proposes **project-specific .gitignore entries** (so large fixtures/generated
   files aren't swept into the build's `git add -A`).
6. (Optional) `sh scripts/run.sh slim` -- untrack + gitignore the **pipeline machinery**
   (`scripts/`, `prompts/`, `pipeline.yaml`, `Makefile`, `docs/ui-rules.starter.md`) in THIS
   project, so git holds only the deliverable (the machinery stays on disk and still runs).
   Finish with `git commit`. Refused on the template itself (which must track everything to
   distribute via "Use this template").

## Stages (gates)
0 intake (H, once: freeze spec + propose per-project tools -> `TOOLING.md` / `init-tools.sh`)
1 criteria (H)  2 design_gate (UI only, H, once)
3 plan (skim)  4 build (machine gates, per worktree, sequential by default)
5 feature_accept (machine + light H, LOCAL merge)  6 integration_accept (machine + H, once)

## Progress / recovery
- `sh scripts/run.sh status` -- shows which stages are done (`[x]`) and the **exact command
  to continue**. Each stage records `state/done/<stage>` once its human gate passes (design
  shows `[-] n/a` when there is no UI). One glance tells you how far you got and what's next.
- On a gate failure you get a **repair menu**: `1) auto` (repair until it passes) / `2) hybrid`
  [default/Enter, repairs a few times then hands to you] / `3) stop` (**opens an interactive Claude
  seeded with the error** so you fix it, then re-gates after `/exit`). auto/hybrid feed the failing
  output to an agent (real debugging, not blind retry); stop on no-progress; weakening/deleting tests
  to force a pass is forbidden.
- At **DONE** the pipeline prints **NEXT STEPS**: the env vars/secrets you must set (extracted from
  SPEC), external tools, usage (see README), and how to run the tests integration skipped.
- `sh scripts/run.sh reset` -- **recover from a failure**: clears build worktrees, `feature/*`
  branches and checkpoints, keeping spec/criteria/plan (SPEC/ACCEPTANCE/PLAN/tests/gates).
  Then `from build` rebuilds cleanly.

## Unattended run: `sh scripts/run.sh auto` (= `make auto`)
Intake ALONE stays a conversation (the spec is your judgment point, so its Q&A and approval
are untouched). The moment you approve it, the run continues to integration with **zero
further input** -- walk away.

- **Every human gate auto-answers y**: criteria approval, design approval, the plan Enter-
  prompt, each feature's merge confirmation, the final smoke test. Each one is logged as
  `>>> [auto] ... -- auto-approved`, so the transcript shows exactly what was waved through.
- **A failing gate always takes `2) hybrid`** without asking: feed the failure to a repair
  agent up to `REPAIR_ITERS` times (default 4), stop on no-progress.
- **A feature that never goes green is SKIPPED, not fatal**: it is recorded in
  `state/BLOCKED.txt` and NOT merged. Only green features merge (`--no-ff`, LOCAL -- nothing
  is ever pushed).
- **AUTO RUN SUMMARY** at the end: what got skipped, where its logs are, how to resume.
- **Exit codes**: `0` = everything merged + accepted, `2` = finished with skipped features,
  `1` = a stage aborted.
- **What it does NOT relax**: machine gates (tests/lint/ui) still have to pass, permissions
  stay as configured (`PERMISSION_MODE`, the settings.json deny-list -- never
  `--dangerously-skip-permissions`), and tools are still never auto-installed.
- **Loop guard**: if the planner emits the same wave twice with nothing merged (a skipped
  feature being re-proposed forever), the run stops instead of burning quota.
- If intake is already done (`state/done/intake` exists), auto resumes from criteria.
- Works as a prefix on any stage: `AUTO=1 sh scripts/run.sh from build`.

To fix a skipped feature, go back to an attended run: `sh scripts/run.sh from build` gives
you the repair menu again (`3) stop` opens an interactive Claude seeded with the error).

## Optional command: prior-art survey (before build)
`sh scripts/run.sh survey` -- before building from scratch, SEARCH for similar existing
projects and present them (no naming repos from memory = no hallucination). Not part of
`all`. Choose: build from scratch (default) or adopt one as a base. Adopting records
`state/BASE.md` but copies no code -- an adopted base still passes the normal criteria/
build gates and its license is yours to satisfy (existing != trusted).
**Requires** WebSearch enabled (`.claude/settings.json` currently denies WebFetch).

## Optional command: automation recommender (after build)
`sh scripts/run.sh recommend` -- analyzes the **finished code** and PROPOSES Hooks / MCP /
subagents / skills (proposal-only, written to `state/RECOMMENDATIONS.md`; you decide what to
adopt). Uses the `claude-code-setup` plugin's `automation-recommender` skill if installed,
else a built-in equivalent. **Runs automatically at DONE** (`RECOMMEND=0` to disable). It needs
existing code, so it lives after build, not at intake.

## Models
Spec/criteria = Opus, design/build = Sonnet. Set per stage via env
(MODEL_BUILD=sonnet etc.). `opus-plan` is an interactive mode, not a headless model
string -- for headless `plan`, MODEL_PLAN stays a real model. Fable is MANUAL escalation
only (write the blocker to state/BLOCKED-*.md and escalate by hand); never automated,
because some Fable queries route to Opus and it has availability/safeguard caveats.

## Safety (important)
- Each feature builds in an isolated `git worktree`; that isolation is the safety boundary.
- `.claude/settings.json` grants a SCOPED allowlist and denies `rm -rf` / WebFetch. Do NOT run
  `--dangerously-skip-permissions` on your main machine; if you ever do, keep it inside a
  worktree/sandbox only.
- **Push is NOT blocked by the harness** -- `Bash(git push:*)` is not in the deny list. The only
  restraint is the instruction in `CLAUDE.md` ("do NOT push unless asked"). For a hard guard,
  put `"Bash(git push:*)"` back in `deny` (or in the gitignored `.claude/settings.local.json`
  if you don't want it tracked).
- The pipeline itself never pushes -- every `run.sh` stage stays in local git (`auto`'s
  automatic merges are local `--no-ff` merges only).

## How run.sh calls claude (portable, same for every project)
run.sh uses the documented, stable forms -- no per-machine tweaking:
- interactive (intake): `claude "<prompt>"` -- opens the REPL and sends it as message 1.
- headless (criteria/plan/build, ...): `claude -p "<prompt>"`.
Permissions are unified via the scoped allowlist in `.claude/settings.json`. If a future
CLI changes these core flags, fix them in ONE place (`claude_interactive` / `claude_run`)
-- a template edit, not a per-machine one. `--model` is passed per stage via env vars.

## Run-time environment variables (watch progress / control cost)
- `INTERACTIVE=1` -- open criteria/design/plan in the **Claude Code TUI instead of
  headless**: you see progress, get notifications, can steer mid-run, and `/exit` to
  continue. Default 0 = headless/unattended. **intake is always TUI; build is always
  headless** (it runs each feature in a worktree). Example:
  `INTERACTIVE=1 sh scripts/run.sh from plan`
- `REPAIR_ITERS` (default 4) / `REPAIR_HARD_CAP` (default 12) -- auto-repair attempt caps on a
  gate failure (hybrid repairs REPAIR_ITERS times then hands to you; hard cap is the ceiling).
- `PARALLEL=1` -- build features concurrently (default sequential = safer for cost/kill).
- `AUTO=1` -- **unattended mode** (what `run.sh auto` turns on after intake): auto-approve every
  human gate, always pick 2) hybrid on a gate failure, skip a feature that never goes green
  instead of stopping. Usable on a single stage: `AUTO=1 sh scripts/run.sh from criteria`.
- `PERMISSION_MODE` (default acceptEdits) -- headless permission mode.
- `MODEL_*` (INTAKE/CRITERIA/DESIGN/PLAN/BUILD) -- per-stage model.
- Input notifications: human gates (approvals, the plan Enter-prompt) fire a macOS banner,
  **suppressed while the terminal is frontmost** (you can already see it). `NOTIFY_ALWAYS=1`
  to always banner.
