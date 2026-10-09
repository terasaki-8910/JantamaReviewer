# Stage (auto, after intake) -- Generate the project README(s) from SPEC. NO code.

Read SPEC.md and CLAUDE.md. Write two files documenting how to USE this project,
derived ONLY from the agreed SPEC (do not invent features or commands):

- README.en.md -- in English.
- README.md    -- the primary readme, in the maintainer's human language (see CLAUDE.md /
  the project context; Japanese for this user, otherwise English). Same content as the
  English one, translated.

Each file, adapted to what SPEC.md actually describes:
- A top language-switch badge linking to the other file (keep the shields.io style the
  template already uses).
- Title = project name; a one-line purpose.
- Requirements, setup/install, and usage with the EXACT CLI/API/options from SPEC.
- Output/behavior, and the project's constraints and explicit out-of-scope items.
- If SPEC.md has its own "Architecture" section, add one near the end with a Mermaid
  `flowchart` diagram built ONLY from that section (real component names, data flow,
  trust boundaries) -- never a generic/decorative diagram, never hand-drawn as an image.
  GitHub renders Mermaid code blocks natively, so this stays reproducible: regenerating
  this file always regenerates an accurate diagram, no separate image asset to keep in
  sync. Keep it a plain `flowchart` (no external styling/icons); label edges with the
  real mechanism (e.g. "invoke()", "spawn, stdio") where SPEC.md specifies one.
- If this project has a UI and `docs/screenshots/*.png` exist, embed them (via plain
  `<img>` tags, `width="49%"` so two sit side by side) in the section describing that
  UI -- real captured screenshots only, reference the existing files by their existing
  names, never invent placeholder images or alt text describing a screen SPEC.md doesn't
  mention. If the directory doesn't exist or is empty, skip this -- don't fabricate
  screenshots just to fill the section.
- A short "Developed via the gated pipeline" section: `sh scripts/run.sh from <stage>`
  and `INTERACTIVE=1 ...`, pass/fail in ACCEPTANCE.md, stages in pipeline.yaml.
- No emoji. Accurate to SPEC, concise.

Overwrite the template's generic README. These files are PIPELINE-GENERATED from SPEC,
never hand-authored -- so any project reproduces its own README by running this stage.
