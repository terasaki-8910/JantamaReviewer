---
name: decision-sheet
description: Put the user's open decisions on one visual confirmation sheet -- an Artifact page with real samples whose answers save to its database -- and read the answers back before building. Use whenever work needs the user's judgment (intent, visuals, wording, scope, tradeoffs, conflicting instructions), at a human gate, or when the user asks for a 確認シート or an "is this what you mean?" check.
---

# Decision sheet

The user opens one page, looks at real samples, picks answers, and leaves.
Answers save as they go; the user says "answered" in chat and you read them
yourself. A single quick question with nothing to look at can go through
AskUserQuestion instead.

## 1. Collect the questions
- Read the project's decisions record and the task docs first. Don't re-ask
  what is decided; what isn't written down is undecided. A disagreement
  between sources is itself a question. If there is no record and the work
  spans sessions, ask where to keep one.
- Everything pending for this gate goes on one sheet: results waiting for
  acceptance, samples for the next task, wording with drafts, findings
  outside the task (bugs, ideas), and the after-build step ("merge if checks
  pass" / "show me first").
- Every question must change what you do. If no answer would, decide it and
  list it under "decided without asking" so it can still be vetoed.
- Questions must hold in any combination of answers; write a dependency into
  the question ("if B in R2-3, ..."). Defer a question to a later round only
  when it can't be answered before something is built, and say so.

## 2. Make the samples real
- Show, don't describe. Build the options for real when feasible (in a git
  worktree, nothing merged) and show the output: screenshots for UI, real
  output on real input for code or data, the actual text in place for
  wording. Mock only when building is out of proportion, and label mocks.
- UI: phone (390px) and desktop (1280px), light and dark, unless the change
  can't differ between them.
- Check every sample with a script before publishing (screenshots plus
  DOM/geometry/pixel assertions). A wrong sample wastes a round.
- Link the running sample and the current version (local URLs, branch) so
  both can be opened side by side.

## 3. Build the sheet
Publish with the Artifact tool, following its own setup steps; the page
declares the `db` capability.
- Use the user's language throughout. Quote their wording and the spec's
  verbatim.
- Top: what this round covers, the state of the work (uncommitted / branch /
  live), the number of questions, a save-status line.
- Per question: a stable id (R<round>-<n>), one or two sentences of context,
  2-4 options side by side with their samples (click to enlarge), the
  recommended option first with a one-line reason, and a free-text field.
  Text typed with no option picked counts as "other". Use multi-select when
  the answer is a set.
- End with an "anything else" box and how to send.
- Readable in light and dark, usable at phone width and by keyboard.
- Answers: one doc per round, `answers/round<N>` =
  `{ <id>: { choice, note }, updatedAt }`, where `choice` is the option
  value, an array for multi-select, "other", or null. Autosave on every
  change (debounced ~700 ms), restore saved answers on load, show save
  status.
- Fallback: a "copy answers" button that produces plain text for the chat,
  for when the database is unavailable (and in environments without the
  Artifact tool, where the same page is served locally).
- Keep one sheet per project and republish it each round from the same
  file, so the link never changes; earlier rounds stay in the database.
- In chat, post only the link and the number of questions.

## 4. When the user says they've answered
- Read `answers/round<N>` yourself (ArtifactData); never ask for a paste.
  Fold in anything they said in chat meanwhile; if chat and sheet disagree,
  ask.
- Reply with the resulting decisions as a short list, asking only about
  notes that are ambiguous or contradictory.
- Append the decisions to the record under a dated heading, in the user's
  words; later sections override earlier ones.
- Build only what got GO and verify it with machine checks; the result goes
  on the next sheet for acceptance.
