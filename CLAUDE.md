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
- Tests: `pnpm test`（= `pnpm test:ts`（全 vitest）+ `pnpm test:rust`（cargo test --workspace））。実ブラウザの検査（tests/browser）は、インストール済みの Chrome か Edge を使う。画面の試験は、jsdom の試験を先に全部動かし、実ブラウザの検査はそのあとに 3 つずつ並べて動かす（`apps/desktop` の `test`。8 つを同時に動かすと、PC が重くなり、試験用のサーバーへの接続が切れて落ちることがあった）。Rust は 4 つのクレートの workspace（`apps/desktop/src-tauri` の本体、共有の部品 `input`、管理者で動く補助プログラム `helper`、取り込みのときだけ使う文字認識 `ocr`）。文字認識の試験（`ocr/tests/ocr_fixtures.rs`）は、Windows の日本語の文字認識が入っている PC でだけ通る。
- 試しに動かすとき（`JANTAMA_CONFIG_DIR`）は、WebView2 のデータ（画面の保存領域）も、その設定フォルダの `webview/` に置かれる（本物のアプリの保存領域には触れない）。mjai の窓の WebView2 のデータは、いつもアプリの画面とは別（`webview-mjai/`）。
- Hook test（手動）: `pnpm test:hook`。実際にマウスとキーの入力を注入して、本物のフック（修飾キー付きのキー・登録の待機を含む）を通す（src-tauri/tests/hook_integration.rs）。続けて、入力の流れ（記録・テスト・登録）を本物のフックにつないだ試験も動かす（input_flow_integration.rs。F23・F24 だけを注入する）。どちらも `pnpm test` には含めない。前面の窓が昇格している（管理者として動く雀魂のクライアントなど）と、入力が届かず、理由を示して失敗する。
- Task test（手動）: `pnpm test:task`。補助プログラムのタスクの定義を、本物のタスクスケジューラが受け付けて、呼んだときだけ動かすことを確かめる（試験用の名前で一時的に登録し、終わったら消す。実行の権限だけは「普通」に替える。helper/tests/task_scheduler.rs。`pnpm test` には含めない）。
- Sync test（手動）: `pnpm test:sync`。公式の `tursodb`（試験用の同期サーバー。0.8.2）を OS の一時フォルダに取ってきて（SHA-256 を照らす）、本物の同期の部品（turso クレート）で、2 台の往復・消す対直す・新しいほうが残る・サーバーの停止と再開・返事をしないサーバーの打ち切り・同期用の DB の作り直しを確かめる（`src-tauri/tests/sync_integration.rs`）。続けて、OS の資格情報の保管庫に、試験用の名前で作り物の文字を入れて消す試験も動かす。通信は 127.0.0.1 だけで、本物のデータ・Turso Cloud・本物のトークンには触れない。`pnpm test` には含めない。
- Lint:  `pnpm lint`（= eslint（絵文字禁止・色はトークンのみ・jsx-a11y）+ stylelint（色はトークンのみ）+ tsc --noEmit + cargo clippy --workspace -D warnings + cargo fmt --all --check + `pnpm check:mac`）
- macOS 向けの検査: `pnpm check:mac`（zig を C コンパイラにして `cargo clippy --target aarch64-apple-darwin --workspace --all-targets -D warnings`。リンクと実行はしない。`scripts/check-mac.ps1`）。先に 1 回だけ `winget install zig.zig` と `rustup target add aarch64-apple-darwin` が要る（無いと `pnpm lint` は入れ方を示して失敗する）。初回は依存を組むので 2 分ほど、2 回目からは数秒。Windows 以外の機械では何もしない（`lint:clippy` がそのまま macOS 向けの検査になる）。
- OS ごとに違う部品は、本体の `src/platform/`（Windows は `win/`、macOS は `mac.rs` の未対応を返す雛形）に集める。共有のコードには `#[cfg(windows)]` も Windows の API も書かず、`platform` の口（`Platform`・`InputHook`・`HelperHost`・`recycler` など）を使う。macOS の API を足すときの禁止の一覧は `tests/safety.rs` の末尾（画面を取り続ける・ほかのアプリの要素を読む・入力を送る・ほかのプロセスに触れる・外部プロセスで撮影、が対象）。
- Debug build: `pnpm build:debug`（`tauri build --debug --no-bundle`。本体と補助プログラムの 2 つの実行ファイル `jantama-reviewer.exe`・`jantama-helper.exe` が `apps/desktop/src-tauri/target/debug/` にできる。補助プログラムは本体と同じフォルダに置く。設定のとき、ここから Program Files に写す）
- Release build: `pnpm --filter @jantama/desktop tauri build --no-bundle`（同じ 2 つが `target/release/` にできる）。作ったら、2 つとも `%USERPROFILE%\Documents` の直下にも写す（2026-10-22 の依頼。補助プログラムは、設定のときに本体と同じフォルダに要る。設定とデータは、どこから開いても %APPDATA% と %USERPROFILE%\JantamaReviewerData で同じ）。本体が動いていると写せないので、そのときは閉じてもらう。
- 配布とアプリ内の更新（F21）: 版のタグ（`v0.2.0` の形）を push すると、GitHub Actions（`.github/workflows/release.yml`）が、Windows と Mac（macos-latest、Apple Silicon）の 2 つのジョブで、署名つきのインストーラー（Windows は NSIS。今のユーザー向け。補助プログラムも同じフォルダに入る。Mac は ad-hoc の署名の .dmg と更新用の .app.tar.gz）と `latest.json` を Releases に置く。解析エンジン（`jantama-engine`）は、両方のジョブが先に作って `src-tauri/binaries/jantama-engine-<ターゲット>` に写し、`externalBin` で本体の隣（Mac は `Contents/MacOS`）に入れる。Actions だけの設定は、共通（`tauri.release.conf.json`。署名のファイルと公開鍵と、解析エンジンの externalBin）・Windows（`tauri.release.windows.conf.json`。補助プログラム）・Mac（`tauri.release.macos.conf.json`。ad-hoc の署名）の 3 つ。Actions の画面から release を手で動かす（`gh workflow run release.yml --ref <枝>`）と、Releases に置かずに組み立てだけをして、できた物を Artifacts に置く。Mac の試験は `gh workflow run mac-test.yml --ref <枝>`（macOS の上で `pnpm test:ts` と `pnpm test:rust`）。push とタグの push は、ユーザーが頼んだときだけ。版は `tauri.conf.json`・`src-tauri/Cargo.toml`・`apps/desktop/package.json` をそろえて上げ、タグと同じにする（違うと Actions が止まる）。更新の取り先と公開鍵は `src-tauri/src/update/config.rs` の 2 つの定数（公開鍵は `tauri.release.conf.json` の `plugins.updater.pubkey` にも同じ値。空のあいだは、更新の仕組みは通信しない）。秘密鍵と合言葉は GitHub の Secrets（`TAURI_SIGNING_PRIVATE_KEY`・`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）だけに置く。手元の組み立て（上の release・debug）は鍵なしで通る（署名のファイルを作る設定は `tauri.release.conf.json` だけにある）。
- Dev: `pnpm dev`（`tauri dev`。開発者ツールが使えるのはこのときだけ。ブラウザのショートカットは切ってあるので、F12 か Ctrl+Shift+I のアプリ自身のキー処理で開く）。補助プログラムは作らないので、設定を試すときは、先に `pnpm build:helper` で作る。
- Helper build: `pnpm build:helper`（補助プログラムだけを作る。`tauri dev` の前や、補助プログラムを直したあとに使う）
- 解析エンジンの作り方と試験（F24。本体とは別の workspace）: `cd apps/desktop/src-tauri/engine` して、`cargo build --release`（`target/release/jantama-engine` ができる）、`JANTAMA_MODEL_DIR=<tenpai.onnx のあるフォルダ> cargo test --workspace`（モデルを使う試験は、モデルが無ければ理由を出して飛ばす。モデルのファイルは git に入れない）。`pnpm test:rust` は、この workspace も動かす。
- 本体からエンジンを呼ぶ開発の動かし方: 環境変数 `JANTAMA_ENGINE` に、作ったエンジンの実行ファイルのパスを入れて、本体を起動する（未設定なら、本体の実行ファイルと同じフォルダの `jantama-engine` を探す。エンジンを本体と一緒に配る組み立ては、段階 A3 でまだ足していない）。本体の試験（`cargo test --workspace`）は、`JANTAMA_ENGINE` と `JANTAMA_MODEL_DIR` の両方があるときだけ、本物のエンジンで読みの計算を試す（無ければ理由を出して飛ばす）。読みのモデルは、設定の「解析のモデル」から取るか、自分で取った `tenpai.onnx` を選ぶ（置き場は設定のフォルダの `models/`。試しに動かすときは `JANTAMA_CONFIG_DIR` の下）。
- 補助プログラムの手動確認（管理者の確認が出るので、自動の試験では確かめられない）: 設定ページの「管理者の補助プログラムを設定する」→ Windows の確認で「はい」→ 行が「動いています」になる。雀魂（管理者で動く）を前面にして、割り当てたサイドボタンを押すと、迷いが記録される。「設定を解除する」で、タスクと Program Files の写しが消える。
- ボタンが効かないときの原因調べ: 環境変数 `JANTAMA_TRACE_INPUT=1` を付けて本体を起動し、標準エラーを見る（入力の流れが受け取った入力とやること、フックの手続きが受け取ったキーの仮想キーコード・フラグ・時刻、マウスの入力の数が出る）。実機で、本体が最後に入れたキーボードのフックには、前面が本体自身の窓（検討画面）のとき入力が届かず、先に入っているほかのアプリのフックにも届かなくなる（窓の中には届く。マウスのフックと、別のプロセスのフックは影響を受けない）と確かめた。そのため、検討画面が前面にある間は、本体のキーボードのフックを外し（`Effect::InProcessKeyboard`）、その間のキーは設定ページが拾って `report_page_key` で知らせる（登録とテスト）。
- 試しに動かすときは、環境変数 `JANTAMA_CONFIG_DIR` に一時フォルダを指定し、そこの `settings.json` で `data_dir` も一時フォルダにする。本物のデータ（`%USERPROFILE%\JantamaReviewerData`）には触れない。`--show-main` を付けると検討画面も開く。
- README の画面写真: `node scripts/readme-shots.mjs <迷いマークの画像のフォルダ>`（先に release を作っておく。フォルダには、プレイヤー名をぼかした雀魂の画面 `mark-1.jpg` ... `mark-6.jpg` を置く。一時フォルダだけを使い、本物のデータには触れない。出力は `docs/images`。機能が増えて写真を撮り直すときは、この道具に撮る画面を足し、README に説明を足す）。
- README の GIF: `node scripts/readme-gifs.mjs <迷いマークの画像のフォルダ>`（先に release を作っておく。ffmpeg が PATH に要る。ウィジェット・取り込み・出題・半荘を通して見る・週の集計の動きを、アプリ自身の窓だけを CDP で撮って `docs/images/*.gif`（各 3 MB 以内）にする。一時フォルダだけを使い、本物の画面・データには触れない。ウィジェットの迷い・〇△✕・取り消しは、窓の通信の層で受け止め、本体に通さない。共通の部品は `scripts/readme-lib.mjs`。動きが増えたら、この道具に録る場面を足し、README に説明を足す）。

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
