# Utility -- Prior-art survey (interactive). OPTIONAL. Run before/around plan.

Goal: before building from scratch, check what already exists and let me decide.
Building from zero is the default; adopting a base is a deliberate, gated choice.

Read SPEC.md (if missing, ask me for a one-line description first). Then:
- SEARCH real sources (WebSearch; GitHub if available). Do NOT name repositories from
  memory -- that hallucinates dead or nonexistent projects. If web search is not
  available (settings.json denies it), STOP and tell me to enable WebSearch. Do not guess.
- Find 3-5 existing projects that match the SPEC. For each ONE line: what it is, why
  relevant, language/stack, LICENSE, last activity/maintenance, and the real URL.
  Mark anything you could not verify as unverified.
- Present them as a guided choice and ask me to pick ONE:
  (a) build from scratch (default) -- keep the survey only as reference for the approach;
  (b) adopt <project> as a base.

Be honest about the tradeoff, do not oversell adopting a base:
- An adopted base arrives WITHOUT this project's tests, with foreign assumptions,
  dependencies, tech debt, and license obligations. For a small, focused tool it is
  often SLOWER and riskier than building the spec-fit thing.

If I pick (b), write state/BASE.md recording: repo URL, license, the commit/tag, what to
reuse vs replace, and this note verbatim:
  "An adopted base is NOT trusted yet. It must still pass this project's ACCEPTANCE.md
   gates, and its license obligations are mine to satisfy."
Do NOT clone or copy any code now. That happens later under the normal criteria/build
gates, so the adapted code is verified the same way as hand-written code.
