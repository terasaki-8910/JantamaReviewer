#!/usr/bin/env sh
# POSIX pipeline driver. One project, gated stages. macOS / Linux / WSL.
# No bashisms, no GNU-only flags. Verify `claude` invocation with `claude --help`.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE="$ROOT/state"; PROMPTS="$ROOT/prompts"
mkdir -p "$STATE/logs" "$STATE/worktrees"
MAIN=$(git -C "$ROOT" symbolic-ref --short HEAD 2>/dev/null || echo main)

# One Ctrl+C tears everything down. build spawns child agents; without this the loop
# and its background jobs can survive SIGINT and keep spending your quota.
trap 'trap - INT TERM; echo; echo "[run.sh] interrupted -- stopping." >&2; kill 0 2>/dev/null' INT TERM

# model per stage (override via env)
: "${MODEL_INTAKE:=opus}"
: "${MODEL_CRITERIA:=opus}"
: "${MODEL_DESIGN:=sonnet}"
: "${MODEL_PLAN:=opus}"
: "${MODEL_BUILD:=sonnet}"
: "${REPAIR_ITERS:=4}"      # hybrid mode: auto-repair attempts before stopping for you
: "${REPAIR_HARD_CAP:=12}"  # absolute cap on repair attempts (cost safety, all modes)
# Headless permission mode. acceptEdits auto-approves edits + common fs commands so
# unattended stages don't hang waiting for approval that a headless run can't answer.
# settings.json still denies push/rm-rf/WebFetch; the allowlist governs test/git.
: "${PERMISSION_MODE:=acceptEdits}"
# INTERACTIVE=1 runs the single-agent stages (criteria/design/plan) in the visible
# Claude Code TUI instead of headless: you watch progress, get native notifications,
# can correct mid-course, and /exit to continue. Default 0 = headless/unattended.
# (build always stays headless -- it runs features in parallel worktrees.)
: "${INTERACTIVE:=0}"
# AUTO=1 -- UNATTENDED. Every human gate auto-approves (no y/N, no Enter), the repair
# menu always picks 2) hybrid without asking, and a feature whose gates never go green is
# SKIPPED (recorded in state/BLOCKED.txt) instead of stopping the run. It does NOT relax
# permissions: PERMISSION_MODE stays as set, settings.json still denies push/rm -rf, and
# tools are still never auto-installed. `run.sh auto` sets this for you AFTER intake.
: "${AUTO:=0}"

. "$ROOT/scripts/gates.sh"

have() { command -v "$1" >/dev/null 2>&1; }

mark_done() { mkdir -p "$STATE/done"; : > "$STATE/done/$1"; }  # checkpoint read by `status`

record_session() {  # best-effort: map the Claude session just run (in CWD) to a stage label
  prompt=$1
  cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  slug=$(printf '%s' "$PWD" | sed 's#/#-#g')          # Claude keys sessions by cwd path
  f=$(ls -t "$cfg/projects/$slug/"*.jsonl 2>/dev/null | head -1)
  [ -n "$f" ] || return 0
  id=$(basename "$f" .jsonl)
  label=$(basename "$prompt" .md | sed 's/^[0-9][0-9]*-//')   # 04-build.md -> build
  case "$PWD" in *"/worktrees/"*) label="$label-$(basename "$PWD")" ;; esac
  mkdir -p "$STATE/sessions"
  printf '%s\t%-26s\t%s\n' "$(date +%H:%M:%S)" "$label" "$id" >> "$STATE/sessions/index.tsv"
  printf '%s\n' "$id" > "$STATE/sessions/$label"
  echo ">> session[$label] = $id   (resume: claude --resume $id)"
}

notify() {  # desktop notification at input/gate points; always prints to the terminal too.
  m=$1
  # Only banner when you're likely NOT looking. If the terminal is already frontmost we
  # skip the banner (you can see the prompt). Detection is macOS-only + heuristic; if it
  # can't tell, it notifies -- better a redundant banner than a missed prompt.
  # Set NOTIFY_ALWAYS=1 to always banner; the terminal print below always happens.
  banner=1
  if [ "${NOTIFY_ALWAYS:-0}" != "1" ] && [ "$(uname 2>/dev/null)" = "Darwin" ] && have osascript; then
    front=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || echo)
    case "$front" in
      Terminal|iTerm2|Warp|WarpTerminal|Ghostty|WezTerm|Alacritty|kitty|Hyper|Tabby|Code|Cursor|Electron) banner=0 ;;
    esac
  fi
  if [ "$banner" = "1" ]; then
    if have terminal-notifier; then terminal-notifier -title "pipeline" -message "$m" -sound Ping >/dev/null 2>&1 || true
    elif have osascript; then osascript -e "display notification \"$m\" with title \"pipeline\" sound name \"Ping\"" >/dev/null 2>&1 || true
    elif have notify-send; then notify-send "pipeline" "$m" >/dev/null 2>&1 || true
    else printf '\a'; fi
  fi
  printf '\n>>> %s\n' "$m"
}

confirm() {  # human gate. $1=message. 0 on yes.
  # AUTO: answer y for you and keep going. The message is still printed so the log shows
  # exactly which judgment points were skipped.
  if [ "$AUTO" = "1" ]; then printf '\n>>> [auto] %s -- auto-approved\n' "$1"; return 0; fi
  notify "$1"; printf 'Approve? [y/N] '
  # Read from the terminal, NOT the caller's stdin -- feature_accept calls this inside
  # `while read feat < features.txt`, so a plain `read` would eat feature lines instead
  # of your keypress. Fall back to stdin, then to N, for headless/CI runs.
  read ans </dev/tty 2>/dev/null || read ans || ans=n
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

claude_run() {  # headless. $1=model $2=promptfile [extra args]
  model=$1; prompt=$2; shift 2
  have claude || { echo "ERROR: 'claude' CLI not found (install Claude Code)." >&2; exit 127; }
  # Headless: pass the prompt as the -p argument (documented invocation).
  # --permission-mode keeps unattended runs from blocking on approval prompts.
  claude --model "$model" --permission-mode "$PERMISSION_MODE" "$@" -p "$(cat "$prompt")" 2>&1 \
    | tee -a "$STATE/logs/$(date +%Y%m%d-%H%M%S).log"
  record_session "$prompt"
}

claude_interactive() {  # human converses. $1=model $2=seed promptfile
  model=$1; prompt=$2
  have claude || { echo "ERROR: 'claude' CLI not found." >&2; exit 127; }
  # Interactive session seeded with the prompt as the first message:
  # `claude "<text>"` opens the REPL AND sends that as message 1, so Claude
  # starts the intake Q&A itself instead of opening blank. (documented flag form)
  claude --model "$model" "$(cat "$prompt")"
}

agent_stage() {  # single-agent stage. $1=model $2=promptfile. Honors INTERACTIVE.
  if [ "$INTERACTIVE" = "1" ]; then claude_interactive "$1" "$2"
  else claude_run "$1" "$2"; fi
}

stage_intake() {
  echo "== 0. intake (interactive, model=$MODEL_INTAKE) =="
  # Intake also PROPOSES per-project tools (MCP/plugins/skills). Claude proposes,
  # you approve, you run init-tools.sh. Nothing is installed automatically.
  claude_interactive "$MODEL_INTAKE" "$PROMPTS/00-intake.md"
  confirm "Stage 0: SPEC.md / ACCEPTANCE.md frozen AND tool proposal (state/TOOLING.md) approved?" \
    || { echo "Not approved."; exit 1; }
  if [ -f "$STATE/init-tools.sh" ]; then
    notify "Optional: review state/init-tools.sh, then run it YOURSELF to add tools. Nothing was installed automatically."
  fi
  mark_done intake
}

stage_criteria() {
  echo "== 1. author criteria (model=$MODEL_CRITERIA) =="
  agent_stage "$MODEL_CRITERIA" "$PROMPTS/01-criteria.md"
  confirm "Stage 1: failing tests + lint config approved?" || { echo "Not approved."; exit 1; }
  mark_done criteria
}

stage_design_gate() {
  [ -f "$STATE/has_ui" ] || { echo "== 2. design gate: skipped (no UI) =="; mark_done design; return 0; }
  echo "== 2. design gate (model=$MODEL_DESIGN) =="
  agent_stage "$MODEL_DESIGN" "$PROMPTS/02-design-gate.md"
  confirm "Stage 2: aesthetic direction / tokens approved (ONE time)?" \
    || { echo "Iterate prompts/02, then rerun 'design'."; exit 1; }
  mark_done design
}

stage_plan() {
  echo "== 3. plan (model=$MODEL_PLAN) =="
  agent_stage "$MODEL_PLAN" "$PROMPTS/03-plan.md"
  if [ "$AUTO" = "1" ]; then
    echo ">>> [auto] plan: skipping the PLAN.md / features.txt skim."
  else
    notify "plan: skim PLAN.md + state/features.txt, then press Enter to continue."
    read _ </dev/tty 2>/dev/null || read _ || true
  fi
  mark_done plan
}

record_skipped() {  # remember a feature whose gates never went green
  printf '%s\n' "$1" >> "$STATE/skipped.txt"                       # this wave (accept reads it)
  printf '%s\t%s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$1" >> "$STATE/BLOCKED.txt"  # whole run (summary)
}

is_skipped() { [ -f "$STATE/skipped.txt" ] && grep -qx -- "$1" "$STATE/skipped.txt"; }

gate_feature() {  # $1=feature. Gate ONLY this feature if a per-feature gate exists,
  # else fall back to the whole-repo gate. A single-feature worktree does NOT contain
  # sibling features' code, so the whole-repo suite can never be green here.
  gf="$STATE/gates/$1"
  if [ -f "$gf" ]; then ( sh "$gf" ); else gate_all; fi
}

choose_repair_mode() {  # print auto|hybrid|stop on stdout. Numbered menu, default hybrid.
  # AUTO: take the default (2 = hybrid) without prompting -- repair up to REPAIR_ITERS
  # times, then give up on THIS feature rather than blocking on a human.
  if [ "$AUTO" = "1" ]; then
    echo "  A gate failed. [auto] choosing 2) hybrid (repair up to ${REPAIR_ITERS:-4}x)." >&2
    echo hybrid; return 0
  fi
  # Arrow-key selection is not portable/robust in POSIX sh, so this is a numbered prompt.
  {
    echo ""
    echo "  A gate failed. How should the pipeline handle it?"
    echo "    1) auto   -- keep feeding the error to an agent until the gate passes"
    echo "    2) hybrid -- auto-repair up to ${REPAIR_ITERS:-4}x, then stop for you   [default]"
    echo "    3) stop   -- stop now; you fix it, then resume"
    printf "  choose [1/2/3, Enter=2]: "
  } >&2
  read c </dev/tty 2>/dev/null || read c || c=2
  case "$c" in 1) echo auto ;; 3) echo stop ;; *) echo hybrid ;; esac
}

repair_agent() {  # $1=model $2=gatelog -- feed the FAILING gate output to a repair agent
  claude --model "$1" --permission-mode "$PERMISSION_MODE" -p \
"$(cat "$PROMPTS/repair.md")

--- FAILING GATE OUTPUT (fix ONLY what makes this pass) ---
$(cat "$2")" 2>&1 | tee -a "$STATE/logs/$(date +%Y%m%d-%H%M%S).log"
  record_session "$PROMPTS/repair.md"
}

run_and_repair() {  # $1=label $2=cwd $3=gate(command string) $4=repair model
  label=$1; cwd=$2; gate=$3; rmodel=$4
  if ( cd "$cwd" && eval "$gate" ); then return 0; fi          # visible run; pass -> done
  log="$STATE/logs/gate-$label-$(date +%Y%m%d-%H%M%S).log"
  ( cd "$cwd" && eval "$gate" ) >"$log" 2>&1 || true           # capture the failure for the agent
  echo ""; echo "[$label] gate FAILED. last lines:"; tail -n 20 "$log" 2>/dev/null || true
  mode=$(choose_repair_mode)
  if [ "$mode" = "stop" ]; then
    echo "[$label] opening an INTERACTIVE Claude (not headless) with the error loaded."
    echo "        Fix it in the session, then /exit -- the gate is re-checked afterwards."
    have claude && ( cd "$cwd" && claude --model "$rmodel" \
"$(cat "$PROMPTS/repair.md")

--- FAILING GATE OUTPUT ---
$(cat "$log")" ) || true
    if ( cd "$cwd" && eval "$gate" ); then echo "[$label] gate GREEN after your session."; return 0; fi
    echo "[$label] still failing -- rerun this stage when ready."; return 1
  fi
  n=0; prev=""
  while :; do
    n=$((n + 1)); echo "[$label] repair attempt $n (mode=$mode) -- feeding the error to an agent..."
    ( cd "$cwd" && repair_agent "$rmodel" "$log" ) || true
    if ( cd "$cwd" && eval "$gate" ) >"$log" 2>&1; then echo "[$label] gate GREEN after repair."; return 0; fi
    echo "[$label] still failing:"; tail -n 15 "$log" 2>/dev/null || true
    head=$(git -C "$cwd" rev-parse HEAD 2>/dev/null || echo none)   # no-progress guard
    if [ "$head" = "$prev" ]; then echo "[$label] repair made no new commit -- stopping."; return 1; fi
    prev=$head
    if [ "$mode" = "hybrid" ] && [ "$n" -ge "${REPAIR_ITERS:-4}" ]; then
      echo "[$label] hybrid cap ($n) reached -- stopping for you. Fix or rerun."; return 1
    fi
    if [ "$n" -ge "${REPAIR_HARD_CAP:-12}" ]; then echo "[$label] hard cap reached -- stopping."; return 1; fi
  done
}

build_feature() {  # $1=feature. Build in its worktree, gate it; on failure REPAIR (feed the
  feat=$1; wt="$STATE/worktrees/$feat"                          # error to an agent), never blind-retry.
  echo "-- build $feat --"
  # A fresh `git worktree add` checkout has no node_modules. Install BEFORE the build
  # agent/gate run (mirrors stage_integration_accept's root install below). Without this,
  # a headless build/repair agent can only diagnose the missing-deps error, never fix it --
  # installing is a network-touching command that headless (-p) mode can't get approved
  # mid-run (no TTY to prompt), so it silently fails instead of unblocking the gate.
  if [ -f "$wt/package.json" ] && [ ! -d "$wt/node_modules" ]; then
    echo "-- $feat: installing dependencies (first run in this worktree) --"
    if have pnpm; then ( cd "$wt" && pnpm install >/dev/null 2>&1 || true )
    else ( cd "$wt" && npm install >/dev/null 2>&1 || true ); fi
  fi
  ( cd "$wt" && claude_run "$MODEL_BUILD" "$PROMPTS/04-build.md" ) || true
  if run_and_repair "build-$feat" "$wt" "gate_feature '$feat'" "$MODEL_BUILD"; then
    echo "$feat: gates GREEN."; return 0
  fi
  record_skipped "$feat"
  echo "$feat: not green. See state/BLOCKED-* and state/logs." >&2; return 1
}

stage_build() {
  echo "== 4. build (parallel per feature, model=$MODEL_BUILD) =="
  [ -f "$STATE/features.txt" ] || { echo "Missing state/features.txt (run plan)."; exit 1; }
  : > "$STATE/skipped.txt"   # per-wave ledger; feature_accept refuses to merge what's in it
  # Commit approved scaffolding (spec + criteria + plan: SPEC/ACCEPTANCE/PLAN, package.json,
  # tests, configs) to the base branch so each feature worktree inherits it. state/ is
  # gitignored, so orchestration artifacts stay out of git.
  git -C "$ROOT" add -A >/dev/null 2>&1 || true
  git -C "$ROOT" commit -q -m "pipeline: baseline (spec + criteria + plan)" >/dev/null 2>&1 || true
  # clean stale worktrees from a previous run, then (re)create them
  git -C "$ROOT" worktree prune 2>/dev/null || true
  while IFS= read -r feat; do
    [ -n "$feat" ] || continue
    git worktree add -B "feature/$feat" "$STATE/worktrees/$feat" 2>/dev/null \
      || git worktree add "$STATE/worktrees/$feat" -b "feature/$feat" 2>/dev/null || true
  done < "$STATE/features.txt"
  # Build features. SEQUENTIAL by default (safer for cost + killability). Set PARALLEL=1
  # to build them concurrently in their worktrees.
  rc=0
  if [ "${PARALLEL:-0}" = "1" ]; then
    pids=""
    while IFS= read -r feat; do
      [ -n "$feat" ] || continue
      build_feature "$feat" & pids="$pids $!"
    done < "$STATE/features.txt"
    for pid in $pids; do wait "$pid" || rc=1; done
  else
    while IFS= read -r feat; do
      [ -n "$feat" ] || continue
      build_feature "$feat" || rc=1
    done < "$STATE/features.txt"
  fi
  if [ "$rc" -ne 0 ]; then
    if [ "$AUTO" = "1" ]; then   # skip what stayed red, keep the run going
      echo ">>> [auto] gates never went green for: $(tr '\n' ' ' < "$STATE/skipped.txt")"
      echo ">>> [auto] those features are SKIPPED (not merged); continuing."
    else
      echo "Some features failed gates; see state/BLOCKED-*.md. Resume: sh scripts/run.sh from build"; exit 1
    fi
  fi
  mark_done build
}

stage_feature_accept() {
  echo "== 5. feature acceptance + LOCAL merge (no push) =="
  while IFS= read -r feat; do
    [ -n "$feat" ] || continue
    if is_skipped "$feat"; then   # red gates -> never merge it, auto or not
      echo "--- feature: $feat -- SKIPPED (gates never green); NOT merged. ---"; continue
    fi
    echo "--- feature: $feat ---"
    git -C "$ROOT" --no-pager log --oneline "$MAIN..feature/$feat" 2>/dev/null || true
    confirm "Merge feature/$feat to main? (gates green + GUI look done)" \
      || { echo "Skipped $feat."; continue; }
    git -C "$ROOT" checkout "$MAIN"
    git -C "$ROOT" merge --no-ff "feature/$feat" -m "merge feature/$feat"
    git worktree remove "$STATE/worktrees/$feat" 2>/dev/null || true
  done < "$STATE/features.txt"
  mark_done accept
}

stage_integration_accept() {
  echo "== 6. integration acceptance (once) =="
  # gates run in the MAIN repo; deps were installed in the worktrees, so install here too.
  if [ -f "$ROOT/package.json" ]; then ( cd "$ROOT" && npm install >/dev/null 2>&1 || true ); fi
  if ! run_and_repair "integration" "$ROOT" "gate_all" "$MODEL_BUILD"; then
    echo "Integration gates failed. Fix, then resume: sh scripts/run.sh from integrate"; exit 1
  fi
  confirm "Final smoke test passed on device/browser?" || { echo "Not accepted."; exit 1; }
  echo "== 7. DONE =="
  mark_done integrate
  stage_done
  if [ "${RECOMMEND:-1}" = "1" ]; then stage_recommend; fi   # auto propose-automation at DONE
}

stage_done() {  # print what the human still has to do: configure secrets/env, how to run,
  spec="$ROOT/SPEC.md"                                   # and what integration left unverified.
  echo ""
  echo "==================== NEXT STEPS ===================="
  echo "Build complete and integration-accepted. Local git only (not pushed)."
  echo "Full install / usage / setup: README.md."
  echo ""
  echo "Before running it for real, configure what SPEC.md requires:"
  if [ -f "$spec" ]; then
    grep -hoE "[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)*_(KEY|TOKEN|SECRET|URL|ID|PASSWORD)" "$spec" 2>/dev/null \
      | sort -u | while IFS= read -r v; do echo "  - env var: $v   (export $v=...  or add to .env)"; done
    for t in ffmpeg ffprobe docker psql redis; do
      if grep -qiw "$t" "$spec" 2>/dev/null; then echo "  - tool on PATH: $t"; fi
    done
  fi
  echo "  - tests SKIPPED in integration (e.g. live E2E) run only once the above is set."
  echo "  - run them for real, then re-run: sh scripts/run.sh from integrate"
  echo "===================================================="
}

stage_recommend() {  # PROPOSE project automation (Hooks/MCP/subagents/skills) from the built code.
  [ -f "$ROOT/SPEC.md" ] || { echo "recommend: no project yet (run the pipeline first)."; return 0; }
  echo ""; echo "== recommend: analyze the codebase, PROPOSE automation (nothing implemented) =="
  ( cd "$ROOT" && claude_run "$MODEL_INTAKE" "$PROMPTS/recommend.md" )
  if [ -f "$STATE/RECOMMENDATIONS.md" ]; then
    echo ">> proposals in state/RECOMMENDATIONS.md -- you decide what to adopt (nothing was implemented)."
  fi
}

stage_slim() {  # PROJECT ONLY: untrack the pipeline machinery so git holds just the deliverable.
  # GUARD: refuse on the bare template (it must keep tracking everything to distribute via
  # "Use this template"). A real project has SPEC.md and a filled-in CLAUDE.md name.
  if [ ! -f "$ROOT/SPEC.md" ] || grep -q '^# Project: <name>' "$ROOT/CLAUDE.md" 2>/dev/null; then
    echo "slim: this looks like the TEMPLATE, not a project (no SPEC.md / unfilled CLAUDE.md)." >&2
    echo "      Run slim ONLY inside a project built from the template." >&2
    return 1
  fi
  # untrack the machinery (files stay on disk so the pipeline still runs)
  for p in scripts prompts pipeline.yaml Makefile docs/ui-rules.starter.md; do
    git -C "$ROOT" rm -r --cached --quiet "$p" 2>/dev/null || true
  done
  if ! grep -q '^/scripts/$' "$ROOT/.gitignore" 2>/dev/null; then
    {
      echo ""
      echo "# pipeline machinery -- kept on disk to run, NOT part of the deliverable repo"
      echo "/scripts/"
      echo "/prompts/"
      echo "/pipeline.yaml"
      echo "/Makefile"
      echo "/docs/ui-rules.starter.md"
    } >> "$ROOT/.gitignore"
  fi
  git -C "$ROOT" add .gitignore >/dev/null 2>&1 || true
  echo "slim: pipeline machinery untracked + ignored. git now holds just the project."
  echo "  finalize with:  git commit -m 'chore: keep only the deliverable in git'"
  echo "  (run.sh / prompts / gates.sh remain on disk and still work.)"
}

stage_survey() {  # OPTIONAL prior-art survey; NOT part of `all`. Needs WebSearch enabled.
  echo "== survey: prior-art (interactive, model=$MODEL_INTAKE) =="
  claude_interactive "$MODEL_INTAKE" "$PROMPTS/survey.md"
}

stage_readme() {  # generate project README.md + README.en.md from SPEC (reproducible)
  [ -f "$ROOT/SPEC.md" ] || { echo "readme: SPEC.md missing (run intake first)."; return 0; }
  echo "== readme: generate project README(s) from SPEC (model=$MODEL_INTAKE) =="
  claude_run "$MODEL_INTAKE" "$PROMPTS/readme.md"
}

stage_status() {  # show which stages are done + the command to continue
  echo "== pipeline status: $(basename "$ROOT") =="
  next=""
  for s in intake criteria design plan build accept integrate; do
    if [ "$s" = design ] && [ ! -f "$STATE/has_ui" ] && [ ! -f "$STATE/done/design" ]; then
      printf '  [-] %s (n/a: no UI)\n' "$s"; continue
    fi
    if [ -f "$STATE/done/$s" ]; then printf '  [x] %s\n' "$s"
    else printf '  [ ] %s\n' "$s"; [ -z "$next" ] && next="$s"; fi
  done
  echo ""
  if [ -s "$STATE/BLOCKED.txt" ] && [ "${SUMMARY_CONTEXT:-0}" != "1" ]; then
    echo "Skipped by an auto run (unmerged, gates red):"
    cut -f2 "$STATE/BLOCKED.txt" | sort -u | sed 's/^/  ! /'
    echo ""
  fi
  if [ -z "$next" ]; then echo "All stages complete."; return 0; fi
  echo "Next: $next"
  echo "  run:           sh scripts/run.sh from $next"
  echo "  watch in TUI:  INTERACTIVE=1 sh scripts/run.sh from $next"
  echo "  unattended:    sh scripts/run.sh auto        (no prompts after intake)"
}

stage_sessions() {  # list recorded Claude session ids (resume a headless run by id)
  f="$STATE/sessions/index.tsv"
  [ -f "$f" ] || { echo "No sessions recorded yet (they are written as stages run)."; return 0; }
  echo "== recorded sessions -- resume any with: claude --resume <id> =="
  printf 'time\t\tstage\t\t\tsession-id\n'
  cat "$f"
}

stage_reset() {  # clear BUILD artifacts (worktrees, feature/* branches, checkpoints) so you
  # can cleanly re-run. Keeps spec/criteria/plan (SPEC/ACCEPTANCE/PLAN/tests/gates/features).
  git -C "$ROOT" worktree prune 2>/dev/null || true
  for w in "$STATE"/worktrees/*/; do
    [ -d "$w" ] && git -C "$ROOT" worktree remove --force "$w" 2>/dev/null || true
  done
  for b in $(git -C "$ROOT" branch --list 'feature/*' 2>/dev/null | sed 's/[* ]//g'); do
    git -C "$ROOT" branch -D "$b" 2>/dev/null || true
  done
  rm -rf "$STATE/worktrees" "$STATE/done" 2>/dev/null || true
  rm -f "$STATE"/BLOCKED-*.md "$STATE/skipped.txt" "$STATE/BLOCKED.txt" 2>/dev/null || true
  mkdir -p "$STATE/worktrees"
  echo "reset: worktrees + feature/* branches + checkpoints cleared. spec/criteria/plan kept."
  echo "re-run:  sh scripts/run.sh from build   (or  from plan  to redo planning)"
}

stage_waves() {  # plan -> build -> accept, looped over successive dependency waves
  w=0; prev_wave=""
  while [ "$w" -lt 12 ]; do
    w=$((w + 1)); echo "== build round $w =="
    stage_plan   # re-plans: writes the NEXT wave to features.txt, or EMPTY when all built
    if ! grep -q '[^[:space:]]' "$STATE/features.txt" 2>/dev/null; then
      echo "== all planned features are built =="; return 0
    fi
    # AUTO no-progress guard: a skipped feature stays unbuilt, so the planner can keep
    # re-emitting the SAME wave forever. Identical wave twice = nothing is clearing; stop
    # instead of burning quota on 12 rounds of the same failing repair loop.
    wave=$(tr '\n' ' ' < "$STATE/features.txt")
    if [ "$AUTO" = "1" ] && [ "$wave" = "$prev_wave" ]; then
      echo "waves: [auto] the same wave was planned twice with nothing merged -- stopping." >&2
      return 1
    fi
    prev_wave=$wave
    stage_build
    stage_feature_accept
  done
  echo "waves: safety cap (12) hit -- a wave is not clearing; check PLAN.md / features.txt." >&2
  exit 1
}

auto_summary() {  # printed on EVERY exit path of an auto run (trap), success or not
  st=$?   # MUST stay first: the status the run is exiting with
  echo ""
  echo "==================== AUTO RUN SUMMARY ===================="
  if [ -s "$STATE/BLOCKED.txt" ]; then
    echo "Features SKIPPED -- gates never went green, NOT merged to $MAIN:"
    sed 's/^/  - /' "$STATE/BLOCKED.txt"
    echo ""
    echo "  why:   state/BLOCKED-*.md  +  state/logs/gate-build-*.log"
    echo "  retry: sh scripts/run.sh from build        (attended: you get the repair menu)"
    [ "$st" -eq 0 ] && st=2      # finished, but not everything shipped -- don't look green
  else
    echo "No features were skipped."
  fi
  echo ""
  SUMMARY_CONTEXT=1 stage_status  # (it would repeat the skip list above)
  echo "exit $st  -- 0=all merged+accepted, 2=finished with skipped features, 1=stage aborted"
  echo "========================================================="
  trap - EXIT
  exit "$st"
}

stage_auto() {  # UNATTENDED run: intake stays a conversation, everything after it is hands-off.
  # Intake is the one real judgment point (the spec is yours), so it keeps its Q&A and its
  # approval prompt. From the next stage on: no y/N, no Enter, repair menu = 2 (hybrid),
  # green features auto-merge to $MAIN (still LOCAL -- nothing is ever pushed).
  if [ -f "$STATE/done/intake" ]; then
    echo "== auto: intake already done -- resuming unattended from criteria =="
    start=criteria
  else
    echo "== auto: stage 0 intake is INTERACTIVE (the spec is yours to approve) =="
    echo "         everything after it runs unattended -- walk away once intake is approved."
    stage_intake                       # AUTO is still 0 here: real Q&A, real approval
    start=readme
  fi
  AUTO=1; export AUTO
  INTERACTIVE=0                        # every post-intake stage stays headless
  : > "$STATE/BLOCKED.txt"             # fresh failure ledger for THIS run
  trap 'auto_summary' EXIT             # summarize even if a stage exits early
  echo ""
  echo "== auto: unattended from '$start' through integration =="
  echo "   gates auto-approved | repair=2 hybrid (${REPAIR_ITERS:-4}x) | red feature = skipped"
  echo "   permissions unchanged ($PERMISSION_MODE); no push; no tool auto-install."
  run_from "$start"
}

run_from() {  # run the given stage and every stage after it, in order
  start=$1
  case "$start" in plan|build|accept|waves) start=waves ;; esac  # these collapse into the wave loop
  on=0
  for s in intake readme criteria design waves integrate; do
    [ "$s" = "$start" ] && on=1
    [ "$on" = "1" ] || continue
    case "$s" in
      intake)    stage_intake ;;
      readme)    stage_readme ;;
      criteria)  stage_criteria ;;
      design)    stage_design_gate ;;
      waves)     stage_waves ;;
      integrate) stage_integration_accept ;;
    esac
  done
  [ "$on" = "1" ] || { echo "unknown stage: $start" >&2; exit 2; }
}

main() {
  case "${1:-all}" in
    intake)    stage_intake ;;
    criteria)  stage_criteria ;;
    design)    stage_design_gate ;;
    plan)      stage_plan ;;
    build)     stage_build ;;
    accept)    stage_feature_accept ;;
    waves)     stage_waves ;;                  # build ALL remaining dependency waves
    integrate) stage_integration_accept ;;
    survey)    stage_survey ;;
    readme)    stage_readme ;;
    status)    stage_status ;;                # show progress + next command
    sessions)  stage_sessions ;;              # list recorded session ids (resume/inspect)
    recommend) stage_recommend ;;             # propose automation from the built codebase
    slim)      stage_slim ;;                  # PROJECT: untrack pipeline machinery (git = deliverable only)
    reset)     stage_reset ;;                 # clear build artifacts to recover cleanly
    auto)      stage_auto ;;                  # UNATTENDED: intake interactive, rest no-prompts
    from)      run_from "${2:-criteria}" ;;   # resume: run this stage -> end
    all)       run_from intake ;;
    *) echo "usage: run.sh [status|sessions|intake|readme|criteria|design|plan|build|accept|waves|integrate|recommend|slim|survey|reset|all|auto|from <stage>]"; exit 2 ;;
  esac
}
main "$@"
