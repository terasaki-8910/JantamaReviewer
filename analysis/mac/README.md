# macOS 対応（ウィジェットを含む）の調べと見積もり

決定記録 R13-4「ウィジェットも含めて Mac で使う（雀魂を Mac で打つ）」を受けた、作る前の調べ。2026-10-12、ブランチ `feature/mac-research`。
製品のコード・試験・SPEC・ACCEPTANCE・決定記録は変えていない（このフォルダを足しただけ）。Mac はこの機械に無いので、Mac が要る確認は「あなたが Mac で動かす手順」にしてある。
作るかどうかは、この文書を見てから決めてもらう（R13-4 のメモのとおり）。

依頼の 6 つの問いへの対応: 棚卸し=1 章、Mac なしの作り方=2 章、設計=3 章、規約の線引き=4 章、見積もりと段階=5 章、あなたへの質問=7 章。

根拠には 4 種類あり、文中に印を付けた。

- [コード] このリポジトリを読んだ事実。
- [型検査] この Windows の機械で `cargo check --target aarch64-apple-darwin` を通して確かめた事実（実行はしていない）。手順と結果は `appendix/cross-check.md`。
- [出典] 公開の文書・記事（末尾の一覧）。
- [推測] 実機で確かめていない見込み。Mac で確かめる項目に入れてある。

## 0. 結論

作れる。見積もりは、変更と追加が合わせて約 5,700〜7,800 行（試験・文書込み。書き出し機能 D-2 の 1.4〜1.9 倍、取り込み F1・F11 の 0.6〜0.8 倍）。そのうち macOS 専用の製品のコードは約 2,000〜2,400 行で、残りは共通化のための移動、試験、文書。

- Windows 専用の部品は約 5,500 行（Rust 全体 34,000 行の約 16%）。画面（TypeScript）と計算（packages/engine）は、そのまま使える。[コード]
- 管理者の補助プログラム一式（約 2,700 行）は、Mac では要らない。代わりに「許可」（アクセシビリティ・画面収録）の案内が要る。[コード][出典]
- この機械でも、macOS 向けのコードを型検査まで確かめられる（zig で C の依存を組む）。Windows 側の `pnpm test` と `pnpm lint` を守りながら進められ、Mac の実機が要るのは動作の確認だけになる。確かめ用の雛形（入力・窓の一覧・1 枚撮り・日本語の文字認識）も、この機械で型検査まで通した。[型検査]
- 新しい不確実さは 4 つ。(1) 許可（TCC）と署名。作り直すたびに許可が消える。(2) ウィジェットの窓。ブラウザから前面を奪わないこと、全画面ブラウザの上に出すこと。(3) 文字認識の精度（Windows の OCR と Vision は癖が違う）。(4) macOS 15 以降の画面収録の月 1 回の再確認が、対局中に出るおそれ。
- Mac を使う確認は約 65 項目（半分は段階 3）。往復はおよそ 11〜16 回。
- 雀魂の Mac 版: アプリ版は Windows のみ。Mac ではブラウザ版を打つのが現実的。Steam 版（2026-07-20 配信）が Mac に対応しているかは、公開情報が割れていて確かめられていない。

最初の一歩の提案は、(a) 段階 1（共通化。Windows だけで終わり、見た目は変わらない）と、(b) 段階 0（Mac で確かめ用のプログラムを 30〜40 分動かす。`appendix/mac-steps.md` の B）を並べて進めること。質問は 7 章。

## 1. 棚卸し

### 1.1 表

行数は現在のコード（Rust は `apps/desktop/src-tauri`）。「新規」は、その部品の macOS 側で新しく書く行数の見込み（試験は別）。

| # | 部品 | Windows の実装（現在の行数） | macOS の対応 | リスク | 新規の見込み |
| --- | --- | --- | --- | --- | --- |
| 1 | ボタンを拾う（マウスの横ボタン・キー） | `input/src/hook_win.rs`（390）。WH_MOUSE_LL・WH_KEYBOARD_LL。判定 `logic.rs`（1,321）・`keys.rs`（316）は OS 非依存 | CGEventTap（`core-graphics` 0.25。tao 経由で依存に入っている）。横取りは `Drop`。アクセシビリティの許可が要る | 中 | 約 350 + キー表 150 + 変換 60 |
| 2 | 管理者の補助プログラム | `helper/`（557）、`input/` の `pipe_win`（491）・`user_win`（88）・`setup`（413）、`helper_link`（392）、`helper_setup`（358）、試験 357。計約 2,700 | 要らない。代わりに許可の案内（設定ページの行） | 低 | 約 250（Rust 120 + 画面 130） |
| 3 | 押した瞬間の撮影 | `capture_win.rs`（305）。GDI の BitBlt で窓の長方形を写す。窓が無ければカーソルのある画面 | `SCScreenshotManager`（macOS 14 以降）。長方形を写す版（`captureImageInRect`）は 15.2 以降のはず | 中〜高 | 約 250 |
| 4 | 窓を題名で探す | 同上（EnumWindows）。選ぶ関数 `select_window`（`capture.rs`）は OS 非依存 | `CGWindowListCopyWindowInfo`（手前から順）。題名の読み取りに画面収録の許可が要る | 中 | 上に含む |
| 5 | ウィジェットの窓 | `widget_window.rs`（452）。Tauri の設定 + `WS_EX_NOACTIVATE` と角丸（約 55）。位置は物理ピクセル | tao の設定（`focusable`・`always_on_top`）で足りるかを実機で見る。足りなければ NSPanel（`tauri-nspanel` か objc2） | 高 | 約 150〜250 + 位置 80 |
| 6 | 取り込みの文字認識 | `ocr/src/winrt.rs`（602）。WinRT で PNG を読み、日本語 OCR。切り出し・拡大は `locate`・`resample`・`geometry`（純粋） | Vision `VNRecognizeTextRequest`（日本語は macOS 13 以降）。画素の取り出しは ImageIO | 高（精度は測るまで不明） | 約 250 + 分け直し 200 |
| 7 | WebView の「ブラウザの名残」対策 | `webview_win.rs`（219）。WebView2 の 10 項目と右クリックの絞り込み。方針 `webview_policy.rs`（563）は OS 非依存 | WKWebView には対応する設定がほぼ無い。多くは不要 / JS 側で足りる。保存領域は `data_store_identifier`（macOS 14 以降） | 低〜中 | 約 100 |
| 8 | 保存先・設定の場所 | `settings.rs` は `USERPROFILE` が無ければ `HOME`（対応済み） | `~/JantamaReviewerData`。設定は Tauri の設定フォルダ（`~/Library/Application Support/...`） | 低 | 約 20 |
| 9 | 画面側の Windows 前提 | 表示の文言「Ctrl+」「Alt+」「Win」ほか約 8 か所、補助プログラムの行 | 文言を OS で出し分け。取り消し・検索は `metaKey` を既に受ける | 低 | 約 150（TS） |
| 10 | メニュー・トレイ・Dock・終了 | `menu.rs`（166）、タスクトレイ | メニューバーのアイコン。Tauri が macOS の標準メニューを自動で付ける。Dock の再オープン | 低 | 約 60 |
| 11 | 音 | `sound.rs` の `PlaySoundW`（約 35） | `NSSound`（objc2-app-kit） | 低 | 約 40 |
| 12 | クリップボードの文字 | `clipboard.rs` の `clipboard-win`（約 15） | NSPasteboard（`arboard` など） | 低 | 約 40 |
| 13 | 消した半荘をごみ箱へ | `trash.rs` の `SHFileOperationW`（約 100） | `NSFileManager trashItemAtURL`（`trash` クレートか objc2） | 低 | 約 40 |
| 14 | 単一起動・ファイルのダイアログ | 単一起動は Windows にも無い。ダイアログは tauri-plugin-dialog | 追加なし | 低 | 0 |
| 15 | 作る・梱包・署名 | `tauri.conf.json` の `targets: ["nsis"]` | `tauri.macos.conf.json` で `app`。署名は自分用の証明書 | 中 | 約 150 + 文書 |
| 16 | 静的検査 `tests/safety.rs` | 2,372。禁止の一覧は Windows の語 | macOS の語を足す（4 章） | 低 | 約 200 |
| 17 | Windows 専用の試験 | `hook_integration`（765）、`input_flow_integration`（232）、`helper/tests`（357）、`ocr_fixtures`（482） | Mac 版を作る（CGEventPost、Vision） | 中 | 約 800 |

Windows 専用の合計: 全体のファイルで約 5,350 行 + `cfg(windows)` の断片で約 200 行。[コード]

### 1.2 項目ごとの調べ

#### ボタンを拾う（行 1）

今: フックは「いまの設定が要る種類だけ」を入れる。割り当てたボタンの押下と離しは横取りし、それ以外は通す。判定（`InputCore`、`HeldGate`）は OS 非依存で、フックの手続きはチャネルに送るだけ。検討画面が前面にあるときは本体のキーボードのフックを外す（Windows 側の癖）。[コード]

macOS の組み方: セッション全体の `CGEventTap`（先頭に挿入、既定の、横取りできる種類）を専用スレッドの実行ループで回す。

- 許可: 横取りできるタップはアクセシビリティ、聞くだけのタップは入力の監視。アクセシビリティがあれば入力の監視は要らない。[出典 1] 許可が無いと、横取りできるタップは作れない（作れても入力が届かない報告もある）。横取りが要るので、アクセシビリティを必須にする。
- 止められたとき: 時間切れやユーザー入力でタップが止められたら、コールバックの中ですぐ有効に戻す。[出典 2] 雛形に入れてある。[型検査]
- ボタン番号: 中ボタンは 2、「戻る」は 3、「進む」は 4 が普通。ただしマウスのドライバがこれをスワイプやキー操作に変換する例がある（Sensible Side Buttons など）。その場合、タップにはボタンとして届かない。[出典 3] 段階 0 の `tap` で、あなたのマウスの実際の番号を見る。
- キー: 内部の判定は仮想キーコード（VK）で比べている。設定には DOM の `KeyboardEvent.code` で保存している。[コード] macOS のキーコード（kVK）との対応表を足し、内部の言葉は VK のままにする。判定・設定の保存・連絡の決まりは変えずに済む。Windows キーは Mac では Cmd に読み替える（保存の名前 `win` はそのまま、表示だけ）。
- 使わない案: `rdev` は聞くだけなら手軽だが、横取り（grab）は unstable で、タップの再有効化を自前で持てない。[出典 4] 直接 `core-graphics` を使う。

型検査済みの雛形は `appendix/proto/src/hook_mac.rs`（199 行）。実機では動かしていない。

#### 撮影と窓探し（行 3・4）

今: 窓の一覧（手前から）から題名の語（既定「雀魂」「Mahjong Soul」）に合う窓を、前面→見えている最初の順で選び、その長方形を GDI で写す。見つからなければカーソルのある画面。撮れなくても記録は残る（`capture_error`）。[コード]

macOS:

- 窓の一覧: `CGWindowListCopyWindowInfo`。手前から並ぶ。ほかのアプリの窓の題名は、画面収録の許可が無いと空になる。[出典 5] 選ぶ関数はそのまま使える。
- 撮影: ScreenCaptureKit の `SCScreenshotManager` で 1 枚だけ（macOS 14 以降）。[出典 6] `captureImageInRect` は画面の長方形を写すので、Windows の BitBlt と同じ意味になる（窓の上に別の窓が重なっていれば、それも写る）。この版は macOS 15.2 以降のはずだが、Apple の文書では確かめていない。14.0〜15.1 では、窓を指す `SCContentFilter` で撮る別の道が要る。
- 古い道: `CGWindowListCreateImage` は macOS 15 の SDK でコンパイルできなくなった（obsoleted）。実行時にはまだ呼べるという報告がある。[出典 7] Rust から直接呼ぶ道はあるが、将来は当てにしない。
- 許可: 画面収録。macOS 15 以降は「画面と音声に直接アクセスしようとしています」という確認が月 1 回出る。[出典 8] 対局中に出ると撮影が失敗し、ダイアログが雀魂の上に出る。macOS 26 で今も出るかは、確かめられていない。対策案は 4 章。
- 遅れ: BitBlt は数 ms の同期処理。ScreenCaptureKit は非同期で、完了を待つ。押下の時刻はタップのコールバックで取る（`now_ms`）ので、記録の時刻は変わらない。画面が撮影までに変わる遅れは、実機で測る。[推測]
- 画素数: Retina は 2 倍。窓 1440×900 pt なら 2880×1800 画素。Windows で保存している画像（1368×800 や 1447×935）より、PNG が大きくなる。そのまま保存するか、1 倍に縮めるかは、文字認識の精度を測って決める（質問 7）。
- ブラウザ版の題名: Chrome は「ページ名 - Google Chrome」、Safari はページ名。既定の語で当たる見込み。[推測]

#### ウィジェットの窓（行 5）

今: `focusable: false`・`always_on_top`・枠なし・影なし・タスクバーに出さない。Windows ではこれに `WS_EX_NOACTIVATE` を足す。位置は物理ピクセルで保存し、画面の外に出ないように直す。[コード]

macOS で tao 0.37.1 が実際にやること（ソースを読んだ）: [コード]

- `focusable(false)` は、窓のクラスの `canBecomeKeyWindow`・`canBecomeMainWindow` を `NO` にする。
- `always_on_top` は `NSFloatingWindowLevel`。`set_visible_on_all_workspaces` は `CanJoinAllSpaces`。
- `skip_taskbar` に対応する処理は macOS 側に見当たらない（Dock の項目はアプリ単位）。
- 足りないもの: 「押してもアプリを前面にしない」は NSPanel の `NonactivatingPanel` の仕事で、普通の NSWindow の設定では済まない。全画面アプリの上に出すには `FullScreenAuxiliary` と、アプリを Accessory（Dock に出ない）にする定石がある。[出典 9][出典 10]
- Tauri の `accept_first_mouse(true)` で、前面でない窓の最初の押下を効かせられる。[コード]
- Dock: 検討画面が開いている間だけ通常、ウィジェットだけの間は Accessory に切り替える案。`AppHandle::set_activation_policy` がある。[コード]

進め方: 最初は tao の設定だけで試す（コードをほぼ足さずに済む）。ブラウザが前面のままか、全画面ブラウザの上に出るかを見て、足りなければ NSPanel にする（`tauri-nspanel` か objc2 で `ns_window()` を直接）。ここは実機で試すまで分からない。位置は、解像度の違う画面が混ざると物理ピクセルが合わなくなるので、Mac では論理座標で保存する案。角丸は DWM の代わりに layer で付ける。[推測]

#### 文字認識（行 6）

今: `ocr` クレートの `geometry`・`locate`・`resample` は純粋で、Windows 以外でも型が通る（確認した。[型検査]）。`locate` の試験は `cfg(windows)` が付いていないので、Windows 以外でも走る作り。Windows 専用なのは `winrt.rs` で、PNG を WinRT で読んで画素にし、拡大した画像を `OcrEngine` に渡して行の配列を得る部分。TypeScript 側（`center-text.ts`）は、空白を除いた行の並びから局・残り枚数・点数を取り出し、読めない部分は部分読みで救う。[コード]

macOS:

- Vision の `VNRecognizeTextRequest` で日本語（`ja-JP`）。macOS 13 以降。[出典 11] Rust からは `objc2-vision` 0.3.2 で呼べる。PNG のバイト列をそのまま渡せ、行を上から順に並べて返す 55 行を、この機械で型検査した。[型検査]
- 画像の読み取り: 水色の文字を色で探す `locate` は画素が要る。Vision にバイト列を渡すだけでは足りず、ImageIO で CGImage にして BGRA にする部分が要る（約 100 行。型検査はまだ）。`png::Decoder` を製品のコードに置かない S-3 の規則には触れない。[コード]
- 癖の違い: Windows の OCR は、1 回目で読めない画像（迷い 6）があり、コントラストを上げた画像と 1.5 倍に広げた画像で読み直している。「余」が「个」になる、局の名前が崩れる、画像の上限が 2,600 画素、という癖にも合わせてある。[コード] Vision で同じ癖が出るとは限らない。同じ固定データ（FX-6 の 19 枚、迷い 6 枚の中央の画像）で測り直す。
- 入力が 2 倍になる: 拡大の倍率（3 倍）と上限（2,600）は 1 倍の画像を前提にしている。Retina の画像では倍率を下げることになる。切り出し（`locate`）は色と形で探すので、画像の大きさによらない作りのまま。[コード]
- 受け入れ: E-20・E-32 は「Windows だけで動く試験」。Mac 版を同じ画像・同じ期待値（局・残り枚数・点数）で作る。行の文字そのものは OS ごとに違うので、エンジンの関数を通した結果で比べる。E-32 の基準は「1 回目と読み直しのどれかで 19 枚すべて」で、1 回目だけでは 19 枚中 14 枚。Vision がそこに届かなかったときは、手で選ぶ導線（F9）が既にあるので、期待をどこに置くかをあなたが決める。
- 仮想マシンの罠: Vision の一部の要求は、GPU の無い仮想環境で動かない報告がある。[出典 12] GitHub のランナー（仮想マシン）で文字認識を保証するのは、期待しない。

#### 管理者の補助プログラム（行 2）

UIPI（昇格した窓に普通の権限のプロセスの入力が届かない）は Windows の仕組みで、雀魂のランチャーが管理者で動くことへの対策だった。[コード] Mac ではブラウザ（通常の権限）で打つので、同じ問題は起きない見込み。[推測] 入力の流れ（`input_flow.rs`）は、補助プログラムの有無を `HelperLink` で持っているので、Mac では常に `Absent`（`choose_hook` が本体のフックを選ぶ）にすればよく、状態機械は変えずに済む。[コード]

設定ページの「補助プログラム」の行は、Mac では「許可」の行に替える: アクセシビリティ・画面収録それぞれの状態（許可済み・未許可）、「許可を求める」、「システム設定を開く」。許可の状態は `AXIsProcessTrusted`・`CGPreflightScreenCaptureAccess`・`CGPreflightListenEventAccess` で、画素は読まずに分かる。雛形に入れた。[型検査]

#### WebView（行 7）

WebView2 の 10 項目（`webview_policy::WebviewFlags`）の、WKWebView での扱い。多くは対応する設定が無く、不要か、画面の JS で足りる。「不要」の判断は WKWebView の標準の挙動についての推測で、実機で N-1〜N-13 を見直す。[推測]

| N | WebView2 の設定 | macOS（WKWebView） |
| --- | --- | --- |
| N-1 | ブラウザのショートカットを止める | Ctrl+P・F5 などのブラウザ機能は元から無い見込み。標準メニューの Cmd+C・V は要る |
| N-2 | ズーム・ピンチ・スワイプ | Tauri のズームの代用は `zoom_hotkeys_enabled(false)` のまま [コード]。ピンチ・スワイプは WKWebView の既定で切れている見込み |
| N-3 | 右クリックのメニュー | 画面側の JS で止める（試験は既にある）。入力欄は標準のまま |
| N-4・N-5 | URL の吹き出し・エラーページ | WKWebView に無い。移動の可否は `on_navigation`（共通）のまま |
| N-6 | ダウンロード | `on_download`（共通）のまま |
| N-7 | 白いちらつき | `set_background_color` は macOS では webview 層に効かない [コード]。「隠して作り、描き終えたら出す」（`window_ready`）で担保済み |
| N-8〜N-11 | 選択・ドラッグ・マウス・入力欄 | CSS・画面側の属性。共通 |
| N-12 | 開発者ツール | `devtools(dev)`（共通） |

`data_directory` は macOS では効かない。代わりに `data_store_identifier`（macOS 14 以降）で保存領域を分ける。[コード][出典 13] mjai の窓（外のサイト、Cloudflare Turnstile）を画面の保存領域と分ける今の作りを、同じ形で保てる。macOS 13 以前では分けられない。Turnstile が WKWebView で通るかは、実機で見る。

#### そのほか（行 8〜15）

- 保存先: 既定の `JantamaReviewerData` は、すでに `HOME` へ回る。[コード] Windows のデータを写せば、そのまま読める作り（記録の中の画像の場所は、半荘のフォルダからの相対）。
- メニュー: Tauri は macOS で標準のアプリメニュー（Cmd+Q・Cmd+C/V など）を既定で付ける（`enable_macos_default_menu`）。[コード] Dock のアイコンを押したとき `RunEvent::Reopen` で検討画面を出す。[コード]
- クリップボード: macOS 15.4 で「許可なしの読み取りの警告」が試験的に入ったが、macOS 26 でも既定では無効で、開発者向けの旗が要るという報告。[出典 14] 窓が前面に戻るたびに読む今の動き（F1）は、当面問題にならない。将来の版で変わるおそれ。
- ごみ箱: `NSFileManager trashItemAtURL`。[出典 15] ごみ箱へ送る口 `Recycler` は既に trait。[コード]
- 作る: `tauri build --bundles app`。実行ファイルだけの作り方（`--no-bundle`）では、macOS 26.1 で画面収録の許可の一覧に出ない報告がある。[出典 16] 許可の確認は `.app` で行う。

## 2. Mac なしで作って動かす

### 2.1 この機械でできること

`cargo check --target aarch64-apple-darwin` が、zig を C のコンパイラにすれば、本体の依存（tauri・tao・wry・objc2・rusqlite の SQLite）まで通る。macOS の SDK は要らない（型検査だけでリンクしないため）。[型検査]

- 元のコードでは、本体に 21 件のエラー（1 件は意図した `compile_error!`）。残りは Windows の部品を外さずに使っている約 10 か所・8 ファイル。これが段階 1 の作業の入り口。
- 段階 1 が終われば、この確認を `pnpm lint` に足し、macOS 向けのコードの型・cfg・`clippy -D warnings` を、Windows の機械で毎回守れる。
- できないこと: リンク、`cargo test` の実行、実行時の挙動、許可、窓。型検査が通っても動くとは限らない。

### 2.2 Mac でやってもらうこと

手順は `appendix/mac-steps.md`。大きくは次のとおり。

- 段階 0: 確かめ用のプログラムを動かす（Rust と Xcode のコマンドラインツールだけ）。許可の状態、窓の題名、横ボタンの番号、横取り、撮影の遅れ、Vision の読みを、数行の出力で知らせてもらう。
- 段階 2 以降: Xcode のコマンドラインツール、Rust 1.90 以上、Node と pnpm 11、`pnpm install`、`pnpm test`、`tauri build --bundles app`。
- Apple Silicon か Intel かで、Rust のターゲットが変わる（`aarch64-apple-darwin` か `x86_64-apple-darwin`）。両対応のユニバーサルも可能（持っている Mac が 1 台なら、その 1 つで足りる）。

### 2.3 署名と許可（TCC）

許可は、アプリの識別（バンドル ID とコード署名）に結び付く。署名なし（ad-hoc）の `.app` は、作り直すたびに識別が変わり、アクセシビリティと画面収録の許可が外れる。[出典 17] 自分用の自己署名の証明書を 1 回作り、毎回それで署名すれば、同じ識別として許可が残る。[出典 17]

| 方法 | 許可が残るか | 費用・手間 | 向き |
| --- | --- | --- | --- |
| ad-hoc（署名なし相当） | 作り直すたびに消える | なし | 確認の 1 回きり |
| 自己署名の証明書（キーチェーンで作成） | 残る | 無料、最初に 5 分 | 自分の Mac で作って使う（推奨） |
| Apple Developer ID | 残る | 年 99 ドル、公証の手間 | 他人に配るとき |

自分の Mac で作ったアプリには、ダウンロードの隔離の印が付かないので、Gatekeeper の「壊れている」表示（docs/recipes にある）は出ない。ダウンロードして入れる場合は `xattr -cr` が要る。[コード]

補足: ad-hoc では `CGPreflightScreenCaptureAccess` が使えない例の報告もある（[出典 18]）が、一次情報で確かめていない。

### 2.4 GitHub の macOS ランナー（任意）

GitHub が貸す Apple silicon の macOS ランナー（`macos-15` など）で、`cargo test` と `pnpm test` と `tauri build --bundles app` を自動で動かせる。[出典 19] 許可が絡む確認（フック・撮影・ウィジェット）はできないが、macOS 上でのコンパイルと、許可の要らない試験は走る。リポジトリが公開なら無料枠の扱い（要確認）。push が要るので、あなたの了承が要る（質問 6）。

## 3. 設計: 共通と薄い層

### 3.1 いま既にある継ぎ目 [コード]

`Capturer`（`capture.rs`）、`Sound`（`sound.rs`）、`Recycler`（`trash.rs`）、`SettingsAccess`（`webview_policy.rs`）、`Effects`（`input_flow.rs`）、`LineReader`（`import/ocr_job.rs`）。Windows の実装を差し込む場所は、ほぼ `lib.rs` の `setup()` の 1 か所に集まっている。

### 3.2 足す継ぎ目

| 足すもの | 中身 | Windows の実装 | macOS の実装 |
| --- | --- | --- | --- |
| `InputHook`（trait） | `apply(Config)`・`set_keyboard_allowed`・`stop`。`HookStatus` を OS 非依存の場所に移す | `hook_win`（既存） | `hook_mac` |
| `Platform`（構造体） | 上のすべてを OS ごとに組んで返す。`#[cfg]` はここだけ | `platform/windows.rs` | `platform/macos.rs` |
| 窓の一覧 | 一覧の取得だけ OS ごと。選ぶ関数は共通 | `capture_win` | `capture_mac` |
| 文字認識の背景 | 「PNG→画素」と「画素→行」の 2 つの口。切り出し・拡大・コントラストは共通 | `winrt` | `mac`（ImageIO + Vision） |
| 許可の状態 | `permissions()`。Windows は「要らない」を返す | なし | AX・CG の確認 |
| ウィジェットの窓の仕上げ | `apply_native_style` の中身 | DWM・NOACTIVATE | NSPanel・Space |
| `PlatformInfo` | OS の名前と、画面に出す言葉（Cmd・Ctrl）。画面は 1 回の命令で受け取る | 固定 | 固定 |

置き場: `jantama-input` に `hook_mac.rs`・`keycodes_mac.rs`、`jantama-ocr` に `mac.rs`、本体に `platform/{windows,macos}.rs`。補助プログラム（`helper`）は Windows のまま。Mac では常に `HelperLink::Absent`、設定ページに補助プログラムの行を出さない（`InputStatus.helper.supported` を足す）。`clipboard-win` は `cfg(windows)` の依存へ移す。

### 3.3 試験

- Windows で守る（機械の関門）: 既存の `pnpm test`・`pnpm lint`。キー表（VK と kVK の往復）、ボタン番号の変換、許可の状態の画面、窓を選ぶ関数、偽の `Capturer`・偽の `InputHook` を使う試験は、OS に依らず Windows で走る。加えて macOS 向けの `check` と `clippy`（2.1）。
- Mac で守る: `pnpm test` を Mac でも通す（段階 2 から）。`pnpm test:hook` の Mac 版は、`CGEventPost` で合成した入力を、本物のタップに通す（目印の付いた入力だけを見張る作りは Windows 版と同じ考え方）。前面の窓が特別でなくても、合成の入力を送るプロセスにアクセシビリティの許可が要る（ターミナルに付ける）。文字認識の試験は、同じ画像で Mac 版を作る。許可・窓・ドライバの絡む確認は手で（`appendix/mac-checks.md`、65 項目）。

ACCEPTANCE への追加案（編集はしていない）: M-1 許可の状態の表示と案内、M-2 横取り（Mac の手動と結合試験）、M-3 撮影は押した瞬間の 1 枚だけ（静的検査）、M-4 ウィジェットがブラウザの前面を奪わない（手動）、M-5 Mac の文字認識（FX-6 の 19 枚）、M-6 macOS 向けの `check`・`clippy` が緑。

## 4. 規約の線引き（Mac でも同じ線）

SPEC 2章の線は、そのまま守れる設計にできる。守る形:

- 対局中に動くのは、ウィジェットが押された（またはボタンが押された）ときの、画面 1 枚の保存と記録の追記だけ。撮影は押下の処理からだけ呼ばれる 1 か所に置く。
- 文字認識は取り込みのときだけ（`ocr` クレートの 1 か所）。Mac でも、保存済みの PNG を読む。
- 通信は mjai の結果の取得（GET 1 種類）だけ。変えない。

macOS の API で、線を越えさせやすいもの:

| 触りたくなる API | できてしまうこと | 方針 |
| --- | --- | --- |
| `SCStream`・`SCStreamOutput`・`CGDisplayStream`・`AVCaptureScreenInput` | 画面を続けて取り続ける（対局中の画面の読み取り） | 使わない。静的検査で語を禁止する |
| `SCScreenshotManager`（1 枚） | 1 枚の撮影 | 撮影モジュールの 1 か所だけ。呼び出し元は押下の処理だけ |
| `AXUIElement*`（アクセシビリティ API） | ほかのアプリの画面の要素・文字を読む | 使わない。`AXIsProcessTrusted`（許可の確認）だけ許す |
| `CGEventTap` | キー入力の全体を見る | 必要なイベントの種類だけ。内容はディスクに残さない。Windows のフックは原因調べ用に直近 128 件のキーコードをメモリに持っている（[コード]）が、Mac では `JANTAMA_TRACE_INPUT` のときだけにする |
| `CGEventPost` など入力の送信 | ゲームに入力を送る | 製品のコードでは使わない（試験だけ） |
| `task_for_pid`・`mach_vm_*`・`vm_read`・`ptrace`・`DYLD_INSERT_LIBRARIES` | ほかのプロセスの読み書き・差し込み | S-1 の禁止の一覧に足す |
| Vision・`VNImageRequestHandler` | 画像の文字認識 | `ocr` クレートの 1 か所だけ（取り込みのとき）。S-3 の許可の一覧に理由つきで足す |
| `screencapture` コマンドの起動 | 外部プロセスでの撮影 | 使わない（撮影の経路を 1 つに保つ） |
| `get-task-allow`（デバッグ用の権限） | ほかのプロセスから付けられる | 配布する作りに入れない |

`CGPreflight*` と `AXIsProcessTrusted` は画素を読まないので、許可の確認に使ってよい。

月 1 回の再確認が対局中に出る問題: 撮影が失敗しても迷いマークの記録（時刻）は残る（`capture_error`。[コード]）が、画像の無い迷いが増える。避ける案は 3 つ。

1. 設定に「撮影の確認」の押しボタンを置き、あなたが対局の前に押す（その場で再確認が出ても困らない）。推奨。
2. 起動時と一定の間隔で、アプリ自身の窓だけの 1 画素の撮影をして、再確認を前倒しで出させる。ゲームは写らないが、「ユーザーの操作のときだけ撮影する」という SPEC 2章の書き方から外れる。やるならあなたの了承が要る。
3. 何もしない。月 1 回、1 枚が失敗するのを受け入れる。

この月 1 回の再確認が macOS の何版で出るか、撮影の API ごとに違うかは、確かめられていない。[出典 8][推測]

## 5. 見積もりと段階

### 5.1 基準にする大きさ

過去の機能を main へ入れた合流の差分（`git diff --shortstat`。試験・文書・画像を含む）。

| 記号 | 機能 | 差分 |
| --- | --- | --- |
| E | 記録の書き出し・読み込み（D-2） | 23 ファイル、+4,015 行 |
| L | 検討ログ | 20 ファイル、+2,855 行 |
| S32 | 中央の板の切り出し（E-32） | 39 ファイル、+2,395 行 |
| W | 補助プログラムほか（W-9〜14） | 49 ファイル、+10,315 / -1,405 行 |
| I | 取り込み（F1・F11） | 68 ファイル、+9,811 行 |

以下の行数は、変更と追加の合計の見込み（試験・文書込み）。

### 5.2 段階

| 段階 | 内容 | 行数 | E 比 | この機械で確かめられる | Mac でしか確かめられない | Mac の確認と往復 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 確かめ用のプログラム（`appendix/proto`、作成済み） | 約 600（作成済み） | - | 型検査 | 全部（許可・窓・横ボタン・撮影・Vision） | 5 つ、1 往復 |
| 1 | 共通化: `Platform`・`InputHook` に分け、`compile_error!` を外し、macOS 側は未実装で返す。画面の出し分けの土台。静的検査の一覧を OS 別に | 1,000〜1,300（大半は移動） | 0.25〜0.3 | すべて（`pnpm test`・`pnpm lint`・macOS 向け `check` と `clippy`） | なし | なし |
| 2 | Mac で検討画面だけ: WKWebView の分、パス、ごみ箱、クリップボード、音、メニュー・Dock、画面の文言、`.app` の設定、Mac で落ちる試験の修正 | 900〜1,200 | 0.25〜0.3 | 型検査、画面の試験、純粋な試験 | 起動、N-1〜N-13、mjai の窓、ごみ箱、書き出し | 14 項目、2〜3 往復 |
| 3 | Mac でウィジェットの入力と撮影: CGEventTap・キー表・窓の一覧・撮影・許可の画面・ウィジェットの窓・位置・静的検査・結合試験 | 2,000〜2,600 | 0.5〜0.65 | 型検査、キー表・変換・許可の画面・窓を選ぶ試験（偽物で） | 許可、横取り、ドライバ、撮影の遅れ、窓の挙動 | 34 項目、4〜6 往復 |
| 4 | Mac で文字認識: 認識の背景を分け、Vision と ImageIO、固定データでの測り直し、必要なら前処理と読み直しの調整 | 1,500〜2,200 | 0.4〜0.55 | 切り出し・読み取りの解釈（純粋）、型検査 | Vision の精度と速さ、Mac で撮った画面での切り出し | 9 項目 + Mac の画面写真 約 10 枚、3〜4 往復 |
| 5 | 梱包: 署名と作り方の手順、`tauri.macos.conf.json`、README の Mac の章、任意で CI | 300〜500 | 0.1 | 設定の検査 | 作り方どおりに作れるか、許可が残るか | 8 項目、1〜2 往復 |
| 合計 |  | 約 5,700〜7,800 | 1.4〜1.9 | | | 65 項目、11〜16 往復 |

行数は、Windows 側の同じ役目の部品の行数（1.1 の表）と、雛形（段階 0）の実測から置いた見込み。雛形は入力 199 行・撮影 152 行・文字認識 55 行で、表の見込み（入力 約 350、撮影 約 250、認識 約 250）より小さい。製品にするときは、設定の変更（フックの入れ替え）、判定との接続、古い版への道、試験用の差し込み口が足されるので、見込みは変えない。実機で動かして直す分は行数に入っていない。往復の数のほうが、実際の手間を表す。1 往復は、あなたの Mac で 20〜40 分の見込み。

段階 2 の状況（2026-10-13、`feature/mac2`）: コードは入れた（OS の情報の受け渡し・設定ページの出し分け・クリップボード・ごみ箱・メニュー・Dock から開き直す・画面を配るオリジン・WKWebView の設定・キーの Cmd への読み替え）。
ウィジェットの窓・タスクトレイは作らず、起動と同時に検討画面を開く形にした（上の表の「起動、メニュー・Dock」は、この形に直した。確認の項目は `appendix/mac-checks.md`）。Mac での確認と作り方は `appendix/mac-steps.md` の A。

Mac で自動の試験を動かしてもらう段階: 2（`pnpm test`）、3（`pnpm test` と Mac 版の `test:hook`）、4（Mac 版の文字認識の試験）、5（きれいな clone からの `pnpm test` と作り）。

段階 1 は Windows だけで終わり、見た目も動きも変わらない。段階 2 までで「Mac で検討画面を見る」ところまで届く。ウィジェットの価値（R13-4 の中心）が出るのは段階 3 で、最も不確実なのもここ。

止めどころ: 段階 3 の最初の実機確認で、(1) 横取りが効かない、(2) ウィジェットがブラウザの前面を奪う、の両方が直らないときは、検討画面だけの対応に縮める判断をあなたにお願いする。

## 6. 危険の一覧

| 危険 | 起きること | 備え |
| --- | --- | --- |
| 許可が作り直しで消える | 作るたびにアクセシビリティと画面収録をやり直し | 自己署名の証明書で毎回署名（2.3） |
| 画面収録の月 1 回の再確認 | 対局中にダイアログが出て、1 枚が撮れない | 「撮影の確認」ボタンを対局前に押す（4 章） |
| マウスのドライバがボタンを変換 | 横ボタンがタップに届かない | 段階 0 の `tap` で確認。届かなければ、キー割り当てか別の道 |
| ウィジェットがブラウザの前面を奪う・全画面の上に出ない | 対局の邪魔、または見えない | NSPanel（3.2）。それでも駄目なら窓モードで打つ |
| Vision の精度が足りない | 迷いの局面への自動の結びつけが減る | 手で選ぶ導線（F9）が既にある。前処理の調整、期待値の見直し |
| macOS の更新で API が変わる | 撮影の道が使えなくなる | 撮影を `Capturer` の裏に閉じる。古い道を直接呼ぶ道は残さない |
| Retina の画像が大きい | 保存の容量が増える | 1 倍に縮めるか選ぶ（質問 7） |

## 7. あなたへの質問

どれも、選択肢と推奨を付ける。答えが要るのは段階が進む前で、先に答えなくても段階 0 と 1 は始められる。

1. Mac の機種・macOS の版・チップ（Apple silicon か Intel）は。
   - 推奨の下限は macOS 14 以降（撮影の API と保存領域の分け方がそろう）。15.2 以降のはず（未確認）なら、撮影が一番簡単。
   - 13 以前だと、撮影に古い道が要り、mjai の窓の保存領域も分けられない。この場合は段階 2 の中身が増える。
2. 雀魂を Mac でどう打つか。
   - ブラウザ版（Chrome・Safari・Edge・Firefox・Arc のどれか）。推奨。窓モードか全画面かも教えてほしい（全画面だとウィジェットの作りが変わる）。
   - アプリ版は Windows のみ。Steam 版（2026-07-20 配信）が Mac に対応するかは、game8 が対応と書き、pixmofu などの報道の要約は Windows のみと書いていて、割れている。Steam のストアページの「対応 OS」を見て知らせてほしい。[出典 20]
3. 迷いマークに使う入力は。
   - マウスの横ボタン（機種とドライバ: Logitech Options+・SteerMouse など）。推奨。段階 0 の `tap` で番号を見る。
   - キーの組み合わせ（Cmd+Option+M など）。マウスの横ボタンが無い・ドライバが変換する場合の道。
   - トラックパッドのみの場合は、キーになる。
4. 署名は。
   - 自己署名の証明書。推奨（2.3）。
   - Apple Developer ID は、他人に配るときだけ。
   - ad-hoc は確認の 1 回きり。
5. 最初に、段階 1（共通化。Windows だけで終わり、見た目は変わらない）を進めてよいか。
   - 推奨はそのまま進めること。チェックが通れば main に入れる（R13-6 のとおり）。macOS 向けの `check`・`clippy` を機械の関門に足す。
   - 段階 0 の確かめ（Mac で 30〜40 分）は並べて進められる。結果が段階 3 の作りを決める。
6. GitHub の macOS ランナーで自動の確認をしてよいか（branch の push と Actions が要る）。
   - 推奨はする（公開のリポジトリなら無料枠の見込み。要確認）。許可の絡まない試験と、macOS 上でのコンパイルが自動で走る。
   - しない場合は、この機械の型検査とあなたの Mac だけで進める。確認の往復が少し増える。
7. Retina の画像の保存は。
   - 段階 3 は、撮ったままの大きさで保存する。
   - 段階 4 で文字認識の精度と容量を測ってから、1 倍に縮めるかを決める。推奨はこの順。
8. 月 1 回の再確認への対策は、4 章の 3 つのうちどれか。推奨は 1（押しボタン）。2 は SPEC 2章の書き方から外れるので、やるならあなたの承認が要る。

## 8. 出典

[出典 1] Apple Developer Forums「Why isn't my app required to get permission for input monitoring?」 https://developer.apple.com/forums/thread/122492 （既定のタップはアクセシビリティ、聞くだけは入力の監視）
[出典 2] Apple「CGEventTapCallBack」 https://developer.apple.com/documentation/coregraphics/cgeventtapcallback ／ Apple Developer Forums「Determining if Accessibility (for CGEventTap) access was revoked?」 https://developer.apple.com/forums/thread/744440 ／ 「Does a listen-only CGEventTap block events handling?」 https://developer.apple.com/forums/thread/734237 （止められたら有効に戻す。コールバックは速く返す）
[出典 3] Sensible Side Buttons https://sensible-side-buttons.archagon.net/ ／ Mac Power Users「Getting back/forward mouse buttons to work」 https://talk.macpowerusers.com/t/getting-back-forward-mouse-buttons-to-work/22033 （横ボタンの番号とドライバの変換）
[出典 4] rdev https://docs.rs/rdev （macOS ではアクセシビリティ。grab は unstable）
[出典 5] pixelcoords の macOS 実装 https://docs.rs/crate/pixelcoords/0.7.6/source/src/mac.rs ／ Chromium の permissions_utils https://chromium.googlesource.com/chromium/src/+/711ab9bc/ui/base/cocoa/permissions_utils.mm （窓の題名と画面収録の許可）
[出典 6] Apple「SCScreenshotManager」 https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager ／ Zenn「ScreenCaptureKit でスクリーンショット」 https://zenn.dev/kyome/articles/c12c8a828173f5 （macOS 14 以降）
[出典 7] google/eclipsa-audio-plugin issue 10 https://github.com/google/eclipsa-audio-plugin/issues/10 ／ getsentry/sentry-unreal issue 1126 https://github.com/getsentry/sentry-unreal/issues/1126 ／ VLC のコミット https://mailman.videolan.org/pipermail/vlc-commits/2026-April/072878.html （macOS 15 の SDK で obsoleted、実行時は呼べる）
[出典 8] 9to5Mac「macOS Sequoia screen recording prompt monthly」 https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/ ／ TidBITS https://tidbits.com/2024/09/23/how-to-avoid-sequoias-repetitive-screen-recording-permissions-prompts/ ／ Apple Developer Forums https://developer.apple.com/forums/thread/765103
[出典 9] tauri-nspanel https://github.com/ahkohd/tauri-nspanel ／ DeepWiki https://deepwiki.com/ahkohd/tauri-nspanel
[出典 10] Apple Developer Forums「Overlay window above all windows, even when moving spaces」 https://origin-devforums.apple.com/forums/thread/826308 ／ Electron の NSPanel の変更 https://ayakael.net/mirrors/electron/commit/05fba85aa38dba54e513cca786ed8ffac1f9f6a5
[出典 11] Apple WWDC22「What's new in Vision」 https://developer.apple.com/videos/play/wwdc2022/10024/ ／ Zenn「VNRecognizeTextRequest」 https://zenn.dev/shu223/articles/textrecognition （日本語は iOS 16・macOS 13 から）
[出典 12] Apple Developer Forums「The Vision request does not work in simulator with Error "Could not create inference context"」 https://developer.apple.com/forums/thread/764948 ／ 「VNRecognizeTextRequest .accurate model failing to load」 https://developer.apple.com/forums/thread/824639
[出典 13] Tauri「tauri-runtime-wry v2.3.0」（`data_store_identifier`） https://v2.tauri.app/release/tauri-runtime-wry/v2.3.0/ ／ Tauri 2.12.2 のソース（`webview_window.rs`: macOS 14 以降）
[出典 14] Michael Tsai「Pasteboard Privacy Preview in macOS 15.4」 https://mjtsai.com/blog/2025/05/12/pasteboard-privacy-preview-in-macos-15-4 ／ 9to5Mac https://9to5mac.com/2025/05/12/macos-16-clipboard-privacy-protection/
[出典 15] Apple「FileManager.trashItem(at:resultingItemURL:)」 https://developer.apple.com/documentation/foundation/filemanager/trashitem(at:resultingitemurl:)
[出典 16] Apple Developer Forums「Plain Executables Do Not Appear Under "Screen & System Audio Recording" on macOS 26.1 (Tahoe)」 https://developer.apple.com/forums/thread/807898
[出典 17] OpenClaw の macOS 署名の文書 https://docs.openclaw.ai/platforms/mac/signing ／ Apple Developer Forums https://developer.apple.com/forums/thread/695689 （ad-hoc は作り直しで許可が消える。安定した署名なら残る）／ Tauri「macOS Code Signing」 https://v2.tauri.app/distribute/sign/macos/
[出典 18] CapSoftware/Cap issue 1722 https://github.com/CapSoftware/Cap/issues/1722 （ad-hoc での `CGPreflightScreenCaptureAccess` の報告。一次情報で未確認）
[出典 19] GitHub Docs「GitHub-hosted runners」 https://docs.github.com/en/actions/reference/runners/github-hosted-runners
[出典 20] 雀魂の Mac 対応: game8 https://game8.jp/jantama/633020 ／ pixmofu https://pixmofu.com/articles/mahjong-soul-jantama-steam-japan-release ／ ファミ通 https://www.famitsu.com/article/202607/81931 ／ 電ファミニコゲーマー https://news.denfaminicogamer.jp/news/2607202c ／ AUTOMATON https://automaton-media.com/articles/newsjp/20260720-455813/ ／ Steam（国際版）https://store.steampowered.com/app/2739990/Mahjong_Soul/ （Windows の要件のみ）

コードの根拠は、このブランチの `apps/desktop/src-tauri`（tao 0.37.1・wry 0.57.0・tauri 2.12.2 のソースは、cargo のキャッシュにある版を読んだ）。

## 9. このフォルダの中身

- `README.md` この文書。
- `appendix/cross-check.md` この機械での macOS 向けの型検査の結果。道具（`check-mac.ps1`・`zigcc.cmd`・`zigar.cmd`）は、段階 1 で `scripts/` へ移した（`pnpm check:mac`）。
- `appendix/proto/` 型検査だけ通した確かめ用の雛形（Rust）。実機では未実行。
- `appendix/mac-steps.md` Mac でやること。A は段階 2（作る・署名する・14 項目の確認）、B は段階 0（確かめ用のプログラム。Logi Options+ の確認を含む）、C は段階 3 以降の許可の流れ。
- `appendix/mac-checks.md` Mac での確認項目 65 の一覧。
