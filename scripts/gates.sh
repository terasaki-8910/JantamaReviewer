#!/usr/bin/env sh
# Machine gates. Sourced by run.sh; run inside the feature worktree CWD.
# Put OS-specific TEXT scans (no-emoji, hardcoded-color) in your LINTER
# (eslint/stylelint plugins), NOT here -- keeps this portable. See README.
gate_tests() {
  if [ -f package.json ] && grep -q '"test"' package.json; then npm test --silent
  elif [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -d tests ]; then python -m pytest -q
  else echo "gate_tests: no runner detected -- edit gates.sh"; return 0; fi
}
gate_lint() {
  # no-emoji / design-tokens-only / a11y rules live HERE (linter config).
  if [ -f package.json ] && grep -q '"lint"' package.json; then npm run --silent lint
  else echo "gate_lint: no lint script -- see README to add UI rules"; return 0; fi
}
gate_ui() {
  # responsive/contrast: wire playwright screenshot-diff + axe here.
  if [ -x scripts/ui-check.sh ]; then scripts/ui-check.sh; else return 0; fi
}
gate_all() { gate_tests && gate_lint && gate_ui; }
