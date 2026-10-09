# Recommend -- project automation from the FINISHED codebase. PROPOSE, do not implement.

The project is built. Analyze the ACTUAL codebase in this repo -- languages, dependencies,
test setup, CI, scripts, and the shape of the code (read files as needed).

If the `/claude-code-setup:claude-automation-recommender` skill (from the claude-code-setup
plugin) is available, USE it. If it is not installed, do the equivalent analysis yourself.

Propose project-SPECIFIC automation, each with a one-sentence reason tied to THIS code:
- Hooks -- edit-time commands (auto-format / lint / typecheck on save) that stop trivial CI
  failures before they happen.
- MCP servers -- only if one grounds this project against a real source of truth (live docs,
  a real endpoint) and earns its standing cost; otherwise say "none needed".
- Subagents -- focused roles for this codebase (e.g. a test runner that explains failures, a
  security / IaC / config reviewer for the risky files you actually see here).
- Skills / commands -- one-shot commands for THIS project's repeated chores (deploy, scaffold
  a new module, run the e2e suite with the key, etc.).

Rules:
- Be concrete and specific -- cite the file / dependency / config that motivates each item.
  No generic best-practice checklist.
- Be a strict senior engineer: name real risks you spot in the code, and say what you would
  deliberately NOT automate and why.
- Do NOT create any .claude/ files, hooks, or configs, and do NOT install anything. Write the
  proposals to state/RECOMMENDATIONS.md; for each item note exactly which file would be created
  if I later say "implement it". I choose what to adopt.
