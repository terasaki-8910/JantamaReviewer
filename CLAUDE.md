# Project: <name>

## What this is
<one-paragraph purpose>. Scope in SPEC.md; pass/fail criteria in ACCEPTANCE.md.

## Workflow
Driven by scripts/run.sh through gated stages (see pipeline.yaml). Do NOT skip gates.
`run.sh auto` is the ONE sanctioned exception: it runs intake as a conversation, then answers
every later human gate itself (repair menu = hybrid, red feature = skipped, green feature =
auto-merged locally). Machine gates still have to pass -- auto never weakens them. Do not
invoke it on my behalf; it is mine to start.
Intake proposes per-project tools (MCP/plugins/skills): Claude proposes, I approve, I
run state/init-tools.sh myself. Never auto-install or enable tools.

## Language
Generated artifacts (code, comments, docs, commit messages, UI copy) default to English.
Change here to override per project. The language I chat in is separate and unaffected.

## Commands
- Tests: <e.g. npm test / pytest>
- Lint:  <e.g. npm run lint>   (MUST include: no-emoji, design-tokens-only, a11y)

## UI rules
IMPORTANT: colors ONLY via design tokens; never hardcode hex. No emoji in UI or source.
Shared personal UI direction: @~/.claude/rules/ui.md

## Stack recipes
If the chosen stack matches a doc under docs/recipes/ (e.g. docs/recipes/
tauri-desktop-app.md for a Tauri + pnpm desktop app), read it during intake/design and
follow its documented patterns/gotchas -- each one there cost real debugging time on a
prior project, not guessed in advance. If personal shared-infrastructure notes exist at
~/.claude/rules/infra.md (e.g. a self-hosted DB server reused across projects), check
there too -- it stays out of this repo, never committed, since this template is public.

## Do not touch
state/ (runtime), design tokens (change only via the design gate), auto-generated files.

## Git
Local only by default; do NOT push unless asked. Feature branches merge to main with --no-ff.
