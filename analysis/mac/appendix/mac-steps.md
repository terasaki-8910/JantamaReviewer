# Mac でやること（段階 2 の確認と、段階 0 の確かめ）

どちらも Mac では未実行の手順（この機械には Mac が無い）。うまくいかなかった行は、そのまま知らせてもらえれば直す。

| | 内容 | 所要 | いつ |
| --- | --- | --- | --- |
| A | 段階 2: 検討画面を Mac で動かす。作って、署名して、14 項目を見る | 1 回目は 60〜90 分（作るのに 10〜20 分かかる）。2 回目からは 20〜40 分 | いま |
| B | 段階 0: 確かめ用のプログラム（許可・窓・横ボタン・撮影・文字認識）。Logi Options+ の横ボタンの確認を含む | 30〜40 分 | 手が空いたとき（R15-11）。A とは独立 |

Mac は Apple Silicon・最新の macOS（R14-6）。署名は自分で作る証明書（R14-7）。雀魂は Safari か Chrome の窓で打つ。
段階 2 の Mac では、ウィジェット・迷いマークのボタン・撮影・文字認識は動かない（設定ページに「Mac ではまだ使えません」と出る）。
この段階で見るのは、検討画面（半荘の一覧・半荘の画面・出題・解き直し・通して見る画面・ログ・週の集計・取り込み・設定）。

## A. 段階 2: 検討画面を Mac で動かす

### A-1. 準備（1 回だけ）

ターミナル（Terminal.app）で。入っているものは飛ばしてよい。

```
xcode-select --install                                             # Command Line Tools（ダイアログが出る。終わるまで待つ）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh     # Rust（途中で 1 を選ぶ）。終わったらターミナルを開き直す
rustup update stable                                               # 1.90 以上が要る
rustup target add aarch64-apple-darwin                             # Apple Silicon では、すでに入っている
rustc -V && cargo -V
```

Node（22 以上。この PC は 25.2）と pnpm（11.9.0）。

```
brew install node          # Homebrew を使っているとき。無ければ https://nodejs.org/ から LTS の .pkg を入れる
npm install -g pnpm@11.9.0   # 権限のエラーが出たら、先頭に sudo を付ける
node -v && pnpm -v           # pnpm は 11.9.0
```

画面の試験（`pnpm test`）は、実ブラウザとして、入っている Chrome か Edge を使う。どちらも無いと、その試験が「ブラウザを起動できません」で落ちる
（Safari だけの Mac では、Chrome を入れる。入れたくなければ、落ちたことをそのまま知らせてくれればよい）。

### A-2. リポジトリを Mac に持っていく（push しない）

いちばん簡単なのは `git bundle`（履歴ごと 1 つのファイルにする。GitHub に上げない）。

Windows 側（PowerShell。リポジトリの本体のフォルダで。段階 2 は `main` に入っている）:

```
cd "$env:USERPROFILE\Documents\project\JantamaReviewer"
git bundle create "$env:USERPROFILE\Desktop\jantama.bundle" main
```

`jantama.bundle` を Mac に写す（AirDrop・iCloud Drive・USB・`scp` のどれでも）。Mac 側:

```
mkdir -p ~/dev && cd ~/dev
git clone -b main ~/Downloads/jantama.bundle JantamaReviewer             # bundle を置いた場所に合わせる
cd JantamaReviewer
git log --oneline | head -3                                             # 先頭の 3 つが、Windows の側と同じ
```

直したあとの更新は、新しい bundle を作って写し、`git pull ~/Downloads/jantama.bundle main`。
フォルダごとの複写（`node_modules`・`target` を除く）でも動くが、版の食い違いが起きやすいので、bundle を勧める。

### A-3. 自分用の署名の証明書を作る（1 回だけ。5 分）

作り直すたびに識別が変わると、段階 3 以降の許可（アクセシビリティ・画面収録）が消える。段階 2 でも、同じ手順で署名しておく
（署名の手順どおりに作れて、許可が残るかは、段階 5 の確認）。

1. 「キーチェーンアクセス」を開く（Spotlight で「キーチェーンアクセス」）。左の「ログイン」を選ぶ。
2. メニュー「キーチェーンアクセス」→「証明書アシスタント」→「証明書を作成…」。
3. 名前 `JantamaReviewer Local`、固有名のタイプ「自己署名ルート」、証明書のタイプ「コード署名」。
   「デフォルトを無効にする」にチェックを入れて「続ける」（そのままだと 1 年で切れる）。シリアル番号は 1、有効期間は `3650` 日、
   あとは既定のまま「続ける」。保存先のキーチェーンは「ログイン」。
4. 「自分の証明書」に出た `JantamaReviewer Local` をダブルクリック →「信頼」を開く →「コード署名」を「常に信頼」にして閉じる
   （パスワードを聞かれる）。
5. ターミナルで確かめる。`JantamaReviewer Local` が 1 行出れば成功:

```
security find-identity -v -p codesigning
```

### A-4. 作る

```
cd ~/dev/JantamaReviewer
pnpm install
export APPLE_SIGNING_IDENTITY="JantamaReviewer Local"
pnpm build:mac          # = pnpm --filter @jantama/desktop tauri build --bundles app
```

初めては 10〜20 分かかる（release の作りは、最適化を強くしてあるため遅い）。途中で「codesign が鍵を使おうとしています」と出たら「常に許可」。
できるもの（`.app`。実行ファイルだけの作り方では、あとの段階の許可の一覧に出ない）:

```
apps/desktop/src-tauri/target/release/bundle/macos/JantamaReviewer.app
```

署名の確かめ。2 回作って、`designated requirement` が同じなら、許可が残る:

```
APP=apps/desktop/src-tauri/target/release/bundle/macos/JantamaReviewer.app
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Identifier|Authority|Signature"
codesign -dr - "$APP"
```

署名されていなかったとき（`Signature=adhoc` と出る）は、手で付ける: `codesign --force --deep --sign "JantamaReviewer Local" "$APP"`。
自分の Mac で作ったアプリは、ダウンロードの印が付かないので、ダブルクリックで開ける。「壊れている」と出たら `xattr -cr "$APP"`。

### A-5. まず試しの保存先で動かす

本物のデータ（`~/JantamaReviewerData` と、`~/Library/Application Support` の設定）には、まだ触れない。環境変数 `JANTAMA_CONFIG_DIR` で、
設定・保存先・画面の保存領域（WKWebView のデータ）を、試しのフォルダに分ける。

```
mkdir -p ~/jantama-trial/data
printf '{"data_dir":"%s/jantama-trial/data"}' "$HOME" > ~/jantama-trial/settings.json
APP=~/dev/JantamaReviewer/apps/desktop/src-tauri/target/release/bundle/macos/JantamaReviewer.app
ls "$APP/Contents/MacOS"                       # 中の実行ファイルの名前（jantama-reviewer のはず）
JANTAMA_CONFIG_DIR="$HOME/jantama-trial" "$APP/Contents/MacOS/jantama-reviewer"
```

ターミナルから動かすと、エラーがそのターミナルに出る。落ちたり、窓が空だったりしたら、その出力を知らせる。
起動の直後に出る「ボタンのフックを起こせませんでした: macOS のボタンのフックは、まだ対応していません」は、段階 2 では正常（ボタンを拾う部分が、まだ無い）。
`/var/folders/...`（`mktemp -d`）より、上のようにホームの下のフォルダが安全（`/var` は `/private/var` への別名で、画像の許可の判定が紛らわしくなる）。

試しの保存先に Windows のデータの写しを置くと、項目 14 を見られる: Windows の `%USERPROFILE%\JantamaReviewerData` を、zip にして
コピーし（元は動かさない）、Mac で `~/jantama-trial/data` に展開する。中に `games/`・`study.sqlite` が並ぶ形にする。

### A-6. 確かめる 14 項目と、知らせてほしいこと

各項目を ○（できた）・×（できない・おかしい）・？（分からない）で。× と ？は、何が起きたかを一言と、できれば画面の写真か
ターミナルの出力を添える。項目の元は `mac-checks.md` の「段階 2」。

| # | 見ること |
| --- | --- |
| 1 | `pnpm test` が通る。通らないものがあれば、その数と名前と最初のエラー文（下の「試験の出力の取り方」） |
| 2 | `pnpm build:mac` で `.app` ができ、署名されている（`codesign -dv` に `JantamaReviewer Local`）。ダブルクリックで起動する |
| 3 | 起動すると、検討画面が開く。ウィジェットとメニューバーのアイコンは出ない。Dock にアイコンが出る。日本語の文字が読みやすい（字体） |
| 4 | 検討画面を閉じる（左上の赤いボタン、または Cmd+W）と、窓が隠れて、アプリは Dock に残る。Dock のアイコンを押すと、また開く |
| 5 | Cmd+Q で終わる。メニューバーに「編集」「ウインドウ」があり、日本語で出ている |
| 6 | 入力欄（検索・メモ・設定の数の欄）で Cmd+C・V・X・A・Z が効く。入力欄の外で、半荘を消したあとの Cmd+Z が「元に戻す」になる。Cmd+K で検索が開閉する。Cmd+[ と Cmd+] で、画面の戻る・進む。メモ欄で Option+← → が単語の移動になり、画面は戻らない |
| 7 | 入力欄以外で、右クリックのメニューが出ない（N-3）。トラックパッドのピンチで拡大しない・2 本指のスワイプで戻らない（N-2）。Cmd+R・Cmd+P・Cmd+F など、ブラウザの機能が働かない（N-1） |
| 8 | 外部へのリンク（天鳳牌理など）を押すと、いつものブラウザで開き、アプリの窓は動かない（N-5） |
| 9 | 起動のとき、白いちらつきが出ない（N-7）。ライト・ダークの切り替えが効く |
| 10 | 雀魂で牌譜リンクをコピーして、アプリの窓に戻ると、「この半荘を取り込みますか」と出る（F1・E-15）。macOS が「アプリがペーストボードを読んだ」という通知を出すか、出たらその文 |
| 11 | 「検討結果を取り込む」で mjai の窓が開き、URL 欄に牌譜リンクが入り、Cloudflare の確認を通せて、結果が取り込まれる（F1）。mjai の窓の Cookie が、アプリの画面と分かれている |
| 12 | 半荘を消す → Cmd+Q で終わる → ごみ箱（Dock のごみ箱）に、その半荘のフォルダが入っている。消した直後の「元に戻す」で戻せる（U-9） |
| 13 | 設定の「記録の書き出し」「読み込み」が動く。ファイルのダイアログが日本語の Mac の見た目で出る（D-2） |
| 14 | ふだんの起動（環境変数なし）で、設定ページの保存先が `/Users/<名前>/JantamaReviewerData`。設定のファイルは `~/Library/Application Support/io.github.terasaki-8910.jantama-reviewer/settings.json`。Windows のデータの写しを置くと、半荘の一覧に出る |

項目 14 のふだんの起動だけは、環境変数を付けずに `open "$APP"` で動かす（本物の保存先と設定ができる。気になるなら、後で
`~/JantamaReviewerData` と `~/Library/Application Support/io.github.terasaki-8910.jantama-reviewer` を消せば元に戻る）。

試験の出力の取り方:

```
cd ~/dev/JantamaReviewer
pnpm test 2>&1 | tee ~/jantama-test.log
grep -nE "FAIL|failed|panicked|Error:" ~/jantama-test.log | head -60
```

Rust だけ・画面だけで動かすときは `pnpm test:rust`・`pnpm test:ts`。落ちた試験が 1 つでも出たら、`~/jantama-test.log` の該当の前後 30 行を知らせる。

### A-7. うまくいかないとき

| 症状 | 見るところ |
| --- | --- |
| 起動して、窓が空（真っ白・真っ黒） | ターミナルから動かして（A-5）、出力を知らせる。画面が配られていない（遷移が止められた）と、`on_navigation` の行が出る |
| 「壊れているため開けません」 | `xattr -cr "$APP"` のあと、もう一度 |
| `pnpm build:mac` が `codesign` で止まる | `security find-identity -v -p codesigning` に `JantamaReviewer Local` が出るか。出なければ A-3 の 4（信頼）をやり直す |
| `pnpm install` や `cargo` が見つからない | ターミナルを開き直す。`source "$HOME/.cargo/env"` |
| Rust のエラー（`rustc 1.xx is not supported`） | `rustup update stable`（1.90 以上） |
| 試しの保存先をやり直したい | アプリを終わらせて、`rm -rf ~/jantama-trial`、A-5 を最初から |

### A-8. この段階で入れたもの（確認の手がかり）

- ウィジェットの窓・右クリックのメニュー・タスクトレイは作らない。起動と同時に検討画面を開く。
- 保存先の既定は `~/JantamaReviewerData`（Windows の `%USERPROFILE%\JantamaReviewerData` と同じ名前・同じ置き方。Finder で見え、Windows から写す・書き出す・同期するのが楽）。設定ファイルだけが `~/Library/Application Support/`。
- キーの読み替え（Windows は変えない）: 取り消し・やり直し Cmd+Z・Cmd+Shift+Z（Ctrl+Z・Ctrl+Y も使える）、検索 Cmd+K（Ctrl+K も）、一覧のすべて選択 Cmd+A、
  画面の戻る・進む Cmd+[ と Cmd+]（Windows の Alt+← → は、Mac では使わない: Option+← → は入力欄の単語の移動なので）、検索の先頭・末尾の行 Cmd+↑・Cmd+↓、開発者ツール（`pnpm dev` のときだけ）Cmd+Option+I。
  メニューバー: アプリ名のメニュー（Cmd+Q で終了・Cmd+H で隠す）・編集（取り消す・やり直す・カット・コピー・ペースト・すべてを選択）・ウインドウ（しまう・拡大/縮小・閉じる）。
- ごみ箱・クリップボードの文字は、macOS の標準の API（`NSFileManager.trashItemAtURL`・`NSPasteboard` の文字）。
- 画面を配るオリジンは `tauri://localhost`（Windows は `http://tauri.localhost`）。mjai の窓と試しの起動の保存領域は、WKWebView の識別子で分ける（macOS 14 以降）。
- 設定ページの「迷いマークのボタン」の行は、「Mac ではまだ使えません。ウィジェット・迷いマークのボタン・画面の撮影は、Mac 版の次の段階で対応します。」に替わる。ウィジェットの形・音・窓を探す語の行は出ない。

## B. 段階 0: 確かめ用のプログラムを動かす（手が空いたとき。30〜40 分）

目的: 設計の分かれ道になる 5 つの事実を、本物の Mac で確かめる（許可の出方・窓の題名・横ボタンの番号・撮影の遅れ・Vision の読み）。
対局中には動かさない（入力を聞く・撮る確かめを含むため）。A とは独立で、A を先にやっても、後でもよい。

### B-1. 準備

A-1 の Command Line Tools と Rust があればよい（Node は要らない）。リポジトリは A-2 で持っていったもの。

```
cd ~/dev/JantamaReviewer/analysis/mac/appendix/proto
cargo build --release
```

許可は、ターミナル（Terminal・iTerm・VS Code など、動かすアプリ）に付く。システム設定の「プライバシーとセキュリティ」で、
そのアプリを「アクセシビリティ」「画面収録とシステムオーディオ録音」に足す（足したあと、そのアプリを一度閉じて開き直す）。
入力の聞き取りには、アクセシビリティのほか、「入力監視」が要ることもある（足りないと、`tap` がエラーを出す）。

### B-2. 確かめと、知らせてほしいこと

| # | 動かすもの | 知らせてほしいこと | 分かること |
| --- | --- | --- | --- |
| 1 | `./target/release/mac-proto perm` | 3 行（true/false） | 許可の状態の見え方 |
| 2 | 雀魂をブラウザで開いたまま `./target/release/mac-proto windows 雀魂 "Mahjong Soul"` | `*` の付いた行の全部（題名・大きさ）と、題名が空の行があるか | 窓を題名で見つけられるか（ブラウザごと）。画面収録の許可が要ること |
| 3 | `./target/release/mac-proto tap 20 --swallow 3`（20 秒の間に、横のボタンを両方・中ボタンを押す。ブラウザの「戻る」が働くかも見る） | 出た行（ボタン番号）と、「戻る」が働いたか | 横ボタンの番号（3・4 か）、ドライバがボタンを別の物に変えていないか、横取りが効くか |
| 4 | `./target/release/mac-proto shot 雀魂 /tmp/a.png`（ブラウザの窓のとき、全画面のとき） | 「撮影 ○○ ms、画像 ○○x○○」の行、PNG の大きさ | 撮影の遅れ、Retina の画素数、全画面ブラウザの窓の見つかり方 |
| 5 | `./target/release/mac-proto ocr ../../../../apps/desktop/src-tauri/ocr/tests/fixtures/mark6-center.png`（mark1〜mark6） | 6 枚ぶんの出力の行と時間 | Vision が「東3局」「余」「点数」を読めるか。Windows の文字認識が 1 回目で読めなかった迷い 6 を含む |

5 の期待（Windows の文字認識の結果。空白を除く）: mark1 は 東1局・59・25000、mark2 は 東2局・23・19000、mark3 は 東2局・47・15100、
mark4 は 東2局・35・15100、mark5 は 東3局・46・4400。mark6 は Windows の 1 回目では読めず、読み直し（コントラスト・拡大）で 東3局・38・4400。

注意:

- 3 の `--swallow` は、その間、そのボタンを全体で横取りする。20 秒たてば戻る。
- 4 は、窓の中身を 1 枚だけ /tmp に書く。プレイヤー名が写っていたら、共有する前に確かめる。
- 許可を足したのに `perm` が false のままなら、ターミナルを閉じて開き直す。それでも false なら知らせてほしい（署名の無い実行ファイルの扱いは、macOS 26 で変わった報告がある）。

### B-3. Logi Options+ の横ボタンが、全体のタップ（CGEventTap）に届くか（B-2 の 3 の続き）

段階 3 の迷いマークのボタンは、横ボタンを CGEventTap で拾う（R14-6: Logi Options+ のマウス）。Logi Options+ は、横ボタンを自分で「戻る」「進む」
などの動作に変える（ボタンの番号のまま渡さず、キーの組み合わせや別のイベントにする）ことがあるので、タップに届くかを先に見る。
`tap` は、マウスのボタン番号とキー（仮想キーコード・修飾キー）の両方を出すので、どちらで届くかが分かる。

1. Logi Options+ を起動したまま（メニューバーにアイコンがある状態）、`./target/release/mac-proto tap 20`。戻るボタン・進むボタン・中ボタンを 1 回ずつ押す。
   出た行（`MouseDown(...)`・`KeyDown {...}`）を、ボタンごとに知らせる。
2. Logi Options+ の画面で、そのマウスの戻るボタン・進むボタンの割り当て（「戻る」「進む」の既定か、キーストロークか、そのほか）を見て、画面の写真か文で知らせる。
3. Logi Options+ を終了して（メニューバーのアイコン →「終了」）、同じ `tap 20`。1 との違いを知らせる。
4. Chrome（Safari でも）を開いて、ページを 2 つ移ったあと、`./target/release/mac-proto tap 20 --swallow 3`（次に `--swallow 4`）の間に、戻る・進むボタンを押す。
   ページが戻る・進むか（横取りが効いていないか）。Logi Options+ を動かしたまま、と終了したあと、の両方。
5. 見方: (a) 1 で `MouseDown` の番号が 3・4 で出て、4 で横取りが効く → そのまま段階 3 に進める。
   (b) 番号では出ず、`KeyDown`（Cmd+[ など）で出る → Logi Options+ がキーに変えている。Logi Options+ 側の割り当てを変える（または、アプリの割り当てをキーにする）道を相談する。
   (c) どちらでも出ない → ドライバがもっと下の層で処理している。その旨を知らせる（段階 3 の作りを決め直す）。

## C. 段階 3 以降の手順案（許可の流れ）

署名と作り方は A-3・A-4。ここは、段階 3 以降で効いてくる許可の流れ（予定。実機で確かめる）。

- アクセシビリティ: 割り当てたボタンを「横取り」するタップを作るのに要る。許可前はタップを作れない。許可したあとは、アプリを閉じなくても作り直せる。
- 画面収録: 撮影と、窓の題名の読み取りに要る。許可したあと、アプリの開き直しが要ることがある。
- macOS 15 以降は、画面収録の許可に月 1 回の再確認が出るという報告がある（実機で確かめる）。対局の前に、設定の「撮影の確認」を押しておく運用にする案。
- 許可を消して最初からやり直すとき: `tccutil reset Accessibility io.github.terasaki-8910.jantama-reviewer`、`tccutil reset ScreenCapture io.github.terasaki-8910.jantama-reviewer`。
- Apple Developer ID（年 99 ドル）は、配布するとき（ほかの人の Mac に入れるとき）と、公証が要るときだけ。自分の Mac で自分が作るなら、隔離の印（Gatekeeper の「壊れている」表示）は付かない。
