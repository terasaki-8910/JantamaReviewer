# Mac で最初にやること（段階 0 の確かめ）と、あとの段階の手順案

どれも Mac では未実行の手順案。段階 0 だけは、いますぐ、製品のコードに触れずにできる。所要はおよそ 30〜40 分。

## A. 段階 0: 確かめ用のプログラムを動かす（作る前に分かっておきたいこと）

目的: 設計の分かれ道になる 5 つの事実を、本物の Mac で確かめる。対局中には動かさない（入力を聞く・撮る確かめを含むため）。

### 準備

```
xcode-select --install                                   # Command Line Tools（入っていれば不要）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust（入っていれば rustup update）
git clone https://github.com/terasaki-8910/JantamaReviewer.git
cd JantamaReviewer && git checkout feature/mac-research        # push されていない間は、このフォルダを USB などで写す
cd analysis/mac/appendix/proto
cargo build --release
```

許可は、ターミナル（Terminal・iTerm・VS Code など、`cargo run` を動かすアプリ）に付く。システム設定の「プライバシーとセキュリティ」で、
そのアプリを「アクセシビリティ」「画面収録とシステムオーディオ録音」に足す（足したあと、そのアプリを一度閉じて開き直す）。

### 確かめと、知らせてほしいこと

| # | 動かすもの | 知らせてほしいこと | 分かること |
| --- | --- | --- | --- |
| 1 | `./target/release/mac-proto perm` | 3 行（true/false） | 許可の状態の見え方 |
| 2 | 雀魂をブラウザで開いたまま `./target/release/mac-proto windows 雀魂 "Mahjong Soul"` | `*` の付いた行の全部（題名・大きさ）と、題名が空の行があるか | 窓を題名で見つけられるか（ブラウザごと）。画面収録の許可が要ること |
| 3 | `./target/release/mac-proto tap 20 --swallow 3`（20 秒の間に、横のボタンを両方・中ボタンを押す。ブラウザの「戻る」が働くかも見る） | 出た行（ボタン番号）と、「戻る」が働いたか | 横ボタンの番号（3・4 か）、ドライバがボタンを別の物に変えていないか、横取りが効くか |
| 4 | `./target/release/mac-proto shot 雀魂 /tmp/a.png`（ブラウザの窓のとき、全画面のとき） | 「撮影 ○○ ms、画像 ○○x○○」の行、PNG の大きさ | 撮影の遅れ、Retina の画素数、全画面ブラウザの窓の見つかり方 |
| 5 | `./target/release/mac-proto ocr ../../../../apps/desktop/src-tauri/ocr/tests/fixtures/mark6-center.png`（mark1〜mark6） | 6 枚ぶんの出力の行と時間 | Vision が「東3局」「余」「点数」を読めるか。Windows の文字認識が 1 回目で読めなかった迷い 6 を含む |

5 の期待（Windows の文字認識の結果。空白を除く）: mark1 は 東1局・59・25000、mark2 は 東2局・23・19000、mark3 は 東2局・47・15100、
mark4 は 東2局・35・15100、mark5 は 東3局・46・4400。mark6 は Windows の 1 回目では読めず、読み直し（コントラスト・拡大）で 東3局・38・4400。

### 注意

- 3 の `--swallow` は、その間、そのボタンを全体で横取りする。20 秒たてば戻る。
- 4 は、窓の中身を 1 枚だけ /tmp に書く。プレイヤー名が写っていたら、共有する前に確かめる。
- 許可を足したのに `perm` が false のままなら、ターミナルを閉じて開き直す。それでも false なら知らせてほしい（署名の無い実行ファイルの扱いは、macOS 26 で変わった報告がある）。

## B. あとの段階の手順案（段階 2 以降）

### 道具

```
rustup update stable                 # 1.90 以上が要る（tauri-plugin-opener）
rustup target add aarch64-apple-darwin    # Intel の Mac は x86_64-apple-darwin
corepack enable && corepack prepare pnpm@11.9.0 --activate     # Node は別に入れておく
pnpm install
pnpm test                            # 段階 2 から、Mac でも通ることを確かめる
```

### 作る（`.app` が要る。`--no-bundle` の実行ファイルでは許可の一覧に出ない報告がある）

```
pnpm --filter @jantama/desktop tauri build --bundles app
# できるもの: apps/desktop/src-tauri/target/release/bundle/macos/JantamaReviewer.app
```

### 署名: 許可を作り直しのたびに失わないために

ad-hoc（署名なし相当）は、作り直すたびに識別が変わり、アクセシビリティと画面収録の許可が外れる。自分用の証明書を 1 回作って、毎回それで署名する。

1. 「キーチェーンアクセス」→ メニュー「証明書アシスタント」→「証明書を作成…」
2. 名前 `JantamaReviewer Local`、固有名のタイプ「自己署名ルート」、証明書のタイプ「コード署名」→ 作成
3. 作った証明書を開き、「信頼」の「コード署名」を「常に信頼」にする（表示されないときの対処）
4. 署名: `codesign --force --deep --sign "JantamaReviewer Local" path/to/JantamaReviewer.app`
5. 確かめ: `codesign -dr - path/to/JantamaReviewer.app` の `designated requirement` が、作り直しても同じ

許可を消して最初からやり直すとき: `tccutil reset Accessibility io.github.terasaki-8910.jantama-reviewer`、`tccutil reset ScreenCapture io.github.terasaki-8910.jantama-reviewer`。

Apple Developer ID（年 99 ドル）は、配布するとき（ほかの人の Mac に入れるとき）と、公証が要るときだけ。自分の Mac で自分が作るなら、隔離の印（Gatekeeper の「壊れている」表示）は付かない。

### 許可の流れ（段階 3 以降）

- アクセシビリティ: 割り当てたボタンを「横取り」するタップを作るのに要る。許可前はタップを作れない。許可したあとは、アプリを閉じなくても作り直せる。
- 画面収録: 撮影と、窓の題名の読み取りに要る。許可したあと、アプリの開き直しが要ることがある。
- macOS 15 以降は、画面収録の許可に月 1 回の再確認が出るという報告がある（実機で確かめる）。対局の前に、設定の「撮影の確認」を押しておく運用にする案。
