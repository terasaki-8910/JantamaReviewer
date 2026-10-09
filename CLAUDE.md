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
このプロジェクトでは、生成物（コメント・ドキュメント・コミットメッセージ・画面の文言）はすべて日本語で書く（決定記録 R1-10、2026-10-09）。
コードの識別子（変数名・関数名など）だけは英語のままにする。会話の言語とは別。

## Commands
どれもリポジトリのルートで実行する（Windows 専用。pnpm 11・Node・Rust が要る）。
- Install: `pnpm install`
- Tests: `pnpm test`（= `pnpm test:ts`（全 vitest）+ `pnpm test:rust`（cargo test --workspace））。実ブラウザの検査（tests/browser）は、インストール済みの Chrome か Edge を使う。Rust は 3 つのクレートの workspace（`apps/desktop/src-tauri` の本体、共有の部品 `input`、管理者で動く補助プログラム `helper`）。
- Hook test（手動）: `pnpm test:hook`。実際にマウスとキーの入力を注入して、本物のフック（修飾キー付きのキー・登録の待機を含む）を通す（src-tauri/tests/hook_integration.rs。`pnpm test` には含めない）。前面の窓が昇格している（管理者として動く雀魂のクライアントなど）と、入力が届かず、理由を示して失敗する。
- Task test（手動）: `pnpm test:task`。補助プログラムのタスクの定義を、本物のタスクスケジューラが受け付けて、呼んだときだけ動かすことを確かめる（試験用の名前で一時的に登録し、終わったら消す。実行の権限だけは「普通」に替える。helper/tests/task_scheduler.rs。`pnpm test` には含めない）。
- Lint:  `pnpm lint`（= eslint（絵文字禁止・色はトークンのみ・jsx-a11y）+ stylelint（色はトークンのみ）+ tsc --noEmit + cargo clippy --workspace -D warnings + cargo fmt --all --check）
- Debug build: `pnpm build:debug`（`tauri build --debug --no-bundle`。本体と補助プログラムの 2 つの実行ファイル `jantama-reviewer.exe`・`jantama-helper.exe` が `apps/desktop/src-tauri/target/debug/` にできる。補助プログラムは本体と同じフォルダに置く。設定のとき、ここから Program Files に写す）
- Release build: `pnpm --filter @jantama/desktop tauri build --no-bundle`（同じ 2 つが `target/release/` にできる）
- Dev: `pnpm dev`（`tauri dev`。開発者ツールが使えるのはこのときだけ。ブラウザのショートカットは切ってあるので、F12 か Ctrl+Shift+I のアプリ自身のキー処理で開く）。補助プログラムは作らないので、設定を試すときは、先に `pnpm build:helper` で作る。
- Helper build: `pnpm build:helper`（補助プログラムだけを作る。`tauri dev` の前や、補助プログラムを直したあとに使う）
- 補助プログラムの手動確認（管理者の確認が出るので、自動の試験では確かめられない）: 設定ページの「管理者の補助プログラムを設定する」→ Windows の確認で「はい」→ 行が「動いています」になる。雀魂（管理者で動く）を前面にして、割り当てたサイドボタンを押すと、迷いが記録される。「設定を解除する」で、タスクと Program Files の写しが消える。
- 試しに動かすときは、環境変数 `JANTAMA_CONFIG_DIR` に一時フォルダを指定し、そこの `settings.json` で `data_dir` も一時フォルダにする。本物のデータ（`%USERPROFILE%\JantamaReviewerData`）には触れない。`--show-main` を付けると検討画面も開く。

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

## Decisions record
決定記録は docs/decisions.md。確認シートの URL もそこにある。元の会話（仕様の出どころ）は docs/chatcontext.txt。

## Confirm before building
- Choices that are mine -- which reading of an ambiguous request is meant,
  anything I will see (layout, visuals, wording), scope, tradeoffs with no
  clear default, conflicts between my instructions -- are not yours to
  settle. Show me your understanding as something I can look at (a decision
  sheet with real samples, or a local test page) and build only after I say
  GO. A task doc that looks complete is not a GO.
- One sheet per human gate (see Process), with every open question on it:
  results waiting for acceptance, samples for the next task, wording with
  drafts, things found outside the task, and what happens after the build
  ("merge if checks pass?"). Questions must work in any combination of
  answers; save a question for a later round only if it can't be answered
  before something is built.
- Don't ask what a test can decide, what has a conventional default, or what
  is cheap to undo -- decide it and say so in one line.
- A project's decisions record outranks task docs and memory, and what isn't
  in it is undecided. Append my answers to it as I wrote them.
- How to build and read the sheet: the `decision-sheet` skill.
