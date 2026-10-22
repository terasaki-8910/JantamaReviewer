//! 安全の検査（ACCEPTANCE の S-1〜S-4、SPEC 2章）。
//!
//! 製品のソース（Rust・TypeScript・HTML・CSS）と依存の一覧を走査して、次のものが入っていないことを確かめる。
//! Rust のソースは、本体（src）・共有の部品（input/src）・管理者で動く補助プログラム（helper/src）のすべて。
//! 補助プログラムには、さらに W-9 の決まり（ファイル・ほかのプログラム・画面・文字認識の部品を持たない。例外は設定と解除の 1 ファイル）を課す。
//! - S-1: ほかのプロセス（ゲーム）のメモリを読み書きする・スレッドを差し込むなどの API。
//! - S-2: 雀魂のドメインへの通信、通信の部品（HTTP クライアントなど）。
//! - S-3: 画像の解析・文字認識のライブラリ（PNG の書き出しは良い）。
//! - S-4: ウィジェットのコードが、ファイル保存と記録の追記以外の窓口（プラグインなど）を読み込むこと。
//! - macOS（段階 1 から。`analysis/mac/README.md` 4 章）: 画面を続けて取り続ける・ほかのアプリの要素を読む・入力を送る・
//!   ほかのプロセスに触れる・外部プロセスで撮影する・デバッグ用の権限を付ける API と部品。静止画 1 枚の撮影・入力のタップ・
//!   文字認識は、決めた 1 か所だけ。段階 2 からは、AppKit・Foundation も、クリップボードの文字・ごみ箱の 2 か所の決めた機能だけ。
//!
//! 走査の道具そのものも、禁止の一覧のすべてを実際に検出できることをテストする。
//! 後の機能が通信や文字認識を足すときは、`ALLOWED_*` に理由つきで足す（取り込み F1・F11 が足したのは、
//! 結果 JSON を取る HTTP クライアントの 1 か所 `ALLOWED_HTTP_CLIENT_FILES` と、保存済みの画像を読む文字認識の 1 か所
//! `ALLOWED_OCR_FILES`）。一覧を黙って緩めない。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// ---- 禁止の一覧 ----

/// S-1: ほかのプロセスに触れる API（大文字小文字を区別する）。
const GAME_PROCESS_APIS: &[&str] = &[
    "ReadProcessMemory",
    "WriteProcessMemory",
    "VirtualAllocEx",
    "VirtualProtectEx",
    "VirtualQueryEx",
    "CreateRemoteThread",
    "NtCreateThreadEx",
    "RtlCreateUserThread",
    "QueueUserAPC",
    "SetThreadContext",
    "OpenProcess",
    "NtReadVirtualMemory",
    "NtWriteVirtualMemory",
    "ZwReadVirtualMemory",
    "ZwWriteVirtualMemory",
    "PROCESS_VM_READ",
    "PROCESS_VM_WRITE",
    "PROCESS_VM_OPERATION",
    "PROCESS_ALL_ACCESS",
    "PROCESS_CREATE_THREAD",
    "DebugActiveProcess",
    "MiniDumpWriteDump",
    "CreateToolhelp32Snapshot",
    "Process32First",
    "Module32First",
    "LoadLibrary",
];

/// S-1: 使ってよいフックの種類。DLL を差し込める種類（WH_CBT など）は使わない。
const ALLOWED_HOOK_IDS: &[&str] = &["WH_MOUSE_LL", "WH_KEYBOARD_LL"];

/// S-1: windows クレートの features のうち、使わないもの。
/// Diagnostics_Debug はほかのプロセスのメモリの読み書き、Memory は別プロセスへの確保、
/// ToolHelp はプロセスの列挙、Media_Ocr は OS の文字認識。
const FORBIDDEN_WINDOWS_FEATURES: &[&str] = &[
    "Win32_System_Diagnostics_Debug",
    "Win32_System_Diagnostics_ToolHelp",
    "Win32_System_Memory",
    "Win32_System_ProcessStatus",
    "Win32_System_Kernel",
    "Win32_System_JobObjects",
    "Media_Ocr",
    "Graphics_Imaging",
];

/// S-2: 雀魂のドメイン（小文字で比べる）。ドメインの末尾のドットまで含めて、窓の題名の語（"Mahjong Soul"）とは区別する。
const GAME_DOMAINS: &[&str] = &[
    "mahjongsoul.",
    "maj-soul.",
    "majsoul.",
    "yo-star.",
    "yostar.",
];

/// S-2: 通信の部品の使い方（Rust のソース）。クレート名は `名前::` の形で探し、
/// 普通の単語（surface など）に当たらないようにする。
const NETWORK_RUST: &[&str] = &[
    "reqwest::",
    "hyper::",
    "ureq::",
    "isahc::",
    "surf::",
    "attohttpc::",
    "tungstenite::",
    "tauri_plugin_http",
    "tauri_plugin_websocket",
    "tauri_plugin_updater",
    "tauri_plugin_shell",
    "tauri_plugin_opener",
    "std::net",
    "TcpStream",
    "TcpListener",
    "UdpSocket",
    "WinHttp",
    "WinINet",
    "InternetOpen",
    "URLDownloadToFile",
    "libcurl",
];

/// S-2: URL の書き方。ソースに URL を書けば通信の疑いがあるので、すべて拒む。
const URL_SCHEMES: &[&str] = &["http://", "https://", "ws://", "wss://"];

/// S-2: 画面側（TypeScript）の通信の窓口。
const NETWORK_TS: &[&str] = &[
    "fetch(",
    "XMLHttpRequest",
    "new WebSocket",
    "EventSource",
    "sendBeacon",
    "axios",
    "from 'http'",
    "from \"http\"",
    "from 'https'",
    "from \"https\"",
    "from 'node:http",
    "from \"node:http",
    "from 'node:net",
    "from \"node:net",
    "@tauri-apps/plugin-http",
    "@tauri-apps/plugin-websocket",
    "@tauri-apps/plugin-shell",
    "@tauri-apps/plugin-opener",
];

/// S-3: 画像の解析・文字認識のクレート（Cargo.toml と Cargo.lock の crate 名。前方一致で見る）。
const VISION_CRATES: &[&str] = &[
    "tesseract",
    "leptess",
    "leptonica",
    "ocrs",
    "rten",
    "opencv",
    "imageproc",
    "onnxruntime",
    "ort",
    "tract-",
    "candle-",
    "tch",
    "burn",
    "paddle",
    "kornia",
    "template-matching",
    "image-compare",
    "rxing",
];

/// S-3: 画像の解析・文字認識の npm パッケージ（package.json と pnpm-lock.yaml）。
const VISION_NPM: &[&str] = &[
    "tesseract.js",
    "opencv",
    "onnxruntime",
    "@tensorflow/",
    "@mediapipe/",
    "pixelmatch",
    "jimp",
    "ocrad",
    "@huggingface/transformers",
    "sharp@",
    "\"sharp\"",
];

/// S-3: 画面側（TypeScript）で画素を読んだり、認識したりする窓口。
const VISION_TS: &[&str] = &[
    "getImageData",
    "createImageBitmap",
    "ImageDecoder",
    "OffscreenCanvas",
    "TextDetector",
    "BarcodeDetector",
    "FaceDetector",
    "tesseract",
];

/// S-3: Rust の画像の解析の窓口（Windows の文字認識と、macOS の Vision）。文字認識のクレート（`ocr`）の外に置かない。
const VISION_RUST: &[&str] = &[
    "Media_Ocr",
    "OcrEngine",
    "Windows.Media.Ocr",
    "VNRecognizeTextRequest",
    "VNImageRequestHandler",
    "VNSequenceRequestHandler",
];

/// 通信してよい場所（ファイル名とその理由）。F1 などが足すときは、必ず理由を書く。
/// ここに載せたファイルは S-2 の走査（雀魂のドメイン・通信の部品・URL の書き方）から外れる。
/// 下の 2 つは、URL やドメインの「文字列」を扱うだけで通信しない、エンジンの小さなファイル。
/// 外れる範囲を広げないため、packages/engine のテスト（purity.test.ts）が、この 2 ファイル以外に URL や
/// 雀魂のドメインが無いことと、エンジン全体が通信・ファイル・時計に触れないことを確かめている。
const ALLOWED_NETWORK_FILES: &[(&str, &str)] = &[
    (
        "packages/engine/src/paipu-link.ts",
        "E-9: 雀魂の牌譜リンク（ドメインと URL の書き方）を読んで、mjai.ekyu.moe の入力欄に入れる文字列に整える。文字列を扱うだけで通信しない",
    ),
    (
        "packages/engine/src/tenhou-url.ts",
        "E-3: 天鳳牌理へのリンクの文字列を作る。文字列を扱うだけで通信しない（リンクは既定のブラウザで開く。N-5）",
    ),
    (
        "input/src/xml_ns.rs",
        "W-9: タスクスケジューラの XML の名前空間（URL の形をした識別子の 1 行だけ）。通信には使わない。補助プログラムの設定で、その XML を作る",
    ),
];

/// 既定のブラウザで URL を開く部品（tauri-plugin-opener）を使ってよい場所（ファイル名とその理由）。
/// この部品は通信しない（OS に URL を渡して、既定のブラウザを起動させるだけ）。それでも通信の部品の一覧に載せているのは、
/// 名前が似ていて紛らわしいため。使えるのはここだけで、開く前に外部の Web ページ（http / https）に絞る（N-5）。
/// 画面側（webview）からは呼べない（プラグインとして登録せず、権限も与えない）。
const ALLOWED_OPENER_FILES: &[(&str, &str)] = &[(
    "src/external.rs",
    "N-5: リンクのクリックと新しい窓の要求を、既定のブラウザに回す。外部の Web ページだけを開く",
)];

/// 開く部品の名前（Rust のソースでの書き方）。
const OPENER_RUST: &str = "tauri_plugin_opener";
/// 開く部品のクレート名（Cargo.toml での書き方）。
const OPENER_CRATE: &str = "tauri-plugin-opener";

/// HTTP のクライアント（ureq）を使ってよい場所（ファイル名とその理由）。アプリが外へ出す通信は、ここの 1 種類だけ。
/// 使えるのはここだけで、本体のクレート（`src-tauri`）の依存にだけ置く。ウィジェット・ボタンを拾う部分・補助プログラムには入れない。
/// 通信先は mjai のサイトの結果の置き場所（`/report/<16 桁の小文字の 16 進数>.json`）に固定し、雀魂のサーバー・牌譜屋には触れない。
const ALLOWED_HTTP_CLIENT_FILES: &[(&str, &str)] = &[(
    "src/import/report_fetch.rs",
    "F1・E-19: ユーザー自身が mjai のサイトで Submit した結果を、GET の 1 種類で 1 回だけ取る。ID の形・通信先・パス・待ち時間・大きさの上限・移動の指示に従わないことを、このファイルの 1 か所に集める",
)];

/// HTTP クライアントの名前（Rust のソースでの書き方）。
const HTTP_CLIENT_RUST: &str = "ureq::";
/// HTTP クライアントのクレート名（Cargo.toml での書き方）。
const HTTP_CLIENT_CRATE: &str = "ureq";

/// 通信の部品のうち、HTTP クライアントの下にだけ入ってよいもの（クレート名とその理由）。
/// ureq が https で通信するときの、Windows の SChannel（OS が信頼する証明書）の窓口。
/// 実行時の依存の一覧では、これらが HTTP クライアントの下にだけ現れることを確かめる。ほかの経路で入ったら、違反。
const TLS_BELOW_HTTP_CLIENT: &[(&str, &str)] = &[(
    "native-tls",
    "ureq の https の通信に使う（Windows では SChannel、macOS では Security.framework。OS の証明書の一覧を使い、同梱の証明書を持たない）",
)];

/// 同期（F15）の通信の部品（`turso` クレートの同期。Turso Cloud の DB と、この PC の中の試験用サーバーにだけつなぐ）を使ってよい場所
/// （ファイル名とその理由）。使えるのはここだけで、本体のクレートの依存にだけ置く。通信先は、`sync/endpoint.rs` が確かめた
/// `*.turso.io` かこの PC の中だけ（`SyncEndpoint` を通ったものしか渡せない）。
const ALLOWED_SYNC_CLIENT_FILES: &[(&str, &str)] = &[(
    "src/sync/remote.rs",
    "F15・D-4: 同期用の DB（Turso の同期）の手元の写しを開き、pull・push を、決めた時間で打ち切って行う。通信先は SyncEndpoint から取った 1 つだけ",
)];

/// 同期の通信の部品の名前（Rust のソースでの書き方）。
const SYNC_CLIENT_RUST: &str = "turso::";
/// 同期の通信の部品のクレート名（Cargo.toml での書き方）。
const SYNC_CLIENT_CRATE: &str = "turso";

/// 通信の部品のうち、同期のクライアントの下にだけ入ってよいもの（クレート名とその理由）。
/// 実行時の依存の一覧では、これらが同期のクライアント（`turso`）の直下からだけ入ることを確かめる。
const NETWORK_BELOW_SYNC_CLIENT: &[(&str, &str)] = &[
    (
        "hyper",
        "turso の同期が使う HTTP の部品（同期用の DB への通信）",
    ),
    (
        "rustls",
        "turso の同期が使う https の部品（Turso Cloud への通信を暗号にする）",
    ),
];

/// 文字認識のクレート（`ocr`）を使ってよい本体のソース（ファイル名とその理由）。取り込みのときだけ動く読み取りの 1 か所。
/// ウィジェット・ボタンを拾う部分・撮影・記録・補助プログラムのコードは、文字認識に触れない（S-3）。
const ALLOWED_OCR_FILES: &[(&str, &str)] = &[(
    "src/import/ocr_job.rs",
    "F11: 取り込みのとき（対局のあと）と、前の作り方で読んだ半荘を読み直すとき（半荘の画面から呼ぶ。取り込みの一部）だけ、すでに保存された迷いマーク・評価の画像から、画面中央の板の文字を読む。結果は半荘のフォルダの ocr.json に残し、同じ作り方では読み直さない",
)];

/// 文字認識のクレートの名前（Rust のソースでの書き方）。
const OCR_RUST: &str = "jantama_ocr";
/// 文字認識のクレート名（Cargo.toml での書き方）。
const OCR_CRATE: &str = "jantama-ocr";

/// 文字認識のクレートが使ってよい windows の feature（理由つき）。保存済みの画像を読み、日本語の文字認識にかけるのに要るものだけ。
/// ほかのクレートには、画像の読み取り・文字認識の feature（`Media_Ocr`・`Graphics_Imaging`）を入れない（S-1 の一覧）。
const OCR_WINDOWS_FEATURES: &[(&str, &str)] = &[
    ("Foundation", "WinRT の基本の型（非同期の処理の待ち）"),
    ("Foundation_Collections", "文字認識の結果の行の一覧を読む"),
    ("Globalization", "文字認識の言語（日本語）を指定する"),
    (
        "Graphics_Imaging",
        "PNG を読んで、文字認識にかけるビットマップにする",
    ),
    ("Media_Ocr", "Windows の日本語の文字認識"),
    ("Storage", "保存済みの画像のファイルを開く（読むだけ）"),
    (
        "Storage_Streams",
        "画像の読み取りと、切り出した画素の受け渡しの入れ物",
    ),
];

/// 文字認識のクレートの実行時の依存に入ってよい部品の接頭辞（理由つき）。windows クレートの一式と、その手続きマクロの部品だけ。
const OCR_ALLOWED_CRATES: &[&str] = &[
    "jantama-ocr",
    "windows",
    "proc-macro2",
    "quote",
    "syn",
    "unicode-ident",
];

/// ウィジェットの画面のコードが読み込んでよいもの。ウィジェットはファイル保存と記録の追記しかしない（S-4）ので、
/// プラグインは一切読まない。`@tauri-apps/api` も、記録のコマンドとイベントの窓口に限る。
/// （迷いだけのウィジェットが、押したまま動かされたとき、窓を動かし始める 1 つだけは、`api/tauri.ts` を通して呼ぶ。
/// 窓の API を読み込むのはそこだけで、許してある操作は `core:window:allow-start-dragging` だけ。
/// `s4_the_only_window_api_the_screens_call_is_start_dragging_from_one_place` が確かめる。）
const WIDGET_ALLOWED_IMPORTS: &[&str] = &[
    "react",
    "react-dom/client",
    "@tauri-apps/api/core",
    "@tauri-apps/api/event",
];

/// ウィジェットが読み込んでよいパッケージの接頭辞。フォント（CSS とフォントのファイル）だけ。
const WIDGET_ALLOWED_IMPORT_PREFIXES: &[&str] = &["@fontsource/"];

// ---- 走査の道具 ----

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("リポジトリのルートを見つけられる")
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn collect_files(dir: &Path, accept: &dyn Fn(&Path) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if name == "node_modules" || name == "target" || name == "dist" || name == "gen" {
                continue;
            }
            collect_files(&path, accept, out);
        } else if accept(&path) {
            out.push(path);
        }
    }
}

fn files_under(dir: &Path, accept: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_files(dir, accept, &mut out);
    out.sort();
    out
}

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| exts.contains(&e))
}

fn is_test_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.contains(".test.") || name.contains(".spec.")
}

/// 本体・共有の部品（input）・補助プログラム（helper）の、クレートのフォルダ。
fn crate_dirs() -> [PathBuf; 3] {
    [
        crate_dir(),
        crate_dir().join("input"),
        crate_dir().join("helper"),
    ]
}

/// 製品の Rust のソース（本体・共有の部品・補助プログラム。どれも `src` の下）。
fn rust_sources() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in crate_dirs() {
        files.extend(files_under(&dir.join("src"), &|p| has_ext(p, &["rs"])));
    }
    files.sort();
    files
}

/// 製品の TypeScript のソース（テストを除く）。
fn ts_sources() -> Vec<PathBuf> {
    let root = repo_root();
    let mut files = files_under(&root.join("apps").join("desktop").join("src"), &|p| {
        has_ext(p, &["ts", "tsx"]) && !is_test_file(p)
    });
    if let Ok(packages) = fs::read_dir(root.join("packages")) {
        for package in packages.flatten() {
            files.extend(files_under(&package.path().join("src"), &|p| {
                has_ext(p, &["ts", "tsx"]) && !is_test_file(p)
            }));
        }
    }
    files.sort();
    files
}

/// 画面の HTML と CSS。
fn web_assets() -> Vec<PathBuf> {
    let desktop = repo_root().join("apps").join("desktop");
    let mut files: Vec<PathBuf> = fs::read_dir(&desktop)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| has_ext(p, &["html"]))
        .collect();
    files.extend(files_under(&desktop.join("src"), &|p| has_ext(p, &["css"])));
    files.sort();
    files
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("{} を読めません: {e}", path.display()))
}

/// 行ごとに、禁止の語を探す。見つかった（行番号, 語）を返す。
fn scan_lines(text: &str, patterns: &[&str], ignore_case: bool) -> Vec<(usize, String)> {
    let mut hits = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let haystack = if ignore_case {
            line.to_lowercase()
        } else {
            line.to_string()
        };
        for pattern in patterns {
            let needle = if ignore_case {
                pattern.to_lowercase()
            } else {
                (*pattern).to_string()
            };
            if haystack.contains(&needle) {
                hits.push((index + 1, (*pattern).to_string()));
            }
        }
    }
    hits
}

/// `WH_` で始まる識別子のうち、許していないもの。
fn disallowed_hook_ids(text: &str) -> Vec<(usize, String)> {
    let mut hits = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let bytes = line.as_bytes();
        let mut i = 0;
        while i + 3 <= bytes.len() {
            let boundary =
                i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
            if boundary && &bytes[i..i + 3] == b"WH_" {
                let end = (i..bytes.len())
                    .find(|&j| {
                        !(bytes[j].is_ascii_uppercase()
                            || bytes[j].is_ascii_digit()
                            || bytes[j] == b'_')
                    })
                    .unwrap_or(bytes.len());
                let id = &line[i..end];
                if !ALLOWED_HOOK_IDS.contains(&id) {
                    hits.push((index + 1, id.to_string()));
                }
                i = end;
            } else {
                i += 1;
            }
        }
    }
    hits
}

/// crate 名・パッケージ名の前方一致の検出。`name = "crate"` の行（Cargo.lock）と、
/// 依存の表の `crate = ...` の行（Cargo.toml）を見る。
fn forbidden_crates_in_manifest(text: &str, forbidden: &[&str]) -> Vec<(usize, String)> {
    let mut hits = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        let name = if let Some(rest) = trimmed.strip_prefix("name = \"") {
            rest.split('"').next().unwrap_or("")
        } else if trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        } else {
            trimmed
                .split(['=', ' '])
                .next()
                .unwrap_or("")
                .trim_matches('"')
        };
        if name.is_empty() {
            continue;
        }
        for pattern in forbidden {
            let matched = if pattern.ends_with('-') {
                name.starts_with(pattern)
            } else {
                name == *pattern || name.starts_with(&format!("{pattern}-"))
            };
            if matched {
                hits.push((index + 1, name.to_string()));
            }
        }
    }
    hits
}

/// TypeScript の import の指定先を取り出す。
fn import_specifiers(text: &str) -> Vec<String> {
    let mut specs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !(line.starts_with("import ") || line.starts_with("export ") || line.contains("import("))
        {
            continue;
        }
        for quote in ['\'', '"'] {
            // from '...' 形式と import('...') / import '...' 形式の両方を拾う。
            let marker_from = format!("from {quote}");
            let marker_paren = format!("import({quote}");
            let marker_bare = format!("import {quote}");
            for marker in [marker_from, marker_paren, marker_bare] {
                if let Some(pos) = line.find(&marker) {
                    let rest = &line[pos + marker.len()..];
                    if let Some(end) = rest.find(quote) {
                        specs.push(rest[..end].to_string());
                    }
                }
            }
        }
    }
    specs
}

fn allowed_network_file(path: &Path) -> bool {
    let name = path.to_string_lossy().replace('\\', "/");
    ALLOWED_NETWORK_FILES
        .iter()
        .any(|(file, _reason)| name.ends_with(file))
}

fn allowed_opener_file(path: &Path) -> bool {
    let name = path.to_string_lossy().replace('\\', "/");
    ALLOWED_OPENER_FILES
        .iter()
        .any(|(file, _reason)| name.ends_with(file))
}

fn allowed_http_client_file(path: &Path) -> bool {
    let name = path.to_string_lossy().replace('\\', "/");
    ALLOWED_HTTP_CLIENT_FILES
        .iter()
        .any(|(file, _reason)| name.ends_with(file))
}

/// 文字認識のクレート（`ocr`）のフォルダ。
fn ocr_dir() -> PathBuf {
    crate_dir().join("ocr")
}

/// 文字認識のクレートのソース（`ocr/src`）。本体・共有の部品・補助プログラムの走査（`rust_sources`）には入れない
/// （画像の読み取り・文字認識の窓口は、ここにだけ置く）。ここには、別の決まりの走査をかける。
fn ocr_sources() -> Vec<PathBuf> {
    files_under(&ocr_dir().join("src"), &|p| has_ext(p, &["rs"]))
}

fn report(rule: &str, file: &Path, hits: &[(usize, String)]) -> String {
    hits.iter()
        .map(|(line, what)| format!("[{rule}] {}:{line}: {what}", file.display()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_no_violations(violations: Vec<String>) {
    assert!(
        violations.is_empty(),
        "安全の検査に違反があります:\n{}",
        violations.join("\n")
    );
}

// ---- 走査の道具のテスト（禁止の一覧が実際に効くこと） ----

#[test]
fn the_scanner_detects_every_forbidden_pattern() {
    let groups: Vec<(&str, &[&str], bool)> = vec![
        ("S-1 API", GAME_PROCESS_APIS, false),
        ("S-2 ドメイン", GAME_DOMAINS, true),
        ("S-2 Rust", NETWORK_RUST, false),
        ("S-2 URL", URL_SCHEMES, false),
        ("S-2 TS", NETWORK_TS, false),
        ("S-3 TS", VISION_TS, false),
        ("S-3 Rust", VISION_RUST, false),
    ];
    for (name, patterns, ignore_case) in groups {
        for pattern in patterns {
            let sample = format!("let x = {pattern}example;");
            let hits = scan_lines(&sample, &[pattern], ignore_case);
            assert_eq!(hits.len(), 1, "{name}: {pattern} を検出できない");
        }
    }
    // 大文字小文字を変えたドメインも見つける。
    assert_eq!(
        scan_lines("GAME.MahjongSoul.COM", GAME_DOMAINS, true).len(),
        1
    );
    assert_eq!(scan_lines("see maj-soul.net", GAME_DOMAINS, true).len(), 1);
}

#[test]
fn the_scanner_does_not_flag_the_window_title_keywords_or_plain_text() {
    // 窓の題名の語（既定の設定）はドメインではない。
    assert!(scan_lines("\"Mahjong Soul\", \"雀魂\"", GAME_DOMAINS, true).is_empty());
    assert!(scan_lines("let hooked = true; // ReadOnly", GAME_PROCESS_APIS, false).is_empty());
    assert!(scan_lines("const fetched = 1;", NETWORK_TS, false).is_empty());
}

#[test]
fn the_hook_id_scan_allows_only_the_low_level_hooks() {
    assert!(disallowed_hook_ids("SetWindowsHookExW(WH_MOUSE_LL, p, h, 0)").is_empty());
    assert!(disallowed_hook_ids("use ...::{WH_KEYBOARD_LL, WH_MOUSE_LL};").is_empty());
    for bad in [
        "WH_CBT",
        "WH_GETMESSAGE",
        "WH_CALLWNDPROC",
        "WH_MOUSE",
        "WH_KEYBOARD",
        "WH_SHELL",
    ] {
        let hits = disallowed_hook_ids(&format!("SetWindowsHookExW({bad}, p, h, 0)"));
        assert_eq!(hits.len(), 1, "{bad}");
        assert_eq!(hits[0].1, bad);
    }
    // 識別子の途中の WH_ は無視する。
    assert!(disallowed_hook_ids("NOWH_THING").is_empty());
}

#[test]
fn the_manifest_scan_finds_forbidden_crates_by_name() {
    let lock =
        "[[package]]\nname = \"tesseract-sys\"\nversion = \"1\"\n\n[[package]]\nname = \"serde\"\n";
    assert_eq!(forbidden_crates_in_manifest(lock, VISION_CRATES).len(), 1);
    let toml = "[dependencies]\nopencv = \"0.9\"\nserde = \"1\"\nort = { version = \"2\" }\n";
    let hits = forbidden_crates_in_manifest(toml, VISION_CRATES);
    assert_eq!(hits.len(), 2, "{hits:?}");
    let ok = "[dependencies]\npng = \"0.18\"\nchrono = \"0.4\"\nimage = \"0.25\"\n";
    assert!(forbidden_crates_in_manifest(ok, VISION_CRATES).is_empty());
    // 前方一致は crate 名の区切りでだけ効く（"ort" が "port" に当たらない）。
    assert!(
        forbidden_crates_in_manifest("name = \"portable\"\nname = \"sort\"", VISION_CRATES)
            .is_empty()
    );
}

#[test]
fn the_import_scan_reads_all_import_forms() {
    let text = "import { a } from 'react';\nimport b from \"@tauri-apps/api/core\";\nexport * from './x';\nconst m = await import('@tauri-apps/plugin-fs');\nimport './styles.css';\n";
    assert_eq!(
        import_specifiers(text),
        vec![
            "react",
            "@tauri-apps/api/core",
            "./x",
            "@tauri-apps/plugin-fs",
            "./styles.css"
        ]
    );
}

// ---- S-1: ゲームに触れない ----

#[test]
fn s1_no_source_touches_another_process() {
    let mut violations = Vec::new();
    let mut files = rust_sources();
    files.extend(ts_sources());
    assert!(!files.is_empty(), "走査の対象が見つからない");
    for file in &files {
        let text = read(file);
        violations.push(report(
            "S-1",
            file,
            &scan_lines(&text, GAME_PROCESS_APIS, false),
        ));
        if has_ext(file, &["rs"]) {
            violations.push(report("S-1 フック", file, &disallowed_hook_ids(&text)));
        }
    }
    assert_no_violations(violations.into_iter().filter(|v| !v.is_empty()).collect());
}

#[test]
fn s1_windows_crate_features_exclude_cross_process_and_ocr_apis() {
    let mut violations = Vec::new();
    for dir in crate_dirs() {
        let toml = read(&dir.join("Cargo.toml"));
        for (line, feature) in scan_lines(&toml, FORBIDDEN_WINDOWS_FEATURES, false) {
            violations.push(format!(
                "[S-1] {}/Cargo.toml:{line}: windows の feature {feature}",
                dir.display()
            ));
        }
    }
    assert_no_violations(violations);
}

// ---- S-2: ゲームや外部と通信しない ----

#[test]
fn s2_no_source_mentions_a_mahjong_soul_domain() {
    let mut violations = Vec::new();
    let mut files = rust_sources();
    files.extend(ts_sources());
    files.extend(web_assets());
    for file in &files {
        if allowed_network_file(file) {
            continue;
        }
        let hits = scan_lines(&read(file), GAME_DOMAINS, true);
        if !hits.is_empty() {
            violations.push(report("S-2 ドメイン", file, &hits));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s2_no_rust_source_uses_a_network_client() {
    let mut violations = Vec::new();
    for file in rust_sources() {
        if allowed_network_file(&file) {
            continue;
        }
        let text = read(&file);
        let mut hits = scan_lines(&text, NETWORK_RUST, false);
        if allowed_opener_file(&file) {
            hits.retain(|(_, what)| what != OPENER_RUST);
        }
        if allowed_http_client_file(&file) {
            hits.retain(|(_, what)| what != HTTP_CLIENT_RUST);
        }
        hits.extend(scan_lines(&text, URL_SCHEMES, false));
        if !hits.is_empty() {
            violations.push(report("S-2 Rust", &file, &hits));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s2_no_typescript_source_reaches_the_network() {
    let mut violations = Vec::new();
    for file in ts_sources() {
        if allowed_network_file(&file) {
            continue;
        }
        let text = read(&file);
        let mut hits = scan_lines(&text, NETWORK_TS, false);
        hits.extend(scan_lines(&text, URL_SCHEMES, false));
        if !hits.is_empty() {
            violations.push(report("S-2 TS", &file, &hits));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s2_html_and_css_load_nothing_from_outside() {
    // 外部のフォントや画像を読み込むと、起動のたびに通信が起きる。
    let mut violations = Vec::new();
    let assets = web_assets();
    assert!(!assets.is_empty(), "走査の対象が見つからない");
    for file in assets {
        let hits = scan_lines(&read(&file), URL_SCHEMES, false);
        if !hits.is_empty() {
            violations.push(report("S-2 外部の読み込み", &file, &hits));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s2_cargo_toml_declares_no_network_dependency() {
    let network = [
        "reqwest",
        "hyper",
        "ureq",
        "isahc",
        "surf",
        "attohttpc",
        "curl",
        "tungstenite",
        "tokio-tungstenite",
        "websocket",
        "tauri-plugin-http",
        "tauri-plugin-websocket",
        "tauri-plugin-updater",
        "tauri-plugin-shell",
    ];
    let mut violations = Vec::new();
    let mut dirs = crate_dirs().to_vec();
    dirs.push(ocr_dir());
    for dir in dirs {
        let toml = read(&dir.join("Cargo.toml"));
        for (line, name) in forbidden_crates_in_manifest(&toml, &network) {
            // HTTP クライアントは、本体のクレートの依存にだけ置く（理由は ALLOWED_HTTP_CLIENT_FILES）。
            if dir == crate_dir() && name == HTTP_CLIENT_CRATE {
                continue;
            }
            violations.push(format!(
                "[S-2] {}/Cargo.toml:{line}: 通信の部品 {name}",
                dir.display()
            ));
        }
    }
    assert_no_violations(violations);

    // 本体のクレートが HTTP クライアントを宣言しているのは 1 つだけで、既定の機能（rustls・圧縮など）を切り、
    // TLS は Windows の SChannel（native-tls）だけにしている。
    let main_toml = read(&crate_dir().join("Cargo.toml"));
    let declared: Vec<&str> = main_toml
        .lines()
        .filter(|l| {
            l.trim_start()
                .starts_with(&format!("{HTTP_CLIENT_CRATE} = "))
        })
        .collect();
    assert_eq!(declared.len(), 1, "{declared:?}");
    assert!(
        declared[0].contains("default-features = false")
            && declared[0].contains("features = [\"native-tls\"]"),
        "HTTP クライアントは、既定の機能を切って native-tls だけにする: {}",
        declared[0]
    );
}

/// HTTP のクライアントは、許した 1 か所だけが使い、結果の取得（GET の 1 種類）しかできない形のままであること（S-2）。
#[test]
fn s2_the_http_client_is_only_used_from_its_one_file_and_it_can_only_get_the_report() {
    // どのソースがクライアントの名前を持つか。
    let mut users: Vec<String> = Vec::new();
    for file in rust_sources() {
        if read(&file).contains(HTTP_CLIENT_RUST) {
            users.push(file.to_string_lossy().replace('\\', "/"));
        }
    }
    assert_eq!(users.len(), ALLOWED_HTTP_CLIENT_FILES.len(), "{users:?}");
    for user in &users {
        assert!(
            ALLOWED_HTTP_CLIENT_FILES
                .iter()
                .any(|(file, reason)| user.ends_with(file) && !reason.is_empty()),
            "許していない場所が HTTP クライアントを使っている: {user}"
        );
    }

    for (file, _) in ALLOWED_HTTP_CLIENT_FILES {
        let text = read(&crate_dir().join(file));
        let product = product_part(&text);
        // 要求は GET の 1 つだけ（呼び出しは 1 か所）。ほかの種類の要求・本文を送る口・クッキーは使わない。
        assert_eq!(product.matches(".get(url.as_str())").count(), 1, "{file}");
        assert_eq!(product.matches(".call()").count(), 1, "{file}");
        for forbidden in [
            ".post(",
            ".put(",
            ".delete(",
            ".patch(",
            ".head(",
            ".options(",
            ".send(",
            ".send_json(",
            ".send_form(",
            ".send_empty(",
            ".run(",
            "ureq::get(",
            "ureq::post(",
            "ureq::put(",
            "ureq::delete(",
            "ureq::head(",
            "ureq::patch(",
            "ureq::run(",
            "ureq::agent(",
            "cookie",
            "Cookie",
        ] {
            assert!(
                !product.contains(forbidden),
                "{file}: {forbidden} を使っている"
            );
        }
        // 守り: 通信先は固定の形で組み立てる（ID の形の確認は ReportId が先）。移動の指示に従わず、待ち時間と大きさに上限を付け、
        // https の通信は OS の証明書で確かめる。
        for needle in [
            "endpoint.report_url(id)",
            "max_redirects(0)",
            "timeout_global(",
            "timeout_connect(",
            ".limit(",
            "https_only(endpoint.is_secure())",
            "TlsProvider::NativeTls",
            "RootCerts::PlatformVerifier",
            "ReportId::parse(",
        ] {
            assert!(product.contains(needle), "{file}: {needle} が無い");
        }
        let url_at = product.find("endpoint.report_url(id)").unwrap();
        let call_at = product.find(".call()").unwrap();
        assert!(
            url_at < call_at,
            "{file}: 通信先を固定の形で組み立ててから、通信する"
        );
        // 文字の ID から取る入口は、形を確かめてから、取る。
        let by_text = product
            .split("pub fn fetch_report_by_text(")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .unwrap_or_else(|| panic!("{file}: fetch_report_by_text が無い"));
        assert!(
            by_text.contains("ReportId::parse(id)") && by_text.contains("FetchError::InvalidId"),
            "{file}: ID の形を確かめてから使う"
        );
    }

    // 通信先を差し替える関数は、製品のコードでは呼ばない（試験だけ）。製品の取得の入口は、製品の通信先だけを使う。
    let report_fetch = read(
        &crate_dir()
            .join("src")
            .join("import")
            .join("report_fetch.rs"),
    );
    assert!(
        !product_part(&report_fetch).contains("ReportEndpoint::for_test"),
        "report_fetch.rs の製品の部分が、試験用の通信先を使っている"
    );
    let mut endpoint_users: Vec<String> = Vec::new();
    for file in rust_sources() {
        let name = file.to_string_lossy().replace('\\', "/");
        let text = read(&file);
        if name.ends_with("src/import/report_fetch.rs") {
            continue;
        }
        assert!(
            !text.contains("for_test("),
            "{name}: 試験用の通信先を、製品のコードが使っている"
        );
        if text.contains("ReportEndpoint::") {
            endpoint_users.push(name);
        }
    }
    assert_eq!(endpoint_users.len(), 1, "{endpoint_users:?}");
    assert!(endpoint_users[0].ends_with("src/import/commands.rs"));
    let commands = read(&crate_dir().join("src").join("import").join("commands.rs"));
    assert_eq!(
        commands.matches("ReportEndpoint::").count(),
        commands.matches("ReportEndpoint::production()").count(),
        "取得の入口は、製品の通信先（production）だけを使う"
    );
}

/// 既定のブラウザで URL を開く部品（tauri-plugin-opener）は、許した 1 か所からだけ、開く関数だけを使う。
/// プラグインとして登録せず、権限も与えないので、画面側（webview）からは呼べない。
#[test]
fn s2_the_opener_is_only_called_from_its_one_file_and_not_reachable_from_the_webview() {
    // どのソースがこの部品の名前を持つか。
    let mut users: Vec<String> = Vec::new();
    for file in rust_sources() {
        if read(&file).contains(OPENER_RUST) {
            users.push(file.to_string_lossy().replace('\\', "/"));
        }
    }
    assert_eq!(users.len(), ALLOWED_OPENER_FILES.len(), "{users:?}");
    for user in &users {
        assert!(
            ALLOWED_OPENER_FILES
                .iter()
                .any(|(file, reason)| user.ends_with(file) && !reason.is_empty()),
            "許していない場所が開く部品を使っている: {user}"
        );
    }

    // 許した場所では、開く関数だけを、外部の Web ページの確認のあとに呼ぶ。
    for (file, _) in ALLOWED_OPENER_FILES {
        let text = read(&crate_dir().join(file));
        let calls: Vec<&str> = text
            .match_indices(&format!("{OPENER_RUST}::"))
            .map(|(at, _)| text[at..].split('(').next().unwrap_or(""))
            .collect();
        assert!(!calls.is_empty(), "{file}: 開く部品を使っていない");
        for call in &calls {
            assert_eq!(
                *call,
                &format!("{OPENER_RUST}::open_url"),
                "{file}: 開く関数以外を使っている"
            );
        }
        let guard = text
            .find("is_external_web_page(url)")
            .expect("外部の Web ページの確認がある");
        let open = text
            .find(&format!("{OPENER_RUST}::open_url"))
            .expect("開く関数を呼ぶ");
        assert!(guard < open, "{file}: 開く前に外部の Web ページか確かめる");
    }

    // プラグインとして登録していない（画面からの呼び出しの口が無い）。
    assert!(
        !read(&crate_dir().join("src").join("lib.rs")).contains(&format!("{OPENER_RUST}::init"))
    );
    // どの窓の権限にも、開く部品の権限が無い。
    let capabilities = files_under(&crate_dir().join("capabilities"), &|p| {
        has_ext(p, &["json"])
    });
    assert!(!capabilities.is_empty());
    for file in capabilities {
        assert!(!read(&file).contains("opener"), "{}", file.display());
    }
    // Cargo.toml が、この部品を宣言している（使っているのに宣言が無い、という食い違いを防ぐ）。
    let toml = read(&crate_dir().join("Cargo.toml"));
    assert_eq!(
        forbidden_crates_in_manifest(&toml, &[OPENER_CRATE]).len(),
        1,
        "Cargo.toml に {OPENER_CRATE} が 1 つだけある"
    );
}

/// 実際に組み込まれる依存（`cargo tree -e normal`）に、通信の部品も画像解析の部品も入っていないこと。
/// Cargo.toml の直接の依存だけでなく、Tauri などを通じて間接的に入るものも見る。
#[test]
fn s2_s3_the_runtime_dependency_graph_has_no_network_or_vision_crates() {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "tree",
            "-e",
            "normal",
            "--prefix",
            "none",
            "--format",
            "{p}",
            "--offline",
        ])
        .current_dir(crate_dir())
        .output()
        .expect("cargo tree を実行できる");
    assert!(
        output.status.success(),
        "cargo tree が失敗: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    // 各行は「名前 v版 …」。
    let packages: Vec<(String, String)> = text
        .lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            Some((
                words.next()?.to_string(),
                words.next()?.trim_start_matches('v').to_string(),
            ))
        })
        .collect();
    let crates: Vec<&str> = packages.iter().map(|(name, _)| name.as_str()).collect();
    assert!(crates.contains(&"tauri"), "依存の一覧を読めていない");
    // 理由つきで許した部品が、実際に依存に入っている（許可が、無い部品を指していない）。
    assert!(
        crates.contains(&HTTP_CLIENT_CRATE),
        "HTTP クライアントが依存に無い"
    );
    assert!(
        crates.contains(&OCR_CRATE),
        "文字認識のクレートが依存に無い"
    );

    let network = [
        "reqwest",
        "hyper",
        "ureq",
        "isahc",
        "surf",
        "attohttpc",
        "tungstenite",
        "tokio-tungstenite",
        "websocket",
        "native-tls",
        "rustls",
        "openssl",
    ];
    let mut violations = Vec::new();
    for (name, version) in &packages {
        if network.contains(&name.as_str()) {
            // 通信の部品は、本体のクレートが直接宣言した HTTP クライアントと、その下の TLS の窓口だけ。
            violations.extend(network_crate_violations(name, version));
        }
        let manifest_line = format!("{name} = 1");
        for (_, hit) in forbidden_crates_in_manifest(&manifest_line, VISION_CRATES) {
            violations.push(format!("[S-3] 実行時の依存に画像解析の部品 {hit}"));
        }
    }
    assert_no_violations(violations);
}

/// 実行時の依存の中の通信の部品 `名前@版` が、許していない経路で入っていないかを調べる（`cargo tree -i` の逆向きの木）。
/// 許す経路は 2 つだけ: 本体のクレートが直接宣言した HTTP クライアント自身（`ALLOWED_HTTP_CLIENT_FILES`）と、
/// その下にだけ現れる TLS の窓口（`TLS_BELOW_HTTP_CLIENT`）。補助プログラム・共有の部品（input）・文字認識のクレートの下、
/// ほかの部品を通って入るものは、違反。
fn network_crate_violations(name: &str, version: &str) -> Vec<String> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let spec = format!("{name}@{version}");
    let output = Command::new(cargo)
        .args([
            "tree",
            "-p",
            "jantama-reviewer",
            "-e",
            "normal",
            "-i",
            &spec,
            "--no-dedupe",
            "--prefix",
            "depth",
            "--format",
            "{p}",
            "--offline",
        ])
        .current_dir(crate_dir())
        .output()
        .expect("cargo tree を実行できる");
    assert!(
        output.status.success(),
        "cargo tree -i {spec} が失敗: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    // 各行は「深さ 名前 v版 …」。逆向きの木なので、根（深さ 0）が調べる部品で、深さが増えるほど、それを使う側になる。
    let lines: Vec<(usize, String)> = text
        .lines()
        .filter_map(|l| {
            let digits = l.chars().take_while(char::is_ascii_digit).count();
            let depth = l[..digits].parse::<usize>().ok()?;
            let package = l[digits..].split_whitespace().next()?.to_string();
            Some((depth, package))
        })
        .collect();
    assert!(!lines.is_empty(), "{spec}: 木を読めない");

    let mut violations = Vec::new();
    let mut path: Vec<String> = Vec::new();
    for (index, (depth, package)) in lines.iter().enumerate() {
        path.truncate(*depth);
        path.push(package.clone());
        let is_leaf = lines.get(index + 1).is_none_or(|(next, _)| next <= depth);
        if !is_leaf {
            continue;
        }
        // 根（調べる部品）から、使う側へたどった 1 本の経路。最後は、本体のクレートのはず。
        let shown = path.join(" ← ");
        let ends_at_main = path.last().is_some_and(|last| last == "jantama-reviewer");
        let allowed = ends_at_main
            && if name == HTTP_CLIENT_CRATE {
                // HTTP クライアントは、本体のクレートが直接使う（間に別の部品を挟まない）。
                path.len() == 2
            } else if name == SYNC_CLIENT_CRATE {
                false
            } else {
                // TLS の窓口は、HTTP クライアントを通ってだけ入る。
                let below_http = path.iter().any(|p| p == HTTP_CLIENT_CRATE)
                    && TLS_BELOW_HTTP_CLIENT
                        .iter()
                        .any(|(allowed, reason)| *allowed == name && !reason.is_empty());
                // 同期の通信の部品は、同期のクライアント（本体のクレートが直接使う `turso`）の直下からだけ入る。
                let below_sync = path.len() >= 3
                    && path[path.len() - 2] == SYNC_CLIENT_CRATE
                    && NETWORK_BELOW_SYNC_CLIENT
                        .iter()
                        .any(|(allowed, reason)| *allowed == name && !reason.is_empty());
                below_http || below_sync
            };
        if !allowed {
            violations.push(format!(
                "[S-2] 実行時の依存に、許していない経路の通信の部品: {shown}"
            ));
        }
    }
    violations
}

// ---- S-2: 記録の同期（F15）の通信は、決めた 1 か所だけ ----

/// 同期のソース（`src/sync/` の下の、製品のもの）。
fn sync_sources() -> Vec<PathBuf> {
    files_under(&crate_dir().join("src").join("sync"), &|p| {
        has_ext(p, &["rs"])
    })
}

fn sync_file(name: &str) -> String {
    read(&crate_dir().join("src").join("sync").join(name))
}

/// 同期の通信の部品（`turso`）は、許した 1 か所だけが使い、本体のクレートだけが、既定の機能を切り、版を固定して宣言する。
#[test]
fn s2_the_sync_client_is_used_from_its_one_file_and_declared_once_by_the_main_crate() {
    let mut users: Vec<String> = Vec::new();
    for file in rust_sources() {
        if product_part(&read(&file)).contains(SYNC_CLIENT_RUST) {
            users.push(file.to_string_lossy().replace('\\', "/"));
        }
    }
    assert_eq!(users.len(), ALLOWED_SYNC_CLIENT_FILES.len(), "{users:?}");
    for user in &users {
        assert!(
            ALLOWED_SYNC_CLIENT_FILES
                .iter()
                .any(|(file, reason)| user.ends_with(file) && !reason.is_empty()),
            "許していない場所が同期の通信の部品を使っている: {user}"
        );
    }
    // 共有の部品・補助プログラム・文字認識のクレートは、宣言しない
    for dir in [
        crate_dir().join("input"),
        crate_dir().join("helper"),
        ocr_dir(),
    ] {
        let toml = read(&dir.join("Cargo.toml"));
        assert!(
            forbidden_crates_in_manifest(&toml, &[SYNC_CLIENT_CRATE]).is_empty(),
            "{} が同期の通信の部品を宣言している",
            dir.display()
        );
    }
    // 本体のクレートの宣言は 1 つで、既定の機能（mimalloc・全文検索）を切り、同期の機能だけを入れ、版を `=` で固定する
    let main_toml = read(&crate_dir().join("Cargo.toml"));
    let declared: Vec<&str> = main_toml
        .lines()
        .filter(|l| {
            l.trim_start()
                .starts_with(&format!("{SYNC_CLIENT_CRATE} = "))
        })
        .collect();
    assert_eq!(declared.len(), 1, "{declared:?}");
    assert!(
        declared[0].contains("default-features = false")
            && declared[0].contains("features = [\"sync\"]")
            && declared[0].contains("version = \"=0."),
        "同期の通信の部品は、既定の機能を切って、同期だけにし、版を固定する: {}",
        declared[0]
    );
}

/// 同期の通信先は、`SyncEndpoint`（設定に貼った Turso Cloud の DB の `*.turso.io` か、この PC の中）から取った 1 つだけ。
#[test]
fn s2_the_sync_destination_is_only_a_checked_turso_host_or_this_pc() {
    let remote = sync_file("remote.rs");
    let product = product_part(&remote);
    // 手元の写しを開くのは 1 か所で、通信先は、`SyncEndpoint` から取った文字だけ
    assert_eq!(product.matches("Builder::new_remote(").count(), 1);
    assert_eq!(product.matches(".with_remote_url(").count(), 1);
    assert_eq!(product.matches("endpoint.base_url()").count(), 1);
    assert!(product.contains("endpoint: &SyncEndpoint"));
    // 通信は、`pull` と `push` の 2 つだけ（どちらも打ち切りの時間つき）
    assert_eq!(product.matches("db.pull()").count(), 1);
    assert_eq!(product.matches("db.push()").count(), 1);
    assert!(product.contains("tokio::time::timeout(limit, handle.db.pull())"));
    assert!(product.contains("tokio::time::timeout(limit, handle.db.push())"));
    assert!(product.contains("tokio::time::timeout(limit, build)"));

    // 通信先の検査: `*.turso.io` と、この PC の中だけ。試験用に緩める入口が無い
    let endpoint = sync_file("endpoint.rs");
    let endpoint_product = product_part(&endpoint);
    assert!(endpoint_product.contains("TURSO_HOST_SUFFIX: &str = \".turso.io\""));
    assert!(endpoint_product.contains("Ipv4(ip)) => ip.is_loopback()"));
    assert!(endpoint_product.contains("Ipv6(ip)) => ip.is_loopback()"));
    assert!(endpoint_product.contains("eq_ignore_ascii_case(\"localhost\")"));
    assert!(!endpoint_product.contains("for_test"));
    // `SyncEndpoint` を、検査を通さずに作れない（フィールドが非公開で、作るのは `parse` だけ）
    assert!(endpoint_product.contains("pub fn parse(text: &str)"));
    assert!(endpoint_product.contains("pub struct SyncEndpoint {"));
    assert!(endpoint_product.contains("scheme: &'static str,"));
    assert!(!endpoint_product.contains("pub scheme") && !endpoint_product.contains("pub host"));
    for file in sync_sources() {
        let name = file.to_string_lossy().replace('\\', "/");
        if name.ends_with("src/sync/endpoint.rs") {
            continue;
        }
        assert!(
            !product_part(&read(&file)).contains("SyncEndpoint {"),
            "{name}: 通信先を、検査を通さずに作っている"
        );
    }
    // 同期用の DB を開くのは、アプリのつなぎ（commands.rs）の 1 か所だけ。開く前に、貼った URL を `parse` で確かめる
    let users = product_files_containing("TursoRemote::new(");
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(users[0].ends_with("src/sync/commands.rs"), "{users:?}");
    let service = sync_file("service.rs");
    let service = product_part(&service);
    let parse_at = service
        .find("SyncEndpoint::parse(&config.url)")
        .expect("開く前に、通信先を確かめている");
    let open_at = service
        .find("(self.open_remote)(")
        .expect("同期用の DB を開く");
    assert!(parse_at < open_at, "通信先を確かめてから、開く");
    // 通信先を保存する前にも、確かめている
    assert!(service.contains("SyncEndpoint::parse(url).map_err"));
}

/// トークンは、OS の資格情報の保管庫にだけ置く。取り出す所は決まっていて、ファイル・ログ・パニックの文に出さない。
#[test]
fn s2_the_sync_token_is_exposed_only_where_it_is_needed_and_never_written_or_printed() {
    // 保管庫の部品（keyring）は、`credentials.rs` だけが使い、本体のクレートだけが宣言する
    let users = product_files_containing("keyring::");
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(users[0].ends_with("src/sync/credentials.rs"), "{users:?}");
    for dir in [
        crate_dir().join("input"),
        crate_dir().join("helper"),
        ocr_dir(),
    ] {
        let toml = read(&dir.join("Cargo.toml"));
        assert!(
            forbidden_crates_in_manifest(&toml, &["keyring"]).is_empty(),
            "{} が保管庫の部品を宣言している",
            dir.display()
        );
    }
    // トークンの文字を取り出せるのは、通信に渡す所（remote.rs）と、伏せ字・鍵の計算の所（service.rs）だけ
    let exposers = product_files_containing(".expose()");
    let names: Vec<&str> = exposers
        .iter()
        .map(|p| p.rsplit("src/").next().unwrap_or(p))
        .collect();
    assert_eq!(
        names,
        vec!["sync/remote.rs", "sync/service.rs"],
        "{names:?}"
    );
    // 設定のファイルの形に、トークンの項目が無い
    let base = sync_file("base.rs");
    let config_at = base
        .find("pub struct SyncConfig {")
        .expect("設定の形がある");
    let config_block = &base[config_at
        ..base[config_at..]
            .find("\n}\n")
            .map_or(base.len(), |n| config_at + n)];
    assert!(
        !config_block.to_lowercase().contains("token"),
        "設定のファイルに、トークンの項目がある"
    );
    // トークンを持つ型は、`Display` も `Serialize` も持たない（`Debug` は伏せる）
    let credentials = sync_file("credentials.rs");
    let credentials = product_part(&credentials);
    assert!(credentials.contains("pub struct Secret(String);"));
    assert!(!credentials.contains("impl fmt::Display for Secret"));
    assert!(!credentials.contains("derive(Serialize"));
    assert!(credentials.contains("write!(f, \"Secret({MASK})\")"));
    // トークン・秘密の語を含む行で、書き出し・表示・パニックを起こさない
    let outputs = [
        "println!",
        "eprintln!",
        "print!(",
        "dbg!(",
        "panic!(",
        "write!(",
        "writeln!(",
        "fs::write(",
        "write_atomic(",
        ".unwrap()",
        ".expect(",
    ];
    let mut violations = Vec::new();
    for file in sync_sources() {
        let text = read(&file);
        for (number, line) in product_part(&text).lines().enumerate() {
            let lower = line.to_lowercase();
            let mentions = lower.contains("token") || lower.contains("secret");
            if !mentions || line.trim_start().starts_with("//") {
                continue;
            }
            for output in outputs {
                // トークンの文字を作る・渡す行ではなく、書く・出す行だけを見る
                if line.contains(output)
                    && !line.contains("MASK")
                    && !line.contains("redact(")
                    && !line.contains("sha256_hex")
                {
                    violations.push(format!("{}:{}: {line}", file.display(), number + 1));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "トークンの語がある行で、書き出し・表示・パニックの恐れ:\n{}",
        violations.join("\n")
    );
}

/// 同期は、同期しないもの（スクショ・ウィジェットの記録・文字認識の写し）に触れない。
#[test]
fn s2_the_sync_never_names_the_files_it_must_not_sync() {
    let forbidden = [
        "EVENTS_FILE",
        "OCR_FILE",
        "MARKS_DIR",
        "RATINGS_DIR",
        "events.jsonl",
        "ocr.json",
        "\"marks\"",
        "\"ratings\"",
        ".png",
        "load_ocr",
        "save_ocr",
        "screenshots_of",
    ];
    for file in sync_sources() {
        let text = read(&file);
        for word in forbidden {
            assert!(
                !product_part(&text).contains(word),
                "{}: 同期しないもの {word} に触れている",
                file.display()
            );
        }
    }
}

// ---- S-3: 対局中に画面を読まない ----

#[test]
fn s3_no_vision_or_ocr_crate_in_cargo_toml_or_cargo_lock() {
    let mut violations = Vec::new();
    let mut manifests: Vec<PathBuf> = crate_dirs().iter().map(|d| d.join("Cargo.toml")).collect();
    manifests.push(crate_dir().join("Cargo.lock"));
    for path in manifests {
        for (line, name) in forbidden_crates_in_manifest(&read(&path), VISION_CRATES) {
            violations.push(format!(
                "[S-3] {}:{line}: 画像解析・文字認識の部品 {name}",
                path.display()
            ));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s3_no_vision_or_ocr_package_in_the_npm_manifests() {
    let root = repo_root();
    let mut manifests = vec![
        root.join("package.json"),
        root.join("apps").join("desktop").join("package.json"),
        root.join("pnpm-lock.yaml"),
    ];
    if let Ok(packages) = fs::read_dir(root.join("packages")) {
        for package in packages.flatten() {
            manifests.push(package.path().join("package.json"));
        }
    }
    let mut violations = Vec::new();
    for manifest in manifests.into_iter().filter(|p| p.exists()) {
        for (line, name) in scan_lines(&read(&manifest), VISION_NPM, false) {
            violations.push(format!(
                "[S-3] {}:{line}: 画像解析・文字認識の部品 {name}",
                manifest.display()
            ));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s3_no_source_reads_pixels_or_recognizes_images() {
    let mut violations = Vec::new();
    for file in ts_sources() {
        let hits = scan_lines(&read(&file), VISION_TS, false);
        if !hits.is_empty() {
            violations.push(report("S-3 TS", &file, &hits));
        }
    }
    for file in rust_sources() {
        let hits = scan_lines(&read(&file), VISION_RUST, false);
        if !hits.is_empty() {
            violations.push(report("S-3 Rust", &file, &hits));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn s3_png_is_only_ever_encoded_never_decoded_in_product_code() {
    // 画像の読み取り（デコード）が製品のコードに無いこと。書き出しだけ。
    let mut violations = Vec::new();
    for file in rust_sources() {
        let text = read(&file);
        // テストのコードの中にある確認用のデコードは対象外。
        let product = text.split("#[cfg(test)]").next().unwrap_or("");
        let hits = scan_lines(
            product,
            &["png::Decoder", "image::open", "load_from_memory"],
            false,
        );
        if !hits.is_empty() {
            violations.push(report("S-3 デコード", &file, &hits));
        }
    }
    assert_no_violations(violations);
}

// ---- S-3: 文字認識は、取り込みの読み取りの 1 か所だけ（F11） ----

/// 文字認識のクレートを使えるのは、許した 1 つのソースだけ。依存に宣言するのも、本体のクレートだけ。
#[test]
fn s3_the_ocr_crate_is_used_from_one_import_file_and_declared_only_by_the_main_crate() {
    // どのソースが文字認識のクレートの名前を持つか。
    let mut users: Vec<String> = Vec::new();
    for file in rust_sources() {
        if read(&file).contains(OCR_RUST) {
            users.push(file.to_string_lossy().replace('\\', "/"));
        }
    }
    assert_eq!(users.len(), ALLOWED_OCR_FILES.len(), "{users:?}");
    for user in &users {
        assert!(
            ALLOWED_OCR_FILES
                .iter()
                .any(|(file, reason)| user.ends_with(file) && !reason.is_empty()),
            "許していない場所が文字認識のクレートを使っている: {user}"
        );
    }

    // 文字認識の仕事（ocr_job）を呼べるのは、取り込みのコマンドだけ（モジュールの宣言を除く）。
    let mut callers: Vec<String> = Vec::new();
    for file in rust_sources() {
        let name = file.to_string_lossy().replace('\\', "/");
        if name.ends_with("src/import/ocr_job.rs") {
            continue;
        }
        if read(&file).contains("ocr_job") {
            callers.push(name);
        }
    }
    callers.sort();
    assert_eq!(callers.len(), 2, "{callers:?}");
    assert!(
        callers[0].ends_with("src/import/commands.rs"),
        "{callers:?}"
    );
    assert!(callers[1].ends_with("src/import/mod.rs"), "{callers:?}");

    // 依存に宣言するのは、本体のクレートだけ。共有の部品（input）・補助プログラム（helper）には入れない。
    let main_toml = read(&crate_dir().join("Cargo.toml"));
    let declared: Vec<&str> = main_toml
        .lines()
        .filter(|l| l.trim_start().starts_with(&format!("{OCR_CRATE} = ")))
        .collect();
    assert_eq!(declared.len(), 1, "{declared:?}");
    for dir in [crate_dir().join("input"), crate_dir().join("helper")] {
        assert!(
            !read(&dir.join("Cargo.toml")).contains(OCR_CRATE),
            "{}: 文字認識のクレートを依存に入れている",
            dir.display()
        );
    }
}

/// 文字認識のクレートは、保存済みの画像を読んで文字にするだけ: windows の feature は決めた一覧だけ、依存は windows だけ、
/// ほかのプロセス・通信・画面の撮影・ファイルへの書き込みの語は、製品の部分に無い。
#[test]
fn s3_the_ocr_crate_reads_saved_images_and_does_nothing_else() {
    let toml = read(&ocr_dir().join("Cargo.toml"));
    let features = windows_features(&toml);
    assert!(!features.is_empty(), "feature の一覧を読めない");
    for feature in &features {
        assert!(
            OCR_WINDOWS_FEATURES
                .iter()
                .any(|(allowed, reason)| allowed == feature && !reason.is_empty()),
            "文字認識のクレートに、許していない windows の feature {feature}（足すなら、理由とともに一覧に足す）"
        );
    }
    for (allowed, _) in OCR_WINDOWS_FEATURES {
        assert!(
            features.iter().any(|f| f == allowed),
            "一覧にある feature {allowed} が、宣言に無い（一覧を実際に合わせる）"
        );
    }
    // ほかのプロセスに触れる feature（S-1 の一覧）は、画像の読み取りと文字認識のもの以外、ここにも入れない。
    for forbidden in FORBIDDEN_WINDOWS_FEATURES {
        if matches!(*forbidden, "Media_Ocr" | "Graphics_Imaging") {
            continue;
        }
        assert!(!features.iter().any(|f| f == forbidden), "{forbidden}");
    }
    // 依存は windows だけ（試験の道具は [dev-dependencies]）。
    let runtime = toml.split("[dev-dependencies]").next().unwrap();
    assert_eq!(declared_dependencies(runtime), vec!["windows"]);

    // ソースの製品の部分（試験を除く）に、禁止の語が無い。
    let capture_words = ELEVATED_FORBIDDEN
        .iter()
        .find(|(kind, _)| *kind == "画面を撮る")
        .map(|(_, words)| *words)
        .expect("画面を撮る語の一覧がある");
    let write_words: &[&str] = &[
        "fs::write",
        "File::create",
        "OpenOptions",
        "remove_file",
        "remove_dir",
        "fs::rename",
        "fs::copy",
        "create_dir",
        "WriteFile",
        "CreateDirectory",
    ];
    let files = ocr_sources();
    assert!(files.len() >= 5, "走査の対象が見つからない: {files:?}");
    let mut violations = Vec::new();
    for file in &files {
        let text = read(file);
        let product = product_part(&text);
        for (rule, hits) in [
            ("S-1 API", scan_lines(product, GAME_PROCESS_APIS, false)),
            ("S-1 フック", disallowed_hook_ids(product)),
            ("S-2 通信", scan_lines(product, NETWORK_RUST, false)),
            ("S-2 URL", scan_lines(product, URL_SCHEMES, false)),
            ("S-2 ドメイン", scan_lines(product, GAME_DOMAINS, true)),
            ("S-3 画面を撮る", scan_lines(product, capture_words, false)),
            (
                "S-3 ファイルへの書き込み",
                scan_lines(product, write_words, false),
            ),
        ] {
            if !hits.is_empty() {
                violations.push(report(rule, file, &hits));
            }
        }
    }
    assert_no_violations(violations);

    // 実行時の依存の一覧（cargo tree）は、windows の部品とその手続きマクロの部品だけ。
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "tree",
            "-p",
            OCR_CRATE,
            "-e",
            "normal",
            "--prefix",
            "none",
            "--format",
            "{p}",
            "--offline",
        ])
        .current_dir(crate_dir())
        .output()
        .expect("cargo tree を実行できる");
    assert!(
        output.status.success(),
        "cargo tree が失敗: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    let crates: Vec<&str> = text
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    assert!(crates.contains(&OCR_CRATE), "依存の一覧を読めていない");
    let unexpected: Vec<&&str> = crates
        .iter()
        .filter(|name| {
            !OCR_ALLOWED_CRATES
                .iter()
                .any(|allowed| name == &allowed || name.starts_with(&format!("{allowed}-")))
        })
        .collect();
    assert!(
        unexpected.is_empty(),
        "文字認識のクレートの実行時の依存に、許していない部品がある: {unexpected:?}"
    );
}

// ---- クリップボード: 文字を読むだけ（F1・E-15） ----

/// クリップボードの文字を読む OS ごとの実装（読み取りの口はここだけ）。
fn clipboard_reader_source() -> PathBuf {
    crate_dir()
        .join("src")
        .join("platform")
        .join("win")
        .join("clipboard.rs")
}

#[test]
fn s4_the_clipboard_is_only_read_as_text_and_only_the_import_command_reads_it() {
    let reader = read(&clipboard_reader_source());
    let product = product_part(&reader);
    // 読む口は 1 つ（文字の形式だけ）。書き込み・消去・ほかの形式（画像・ファイルの一覧・HTML など）・監視は使わない。
    assert!(product.contains("get_clipboard_string()"));
    assert!(product.contains("CF_UNICODETEXT"));
    for forbidden in [
        "set_clipboard",
        "clipboard_win::set",
        "clipboard_win::empty",
        "clipboard_win::raw",
        "formats::Bitmap",
        "formats::FileList",
        "formats::RawData",
        "formats::Html",
        "formats::Text",
        "register_format",
        "Monitor",
    ] {
        assert!(!product.contains(forbidden), "{forbidden} を使っている");
    }
    // クリップボードのクレートに触れるのは、このファイルだけ。
    let mut users: Vec<String> = Vec::new();
    // OS ごとの読み取り（`platform::read_clipboard_string`）を呼ぶのは、鍵を持つ `src/clipboard.rs` だけ。
    let mut platform_callers: Vec<String> = Vec::new();
    // 文字を読む関数を呼ぶのは、取り込みのコマンドだけ。
    let mut readers: Vec<String> = Vec::new();
    for file in rust_sources() {
        let name = file.to_string_lossy().replace('\\', "/");
        let text = read(&file);
        if text.contains("clipboard_win") {
            users.push(name.clone());
        }
        if product_part(&text).contains("platform::read_clipboard_string(") {
            platform_callers.push(name.clone());
        }
        if text.contains("clipboard::read_text") {
            readers.push(name);
        }
    }
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(users[0].ends_with("src/platform/win/clipboard.rs"));
    assert_eq!(platform_callers.len(), 1, "{platform_callers:?}");
    assert!(platform_callers[0].ends_with("src/clipboard.rs"));
    assert_eq!(readers.len(), 1, "{readers:?}");
    assert!(readers[0].ends_with("src/import/commands.rs"));
}

#[test]
fn s4_the_clipboard_is_read_one_caller_at_a_time() {
    // クリップボードを開いている状態はプロセス全体のもので、2 つのスレッドが同時に開ける。非同期のコマンドが 2 つ重なって読むと、
    // 片方のデータの取っ手が、もう片方に解放され、ヒープが壊れて落ちた（実機で 0xc0000374）。読む処理は鍵の中でだけ動かす。
    let clipboard = read(&crate_dir().join("src").join("clipboard.rs"));
    let product = product_part(&clipboard);
    assert!(
        product.contains("static READ_LOCK: Mutex<()>"),
        "プロセス全体の鍵が無い"
    );
    let exclusive = product
        .split("fn exclusive<")
        .nth(1)
        .and_then(|rest| {
            rest.split(
                "
}
",
            )
            .next()
        })
        .expect("exclusive がある");
    assert!(
        exclusive.contains("READ_LOCK.lock()"),
        "exclusive が鍵を取っていない"
    );
    let read_text = product
        .split("pub fn read_text()")
        .nth(1)
        .and_then(|rest| {
            rest.split(
                "
}
",
            )
            .next()
        })
        .expect("read_text がある");
    let lock_at = read_text
        .find("exclusive(")
        .expect("read_text が鍵の中で動かす");
    let call = "crate::platform::read_clipboard_string()";
    let at = read_text
        .find(call)
        .unwrap_or_else(|| panic!("{call} がある"));
    assert!(at > lock_at, "{call} が鍵の外にある");
    // OS ごとの読み取りを呼ぶのは、この 1 つの関数だけ。
    assert_eq!(product.matches("read_clipboard_string()").count(), 1);

    // Windows の読み取りは、クリップボードのクレートの読み取りを 1 回だけ呼ぶ。
    let reader = read(&clipboard_reader_source());
    let reader = product_part(&reader);
    assert_eq!(reader.matches("get_clipboard_string()").count(), 1);
    assert_eq!(reader.matches("is_format_avail(").count(), 1);
}

// ---- mjai の窓: 外のページにアプリの権限を与えない（F1・R3-3） ----

#[test]
fn s2_no_capability_reaches_remote_pages_or_the_mjai_window() {
    let files = files_under(&crate_dir().join("capabilities"), &|p| {
        has_ext(p, &["json"])
    });
    assert!(!files.is_empty());
    for file in files {
        let text = read(&file);
        let json: serde_json::Value = serde_json::from_str(&text).expect("capability は JSON");
        // 外のオリジンに権限を与える `remote` が無い。
        assert!(
            json.get("remote").is_none(),
            "{}: 外のページに権限を与えている",
            file.display()
        );
        // 権限を与える窓は、アプリ自身の 2 つだけ（mjai の窓・すべての窓を表す印は入れない）。
        let windows: Vec<&str> = json["windows"]
            .as_array()
            .expect("windows は配列")
            .iter()
            .filter_map(|w| w.as_str())
            .collect();
        assert!(!windows.is_empty());
        for window in windows {
            assert!(
                window == "main" || window == "widget",
                "{}: 権限を与える窓が多すぎる: {window}",
                file.display()
            );
        }
        assert!(json.get("webviews").is_none(), "{}", file.display());
        assert!(!text.contains("mjai"), "{}", file.display());
    }
    // 設定ファイルと Rust のソースで、外のオリジンからの呼び出しを許す設定をしていない。
    let conf = read(&crate_dir().join("tauri.conf.json"));
    assert!(!conf.contains("dangerousRemoteDomainIpcAccess"));
    for file in rust_sources() {
        let text = read(&file);
        assert!(
            !text.contains("dangerous_remote_domain_ipc_access"),
            "{}",
            file.display()
        );
    }
}

/// mjai の窓に評価させる JavaScript（`src/import/*.js`）。ページの中で動くので、通信・送信・移動・新しい窓には触れてはいけない。
/// 送信（Submit）は、ユーザー自身が押す（SPEC 2 章。Cloudflare の確認もある）。
#[test]
fn s2_the_scripts_given_to_the_mjai_window_never_reach_the_network_or_submit() {
    let files = files_under(&crate_dir().join("src").join("import"), &|p| {
        has_ext(p, &["js"])
    });
    let names: Vec<String> = files
        .iter()
        .filter_map(|f| f.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    assert_eq!(names, vec!["mjai_native.js", "prefill.js"], "{names:?}");
    // 送信・移動・新しい窓・書き換えの語（コメントの行は、説明の文なので数えない）。
    let submit_words: &[&str] = &[
        ".click(",
        ".submit(",
        "requestSubmit",
        "dispatchEvent(new MouseEvent",
        "location",
        "window.open",
        "document.forms",
        "innerHTML",
        "document.write",
        "eval(",
        "Function(",
        "import(",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "cookie",
        "postMessage",
    ];
    let mut violations = Vec::new();
    for file in &files {
        let code: String = read(file)
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for (rule, patterns) in [
            ("S-2 通信", NETWORK_TS),
            ("S-2 URL", URL_SCHEMES),
            ("S-2 送信・移動", submit_words),
        ] {
            let hits = scan_lines(&code, patterns, false);
            if !hits.is_empty() {
                violations.push(report(rule, file, &hits));
            }
        }
        // 雀魂のドメインも書かない。
        let hits = scan_lines(&code, GAME_DOMAINS, true);
        if !hits.is_empty() {
            violations.push(report("S-2 ドメイン", file, &hits));
        }
    }
    assert_no_violations(violations);

    // URL 欄に入れるスクリプトは、入れる欄を 1 つだけ決め打ちし、出すイベントは input と change の 2 つだけ。
    let prefill = read(&crate_dir().join("src").join("import").join("prefill.js"));
    let code: String = prefill
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        code.matches("input[name=\"log-url\"]").count(),
        1,
        "欄の指定は 1 か所"
    );
    assert_eq!(code.matches("dispatchEvent(").count(), 2);
    assert!(code.contains("new Event('input'") && code.contains("new Event('change'"));
}

// ---- S-4: ウィジェットは保存と追記しかしない ----

#[test]
fn s4_the_widget_code_imports_only_the_recording_api() {
    let widget_dir = repo_root()
        .join("apps")
        .join("desktop")
        .join("src")
        .join("widget");
    let files = files_under(&widget_dir, &|p| {
        has_ext(p, &["ts", "tsx"]) && !is_test_file(p)
    });
    assert!(!files.is_empty(), "ウィジェットのソースが見つからない");
    let mut violations = Vec::new();
    for file in files {
        for spec in import_specifiers(&read(&file)) {
            let relative = spec.starts_with("./") || spec.starts_with("../");
            let font = WIDGET_ALLOWED_IMPORT_PREFIXES
                .iter()
                .any(|prefix| spec.starts_with(prefix));
            if relative || font || WIDGET_ALLOWED_IMPORTS.contains(&spec.as_str()) {
                continue;
            }
            violations.push(format!(
                "[S-4] {}: ウィジェットが読み込んではいけないもの: {spec}",
                file.display()
            ));
        }
    }
    assert_no_violations(violations);
}

/// 画面（webview）が、窓の API（`@tauri-apps/api/window`）を呼んでよいのは、迷いだけのウィジェットを押したまま動かしたときに、窓を動かし始める
/// 1 か所だけ（F0、W-15）。入口は `api/tauri.ts` の `startWindowDrag` で、ウィジェットのコードは、そこ（相対の import）を通して呼ぶ。
/// 許している操作は `capabilities/widget.json` の `core:window:allow-start-dragging` だけ（下の試験が、ほかを許していないことを確かめる）。
#[test]
fn s4_the_only_window_api_the_screens_call_is_start_dragging_from_one_place() {
    let src = repo_root().join("apps").join("desktop").join("src");
    let files = files_under(&src, &|p| has_ext(p, &["ts", "tsx"]) && !is_test_file(p));
    assert!(!files.is_empty(), "画面のソースが見つからない");
    let users: Vec<String> = files
        .iter()
        .filter(|file| {
            import_specifiers(&read(file))
                .iter()
                .any(|spec| spec == "@tauri-apps/api/window")
        })
        .map(|file| file.to_string_lossy().replace('\\', "/"))
        .collect();
    assert_eq!(users.len(), 1, "窓の API を読み込む場所: {users:?}");
    assert!(users[0].ends_with("src/api/tauri.ts"), "{users:?}");
    // その場所でも、窓に対して呼ぶのは startDragging だけ（窓の大きさ・位置・閉じる・隠すなどは、Rust 側の仕事）
    let text = read(&PathBuf::from(&users[0]));
    assert_eq!(text.matches("getCurrentWindow()").count(), 1, "{users:?}");
    assert!(text.contains("getCurrentWindow().startDragging()"));
    // 許している権限は、窓をつかんで動かすことだけ
    let capability = read(&crate_dir().join("capabilities").join("widget.json"));
    assert!(capability.contains("core:window:allow-start-dragging"));
    for forbidden in [
        "allow-close",
        "allow-hide",
        "allow-set-size",
        "allow-set-position",
        "allow-destroy",
        "core:window:default",
    ] {
        assert!(
            !capability.contains(forbidden),
            "ウィジェットに許している操作が多すぎる: {forbidden}"
        );
    }
}

#[test]
fn s4_the_widget_window_has_no_file_dialog_or_plugin_permission() {
    let capability = read(&crate_dir().join("capabilities").join("widget.json"));
    let json: serde_json::Value = serde_json::from_str(&capability).expect("capability は JSON");
    let permissions: Vec<&str> = json["permissions"]
        .as_array()
        .expect("permissions は配列")
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    for permission in &permissions {
        assert!(
            permission.starts_with("core:event:")
                || *permission == "core:window:allow-start-dragging",
            "ウィジェットに許している操作が多すぎる: {permission}"
        );
    }
    assert!(!permissions.is_empty());
}

// ---- W-9: 管理者で動く補助プログラム ----
//
// 補助プログラムは、管理者の権限で動く。そのため、「ボタンを拾って本体に知らせる」以外のことをする部品を、
// ソースにも依存にも入れない。ファイルの読み書き・ほかのプログラムを動かす・画面を撮る・文字認識・通信（S-2 の走査が見る）。
// 例外は、設定と解除のための 1 ファイル（helper/src/install.rs）だけ。ファイルを写す・消す・書く、schtasks.exe を動かす。
// そのファイルにも、フック・パイプ・画面・文字認識の部品は入れない。

/// 補助プログラムのうち、管理者の権限で「ボタンを拾って知らせる」部分に入れないもの（種類ごとの語）。
const ELEVATED_FORBIDDEN: &[(&str, &[&str])] = &[
    (
        "ファイルを扱う",
        &[
            "std::fs",
            "fs::",
            "File::",
            "OpenOptions",
            "tempfile",
            "WriteFileEx",
            "CopyFile",
            "MoveFile",
            "DeleteFile",
            "CreateDirectory",
            "RemoveDirectory",
            "SetEndOfFile",
            "SetFilePointer",
            "NtWriteFile",
        ],
    ),
    (
        "ほかのプログラムを動かす",
        &[
            "std::process::Command",
            "std::process::Stdio",
            "std::process::Child",
            "Command::new",
            "ShellExecute",
            "CreateProcess",
            "WinExec",
        ],
    ),
    (
        "画面を撮る",
        &[
            "BitBlt",
            "StretchBlt",
            "MaskBlt",
            "PlgBlt",
            "GetDC",
            "GetWindowDC",
            "CreateCompatibleDC",
            "CreateCompatibleBitmap",
            "GetDIBits",
            "GetPixel",
            "PrintWindow",
            "Graphics_Gdi",
            "Graphics_Dxgi",
            "Graphics_Direct3D",
            "Graphics_Capture",
            "DuplicateOutput",
            "IDXGI",
            "Windows.Graphics.Capture",
        ],
    ),
    (
        "文字認識・画像の解析",
        &[
            "Media_Ocr",
            "OcrEngine",
            "Windows.Media.Ocr",
            "tesseract",
            "png::",
            "image::",
        ],
    ),
];

/// 設定と解除の 1 ファイルにも入れないもの（フック・パイプ・画面・文字認識）と、ファイルのうち危ない操作。
const INSTALL_FORBIDDEN: &[&str] = &[
    "SetWindowsHookEx",
    "hook_win",
    "pipe_win",
    "CreateNamedPipe",
    "CreateFileW",
    "BitBlt",
    "GetDC",
    "GetDIBits",
    "Media_Ocr",
    "OcrEngine",
    "png::",
    "image::",
    "remove_dir_all",
    "OpenOptions",
    "File::",
    "fs::read",
    "read_to_string",
];

/// 共有の部品（input）が使ってよい windows の feature。フック・パイプ・自分のトークンの読み取りに要るものだけ。
const INPUT_WINDOWS_FEATURES: &[&str] = &[
    "Win32_Foundation",
    "Win32_Security",
    "Win32_Security_Authorization",
    "Win32_Storage_FileSystem",
    "Win32_System_IO",
    "Win32_System_LibraryLoader",
    "Win32_System_Pipes",
    "Win32_System_Threading",
    "Win32_UI_Input_KeyboardAndMouse",
    "Win32_UI_WindowsAndMessaging",
];

/// 補助プログラム本体（helper）が使ってよい windows の feature。設定と解除のための、フォルダとシステムの場所の問い合わせだけ。
const HELPER_WINDOWS_FEATURES: &[&str] = &[
    "Win32_Foundation",
    "Win32_System_Com",
    "Win32_System_SystemInformation",
    "Win32_UI_Shell",
];

/// 補助プログラムの実行時の依存（`cargo tree -e normal`）に入ってよい部品。
/// serde（連絡の JSON）と windows クレートの一式だけ。足すときは、ここに理由つきで足す。
const HELPER_ALLOWED_CRATES: &[&str] = &[
    "jantama-helper",
    "jantama-input",
    // 連絡の JSON（serde とその周り）
    "serde",
    "serde_core",
    "serde_derive",
    "serde_json",
    "itoa",
    "memchr",
    "zmij",
    "proc-macro2",
    "quote",
    "syn",
    "unicode-ident",
];

/// `windows` で始まる部品（windows・windows-core・windows-link など）は、Windows の API の窓口。
const HELPER_ALLOWED_CRATE_PREFIX: &str = "windows";

/// 管理者の権限で動く部分のソース: 共有の部品（input）の全部と、補助プログラム（helper）のうち設定と解除の 1 ファイル以外。
fn elevated_runtime_sources() -> Vec<PathBuf> {
    let mut files = files_under(&crate_dir().join("input").join("src"), &|p| {
        has_ext(p, &["rs"])
    });
    files.extend(files_under(&crate_dir().join("helper").join("src"), &|p| {
        has_ext(p, &["rs"]) && !is_install_file(p)
    }));
    files.sort();
    files
}

fn is_install_file(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('\\', "/")
        .ends_with("helper/src/install.rs")
}

fn install_source() -> PathBuf {
    crate_dir().join("helper").join("src").join("install.rs")
}

/// ファイルの製品の部分（`#[cfg(test)]` より前）。試験の道具は、製品ではない。
/// 試験だけのファイル（先頭近くに、内側の属性 `#![cfg(test)]` がある）は、製品の部分が無い。
fn product_part(text: &str) -> &str {
    if text.lines().any(|line| line.trim() == "#![cfg(test)]") {
        return "";
    }
    text.split("#[cfg(test)]").next().unwrap_or("")
}

/// `windows = { ... features = [ "..." ] }` の feature の一覧。
fn windows_features(toml: &str) -> Vec<String> {
    let Some(start) = toml.find("windows = {") else {
        return Vec::new();
    };
    let block = &toml[start..];
    let Some(features_at) = block.find("features = [") else {
        return Vec::new();
    };
    let list = &block[features_at..];
    let end = list.find(']').unwrap_or(list.len());
    list[..end]
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

/// `[... dependencies]` の表で宣言されている部品の名前。
fn declared_dependencies(toml: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_dependencies = false;
    for line in toml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_dependencies = trimmed.ends_with("dependencies]");
            continue;
        }
        if !in_dependencies || trimmed.starts_with('#') {
            continue;
        }
        if let Some((name, _)) = trimmed.split_once(" = ") {
            let name = name.trim();
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                names.push(name.to_string());
            }
        }
    }
    names
}

#[test]
fn w9_the_scanner_detects_every_forbidden_word_of_the_elevated_runtime() {
    for (kind, patterns) in ELEVATED_FORBIDDEN {
        for pattern in *patterns {
            let sample = format!("let x = {pattern}example;");
            assert_eq!(
                scan_lines(&sample, &[pattern], false).len(),
                1,
                "{kind}: {pattern} を検出できない"
            );
        }
    }
    for pattern in INSTALL_FORBIDDEN {
        let sample = format!("let x = {pattern}example;");
        assert_eq!(
            scan_lines(&sample, &[pattern], false).len(),
            1,
            "設定と解除: {pattern} を検出できない"
        );
    }
    // 試験の道具は、製品の部分に入らない。
    assert_eq!(
        product_part("a\nb\n#[cfg(test)]\nmod tests { fs::x }"),
        "a\nb\n"
    );
}

#[test]
fn w9_the_elevated_runtime_has_no_file_process_capture_or_ocr_code() {
    let files = elevated_runtime_sources();
    assert!(files.len() >= 8, "走査の対象が見つからない: {files:?}");
    let mut violations = Vec::new();
    for file in &files {
        let text = read(file);
        for (kind, patterns) in ELEVATED_FORBIDDEN {
            let hits = scan_lines(product_part(&text), patterns, false);
            if !hits.is_empty() {
                violations.push(report(&format!("W-9 {kind}"), file, &hits));
            }
        }
    }
    assert_no_violations(violations);
}

#[test]
fn w9_only_the_pipe_module_opens_files_and_it_only_opens_named_pipes() {
    let pipe_module = crate_dir().join("input").join("src").join("pipe_win.rs");
    let mut violations = Vec::new();
    for file in elevated_runtime_sources() {
        if file == pipe_module {
            continue;
        }
        let text = read(&file);
        let hits = scan_lines(
            product_part(&text),
            &["CreateFileW", "ReadFile", "WriteFile", "CreateNamedPipe"],
            false,
        );
        if !hits.is_empty() {
            violations.push(report("W-9 ファイルを開く API", &file, &hits));
        }
    }
    assert_no_violations(violations);

    // パイプの部品は、名前付きパイプの名前でなければ、開く前に断る。
    let text = read(&pipe_module);
    let product = product_part(&text);
    let connect = product
        .split("pub fn connect(")
        .nth(1)
        .and_then(|rest| rest.split("\n    }\n").next())
        .expect("connect がある");
    let guard = connect
        .find("starts_with(PIPE_NAME_PREFIX)")
        .expect("名前付きパイプの名前かを確かめている");
    let open = connect.find("CreateFileW(").expect("パイプを開く");
    assert!(guard < open, "開く前に、名前付きパイプの名前かを確かめる");
    assert_eq!(
        product.matches("CreateFileW(").count(),
        1,
        "ファイルを開く呼び出しは 1 か所だけ"
    );
}

#[test]
fn w9_the_install_file_is_the_only_one_that_touches_files_and_it_does_nothing_else() {
    let text = read(&install_source());
    let product = product_part(&text);
    let hits = scan_lines(product, INSTALL_FORBIDDEN, false);
    assert!(
        hits.is_empty(),
        "{}",
        report("W-9 設定と解除", &install_source(), &hits)
    );
    // 動かすほかのプログラムは、Windows に尋ねたシステムのフォルダの schtasks.exe の 1 つだけ。
    assert_eq!(product.matches("Command::new(").count(), 1);
    assert!(product.contains("Command::new(system.join(\"schtasks.exe\"))"));
    // 書き込みは、タスクの定義を置く 1 か所だけ。
    assert_eq!(product.matches("fs::write(").count(), 1);
    // 管理者の権限で動いていることを確かめてから、何かする。
    for entry in ["pub fn install(", "pub fn uninstall("] {
        let body = product.split(entry).nth(1).expect("入口がある");
        let check = body.find("is_elevated()").expect("権限を確かめている");
        let first_change = ["fs::", "schtasks("]
            .iter()
            .filter_map(|word| body.find(word))
            .min()
            .expect("何かする");
        assert!(check < first_change, "{entry} は、権限を確かめてから動く");
    }
}

#[test]
fn w9_the_install_code_is_reachable_only_through_the_install_and_uninstall_commands() {
    let text = read(&crate_dir().join("helper").join("src").join("main.rs"));
    let product = product_part(&text);
    let uses: Vec<&str> = product
        .lines()
        .filter(|line| line.contains("install::"))
        .collect();
    assert_eq!(uses.len(), 2, "{uses:?}");
    for line in uses {
        assert!(
            line.contains("\"install\"") || line.contains("\"uninstall\""),
            "{line}"
        );
    }
    // 「run」（確認なしのタスクが動かすもの）の入口は、設定と解除のコードを呼ばない。
    let run = read(&crate_dir().join("helper").join("src").join("run.rs"));
    assert!(!product_part(&run).contains("install"));
}

#[test]
fn w9_the_helper_and_the_shared_crate_declare_only_the_expected_dependencies() {
    let input = declared_dependencies(&read(&crate_dir().join("input").join("Cargo.toml")));
    let mut sorted = input.clone();
    sorted.sort();
    assert_eq!(sorted, vec!["serde", "serde_json", "windows"]);

    let helper = declared_dependencies(&read(&crate_dir().join("helper").join("Cargo.toml")));
    let mut sorted = helper.clone();
    sorted.sort();
    // tempfile は、試験だけの道具（[dev-dependencies]）。
    assert_eq!(sorted, vec!["jantama-input", "tempfile", "windows"]);
    let helper_toml = read(&crate_dir().join("helper").join("Cargo.toml"));
    let runtime = helper_toml.split("[dev-dependencies]").next().unwrap();
    assert!(!runtime.contains("tempfile"));
}

#[test]
fn w9_the_windows_features_of_the_elevated_crates_are_a_short_fixed_list() {
    for (dir, allowed) in [
        ("input", INPUT_WINDOWS_FEATURES),
        ("helper", HELPER_WINDOWS_FEATURES),
    ] {
        let toml = read(&crate_dir().join(dir).join("Cargo.toml"));
        let features = windows_features(&toml);
        assert!(!features.is_empty(), "{dir}: feature の一覧を読めない");
        for feature in &features {
            assert!(
                allowed.contains(&feature.as_str()),
                "{dir}: 許していない windows の feature {feature}（足すなら、理由とともに一覧に足す）"
            );
        }
    }
}

#[test]
fn w9_the_helper_runtime_dependency_graph_is_tiny() {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "tree",
            "-p",
            "jantama-helper",
            "-e",
            "normal",
            "--prefix",
            "none",
            "--format",
            "{p}",
            "--offline",
        ])
        .current_dir(crate_dir())
        .output()
        .expect("cargo tree を実行できる");
    assert!(
        output.status.success(),
        "cargo tree が失敗: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    let crates: Vec<String> = text
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect();
    assert!(
        crates.iter().any(|c| c == "jantama-input"),
        "依存の一覧を読めていない"
    );
    let unexpected: Vec<&String> = crates
        .iter()
        .filter(|name| {
            !HELPER_ALLOWED_CRATES.contains(&name.as_str())
                && !name.starts_with(HELPER_ALLOWED_CRATE_PREFIX)
        })
        .collect();
    assert!(
        unexpected.is_empty(),
        "補助プログラムの実行時の依存に、許していない部品がある: {unexpected:?}"
    );
    // Tauri・WebView・画像・通信の部品は、補助プログラムには入らない。
    for banned in ["tauri", "wry", "png", "image", "url", "reqwest", "hyper"] {
        assert!(
            !crates.iter().any(|c| c == banned),
            "{banned} が補助プログラムに入っている"
        );
    }
}

#[test]
fn w9_the_helper_is_built_without_a_console_and_every_scan_covers_its_sources() {
    // 窓もコンソールも出さない（管理者の権限で、見えない所で動く。結果は終了コードで返す）。
    let text = read(&crate_dir().join("helper").join("src").join("main.rs"));
    assert!(text.contains("#![cfg_attr(windows, windows_subsystem = \"windows\")]"));
    // S-1（他のプロセス）・S-2（通信）・S-3（画面の解析）の走査は、補助プログラムと共有の部品のソースも見る。
    let scanned: Vec<String> = rust_sources()
        .iter()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    for needed in [
        "helper/src/main.rs",
        "helper/src/run.rs",
        "helper/src/install.rs",
        "input/src/hook_win.rs",
        "input/src/pipe_win.rs",
        "input/src/logic.rs",
        "src/commands.rs",
    ] {
        assert!(
            scanned.iter().any(|p| p.ends_with(needed)),
            "{needed} が走査の対象に入っていない"
        );
    }
}

// ---- U-9: 消した半荘は、ごみ箱へ送る。ごみ箱の口は 1 か所で、送る相手は置き場（trash）の中だけ ----

/// 本物のごみ箱へ送る Windows の API。
const RECYCLE_API: &str = "SHFileOperationW";

/// 製品のソース（試験を除く）のうち、`needle` を含むファイルの（`src` からの）名前。
fn product_files_containing(needle: &str) -> Vec<String> {
    let mut found: Vec<String> = rust_sources()
        .iter()
        .filter(|file| product_part(&read(file)).contains(needle))
        .map(|file| file.to_string_lossy().replace('\\', "/"))
        .collect();
    found.sort();
    found
}

#[test]
fn u9_the_recycle_bin_api_is_called_from_one_place_and_with_the_undo_flag() {
    let users = product_files_containing(RECYCLE_API);
    assert_eq!(
        users.len(),
        1,
        "ごみ箱の API を呼ぶファイルが 1 つではない: {users:?}"
    );
    assert!(users[0].ends_with("src/platform/win/trash.rs"), "{users:?}");

    let trash = read(
        &crate_dir()
            .join("src")
            .join("platform")
            .join("win")
            .join("trash.rs"),
    );
    let product = product_part(&trash);
    assert_eq!(
        product.matches(&format!("{RECYCLE_API}(&mut op)")).count(),
        1,
        "呼ぶのは 1 回だけ"
    );
    // 削除（FO_DELETE）を、元に戻せる形（FOF_ALLOWUNDO）で、確認も窓も出さずに頼む。
    for needed in [
        "wFunc: FO_DELETE",
        "FOF_ALLOWUNDO",
        "FOF_NOCONFIRMATION",
        "FOF_SILENT",
        "FOF_NOERRORUI",
    ] {
        assert!(product.contains(needed), "{needed} が無い");
    }
    // ごみ箱を使わずに消してしまう頼み方（旗が足りない・別の関数）を入れない。
    for banned in [
        "FO_MOVE",
        "FO_COPY",
        "FO_RENAME",
        "DeleteFile",
        "RemoveDirectory",
    ] {
        assert!(!product.contains(banned), "{banned} がある");
    }
}

#[test]
fn u9_the_real_recycler_is_made_in_one_function_and_nothing_deletes_folders_in_place() {
    // 本物のごみ箱の道具は、OS ごとの実装の 1 つのファイルの 1 つの関数（`platform::recycler`）だけが作る。
    let makers = product_files_containing("WindowsRecycler");
    assert_eq!(makers.len(), 1, "{makers:?}");
    assert!(
        makers[0].ends_with("src/platform/win/trash.rs"),
        "{makers:?}"
    );
    let windows_trash = read(&PathBuf::from(&makers[0]));
    assert_eq!(
        product_part(&windows_trash)
            .matches("Box::new(WindowsRecycler)")
            .count(),
        1,
        "recycler の 1 か所だけ"
    );
    // その関数を呼ぶのは、置き場を片づける 1 つの関数（recycle_pending）だけ。
    let callers = product_files_containing("platform::recycler(");
    assert_eq!(callers.len(), 1, "{callers:?}");
    assert!(callers[0].ends_with("src/trash.rs"), "{callers:?}");
    let trash = read(&crate_dir().join("src").join("trash.rs"));
    assert_eq!(
        product_part(&trash)
            .matches("crate::platform::recycler()")
            .count(),
        1,
        "recycle_pending の 1 か所だけ"
    );

    // フォルダを、ごみ箱を通さずに、中身ごと消すコードが、製品に無い。例外は 1 つ: 「この端末の同期を切る」が、設定のフォルダの下の
    // 同期の作業のフォルダ（同期用の DB の手元の写しと、前回の記録。利用者の記録ではない）を消すところ。保存先には触れない。
    let recursive = product_files_containing("remove_dir_all");
    assert_eq!(
        recursive.len(),
        1,
        "remove_dir_all を使っている: {recursive:?}"
    );
    assert!(
        recursive[0].ends_with("src/sync/service.rs"),
        "{recursive:?}"
    );
    let service = read(&PathBuf::from(&recursive[0]));
    let product = product_part(&service);
    assert_eq!(product.matches("remove_dir_all").count(), 1);
    assert!(
        product.contains("let root = sync_root(&self.config_dir);")
            && product.contains("std::fs::remove_dir_all(&root)"),
        "同期の作業のフォルダだけを消す"
    );
}

#[test]
fn u9_the_trash_is_emptied_when_the_app_exits_when_it_starts_and_when_the_data_dir_changes() {
    let lib = read(&crate_dir().join("src").join("lib.rs"));
    let lib = product_part(&lib);
    // 閉じるとき（RunEvent::Exit）。
    assert!(
        lib.contains("tauri::RunEvent::Exit"),
        "終了の知らせを受けていない"
    );
    assert!(lib.contains("recycle_deleted_sessions(app)"));
    // 起動のとき（落ちたあとの片づけ）。置き場を片づけてから、記録の担当を作る前ではなく、設定を読んだあと。
    let setup_at = lib.find("fn setup(").expect("setup がある");
    let load_at = lib[setup_at..].find("Core::load(").expect("設定を読む");
    let startup_at = lib[setup_at..]
        .find("trash::recycle_pending(&settings.data_dir)")
        .expect("起動のときに、置き場を片づけている");
    assert!(startup_at > load_at, "設定を読んだあとに片づける");
    // 保存先を変えたとき（前の保存先の置き場）。
    let commands = read(&crate_dir().join("src").join("commands.rs"));
    assert!(product_part(&commands).contains("trash::recycle_pending(&previous_data_dir)"));
    // ほかの場所からは呼ばない。
    let callers = product_files_containing("recycle_pending(");
    let names: Vec<&str> = callers
        .iter()
        .map(|p| p.rsplit("src/").next().unwrap_or(p))
        .collect();
    assert_eq!(
        names,
        vec!["commands.rs", "lib.rs", "trash.rs"],
        "{callers:?}"
    );
}

// ---- D-3: 答え・解き直しの予定・今日の出題の SQLite は、検討画面だけが使う ----

/// SQLite の部品（rusqlite）の名前。
const STUDY_DB_RUST: &str = "rusqlite";

/// 答えの記録の Tauri コマンド（Rust の名前と、画面側の窓口の名前）。ウィジェットのコードは、どれにも触れない。
const STUDY_COMMANDS: &[&str] = &[
    "record_answer",
    "update_answer_notes",
    "list_answers",
    "get_daily_set",
    "save_daily_set",
    "count_solved",
    "list_weeks",
    "set_week",
    "records_overview",
    "export_records",
    "inspect_records_file",
    "import_records",
];
const STUDY_API_NAMES: &[&str] = &[
    "recordAnswer",
    "updateAnswerNotes",
    "listAnswers",
    "getDailySet",
    "saveDailySet",
    "countSolved",
    "listWeeks",
    "setWeek",
    "recordsOverview",
    "exportRecords",
    "inspectRecordsFile",
    "importRecords",
];

#[test]
fn d3_the_study_database_is_used_only_by_the_study_module_in_the_main_crate() {
    // SQLite の部品を名前に持つソースは、`src/study/` の中だけ（ウィジェット・ボタンを拾う部分・補助プログラム・撮影・記録には入れない）。
    let users = product_files_containing(STUDY_DB_RUST);
    assert!(!users.is_empty(), "答えのファイルの部品が使われていない");
    for user in &users {
        assert!(
            user.contains("src/study/"),
            "{user} が SQLite の部品を使っている"
        );
    }
    // Cargo.toml で宣言しているのは、本体のクレートだけ。SQLite 本体は同梱する（OS の部品を読み込まない）。
    for dir in [
        crate_dir().join("input"),
        crate_dir().join("helper"),
        ocr_dir(),
    ] {
        let toml = read(&dir.join("Cargo.toml"));
        assert!(
            forbidden_crates_in_manifest(&toml, &[STUDY_DB_RUST]).is_empty(),
            "{} が SQLite の部品を宣言している",
            dir.display()
        );
    }
    let main_toml = read(&crate_dir().join("Cargo.toml"));
    let declared: Vec<&str> = main_toml
        .lines()
        .filter(|l| l.trim_start().starts_with(&format!("{STUDY_DB_RUST} = ")))
        .collect();
    assert_eq!(declared.len(), 1, "{declared:?}");
    assert!(
        declared[0].contains("\"bundled\""),
        "SQLite は同梱にする: {}",
        declared[0]
    );

    // 答えのファイルを扱う `study` の名前を使うのは、登録（lib.rs）・置き場の片づけ（trash.rs）・記録の同期（F15。答えを読み書きする
    // 2 つのファイル: 手元の記録の読み書き `sync/local.rs` と、アプリのつなぎ `sync/commands.rs`）・study 自身だけ。
    let mut referers: Vec<String> = Vec::new();
    for file in rust_sources() {
        let name = file.to_string_lossy().replace('\\', "/");
        if name.contains("src/study/") {
            continue;
        }
        let text = read(&file);
        if product_part(&text).contains("study::") || product_part(&text).contains("StudyDb") {
            referers.push(name.rsplit("src/").next().unwrap_or(&name).to_string());
        }
    }
    referers.sort();
    assert_eq!(
        referers,
        vec!["lib.rs", "sync/commands.rs", "sync/local.rs", "trash.rs"],
        "{referers:?}"
    );
}

#[test]
fn d3_every_study_command_refuses_calls_from_other_windows_and_the_widget_never_names_them() {
    let commands = read(&crate_dir().join("src").join("study").join("commands.rs"));
    let product = product_part(&commands);
    let declared = product.matches("#[tauri::command]").count();
    assert_eq!(
        declared,
        STUDY_COMMANDS.len(),
        "コマンドの数が、一覧と合わない"
    );
    // どのコマンドも、検討画面（main）の窓から呼ばれたかを、最初に確かめる。
    assert_eq!(product.matches("ensure_main(&window)?;").count(), declared);
    assert!(product.contains("window.label() == MAIN_LABEL"));
    for name in STUDY_COMMANDS {
        assert!(
            product.contains(&format!("pub async fn {name}(")),
            "{name} がある"
        );
    }
    // ウィジェットの画面のソースは、答えの記録の窓口の名前に触れない。
    let widget_dir = repo_root()
        .join("apps")
        .join("desktop")
        .join("src")
        .join("widget");
    for file in files_under(&widget_dir, &|p| {
        has_ext(p, &["ts", "tsx"]) && !is_test_file(p)
    }) {
        let text = read(&file);
        for name in STUDY_COMMANDS.iter().chain(STUDY_API_NAMES) {
            assert!(
                !text.contains(name),
                "{}: ウィジェットが答えの記録の窓口 {name} に触れている",
                file.display()
            );
        }
    }
    // 権限の一覧（capabilities）に、答えの記録の窓口を、ウィジェットに足していない。
    let widget_cap = read(&crate_dir().join("capabilities").join("widget.json"));
    for name in STUDY_COMMANDS {
        assert!(!widget_cap.contains(name), "{name} が widget.json にある");
    }
}

// ---- macOS: 規約の線引き（macOS 対応の段階 1。analysis/mac/README.md 4 章） ----
//
// macOS の部分で、画面・入力・ゲーム・ほかのアプリに触れる API は、まだ 1 つも呼んでいない（`src/platform/mac/mod.rs`、`ocr/src/mac.rs` は雛形）。
// 段階 2 で動くのは、クリップボードの文字の読み取りとごみ箱への移し替え（このファイルの終わりの検査）だけ。
// 段階 3 以降で作るときに、SPEC 2章の線（対局中に動くのは、押された瞬間の画面 1 枚の保存と記録の追記だけ）を越えさせないため、
// 禁止の一覧を先に機械の関門にする。語の書き方: `*` で終わるものは前方一致（`AXUIElement*` は `AXUIElementCopyAttributeValue` などにも
// 当たる）、そうでないものは、その語そのもの（`SCStream` は `SCStreamConfiguration` に当たらない。静止画 1 枚の撮影にも
// `SCStreamConfiguration` は要るため）。製品のソースの試験の部分（`#[cfg(test)]` 以降）や、`tests/` の結合試験は見ない
// （入力の送信は、試験だけに許す）。

/// macOS の API のうち、製品のコードで使わないもの（種類ごとの語）。
const MAC_FORBIDDEN: &[(&str, &[&str])] = &[
    (
        "画面を続けて取り続ける・録る",
        &[
            "SCStream",
            "SCStreamOutput*",
            "SCStreamDelegate*",
            "SCRecordingOutput*",
            "SCContentSharingPicker*",
            "CGDisplayStream*",
            "AVCaptureScreenInput*",
            "AVCaptureSession*",
        ],
    ),
    (
        "撮影の古い道（撮影は、静止画 1 枚の ScreenCaptureKit の 1 か所に閉じる）",
        &["CGWindowListCreateImage*", "CGDisplayCreateImage*"],
    ),
    (
        "ほかのアプリの画面の要素・文字を読む（許可の確認 AXIsProcessTrusted は使ってよい）",
        &["AXUIElement*", "AXObserver*"],
    ),
    (
        "入力を送る（試験だけに許す）",
        &["CGEventPost*", "CGEventTapPostEvent*", "IOHIDPostEvent*"],
    ),
    (
        "ほかのプロセスの読み書き・差し込み",
        &[
            "task_for_pid",
            "mach_vm_*",
            "vm_read*",
            "vm_write*",
            "ptrace",
            "DYLD_INSERT_LIBRARIES",
        ],
    ),
    (
        "外部プロセスでの撮影",
        &["\"screencapture\"", "/usr/sbin/screencapture"],
    ),
    ("デバッグ用の権限", &["get-task-allow"]),
];

/// 署名・権限の設定ファイル（plist・entitlements・JSON・TOML など）に書かない語。配布する作りに、ほかのプロセスから付けられる権限や、
/// 環境変数での差し込みを許す権限を入れない。
const MAC_FORBIDDEN_CONFIG: &[&str] = &[
    "get-task-allow",
    "com.apple.security.cs.debugger",
    "com.apple.security.cs.allow-dyld-environment-variables",
];

/// 決めた 1 か所のソースだけが使ってよい macOS の API（語、使ってよいソース（理由つき））。
/// 使ってよいソースの一覧は、実際にその語を使っているソースと一致させる（足りなくても、余っていても失敗する）。
/// 段階 1 では macOS の実装を作っていないので、どれも空。作るときに、そのソースを理由つきで足す。
const MAC_ONE_PLACE: &[OnePlace] = &[
    // 静止画 1 枚の撮影（M-3）。呼び出し元は、ボタンが押された瞬間の処理だけにする。
    OnePlace {
        kind: "静止画 1 枚の撮影",
        words: &["SCScreenshotManager*"],
        allowed: &[],
    },
    // ボタンを拾う入力のタップ。必要な種類のイベントだけを見て、内容はディスクに残さない。
    OnePlace {
        kind: "入力のタップ",
        words: &["CGEventTap*"],
        allowed: &[],
    },
];

/// 決めた 1 か所のソースだけが使ってよい macOS の API。
struct OnePlace {
    kind: &'static str,
    /// 語（書き方は上の説明のとおり）。
    words: &'static [&'static str],
    /// 使ってよいソース（`src-tauri` からの相対パスの末尾）と、その理由。
    allowed: &'static [(&'static str, &'static str)],
}

/// 宣言してよいクレートを 1 つのクレートに限る macOS の部品（クレート名、宣言してよいクレートのフォルダ（`src-tauri` からの相対。本体は `.`）、理由）。
/// 段階 3・4 で足すときは、宣言する側のクレートと理由を決めてから、使う。
const MAC_GATED_CRATES: &[(&str, &str, &str)] = &[
    (
        "objc2-screen-capture-kit",
        ".",
        "M-3: 静止画 1 枚の撮影。撮影のモジュール（本体のクレート）だけが使う。ボタンを拾う部分・補助プログラム・文字認識には入れない",
    ),
    (
        "objc2-vision",
        "ocr",
        "S-3: 取り込みのときだけ、保存済みの画像を読む。文字認識のクレートだけが使う",
    ),
];

/// 使わない macOS の部品（クレート）。Cargo.toml の依存に宣言しない。
/// 画面を撮る・入力を送る・ほかのアプリの要素を読む・ほかのプロセスに触れる部品。
/// （`objc2-core-graphics` などは tao・wry を通して依存の一覧に入るので、一覧（Cargo.lock）ではなく、宣言（Cargo.toml）だけを見る。）
const MAC_FORBIDDEN_CRATES: &[&str] = &[
    "screencapturekit",
    "scrap",
    "xcap",
    "enigo",
    "autopilot",
    "rdev",
    "accessibility",
    "objc2-av-foundation",
    "mach2",
    "mach",
];

/// 語の前後が識別子の文字（英数字と `_`）でないものを探す（`*` で終わる語は前方一致）。見つかった（行番号, 語）を返す。
fn scan_mac_words(text: &str, words: &[&str]) -> Vec<(usize, String)> {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut hits = Vec::new();
    for (index, line) in text.lines().enumerate() {
        for word in words {
            let (core, prefix) = match word.strip_suffix('*') {
                Some(core) => (core, true),
                None => (*word, false),
            };
            let mut from = 0;
            while let Some(found) = line[from..].find(core) {
                let start = from + found;
                let end = start + core.len();
                let before_ok = !core.starts_with(is_ident) || !line[..start].ends_with(is_ident);
                let after_ok =
                    prefix || !core.ends_with(is_ident) || !line[end..].starts_with(is_ident);
                if before_ok && after_ok {
                    hits.push((index + 1, (*word).to_string()));
                    break;
                }
                from = end;
            }
        }
    }
    hits
}

/// macOS の API を調べる Rust のソース: 製品（本体・共有の部品・補助プログラム）と、文字認識のクレート。
fn mac_scanned_sources() -> Vec<PathBuf> {
    let mut files = rust_sources();
    files.extend(ocr_sources());
    files.sort();
    files
}

/// 署名・権限の設定を書くファイル: 本体のクレートの下（Tauri の設定・plist・entitlements など）と、リポジトリの作る・梱包する手順の置き場。
fn mac_config_files() -> Vec<PathBuf> {
    let accept = |p: &Path| {
        has_ext(
            p,
            &[
                "plist",
                "entitlements",
                "json",
                "toml",
                "xml",
                "sh",
                "ps1",
                "mjs",
                "yml",
                "yaml",
            ],
        )
    };
    let mut files = files_under(&crate_dir(), &accept);
    files.extend(files_under(&repo_root().join("scripts"), &accept));
    files.extend(files_under(&repo_root().join(".github"), &accept));
    files.sort();
    files
}

#[test]
fn the_mac_scanner_detects_every_forbidden_word_and_only_those() {
    let groups = MAC_FORBIDDEN
        .iter()
        .map(|(kind, words)| (*kind, *words))
        .chain(MAC_ONE_PLACE.iter().map(|place| (place.kind, place.words)));
    for (kind, words) in groups {
        for word in words {
            let core = word.trim_end_matches('*');
            let sample = if word.ends_with('*') {
                format!("let x = {core}Example;")
            } else {
                format!("let x = {core};")
            };
            assert_eq!(
                scan_mac_words(&sample, &[word]).len(),
                1,
                "{kind}: {word} を検出できない"
            );
        }
    }
    for word in MAC_FORBIDDEN_CONFIG {
        let sample = format!("<key>com.apple.security.{word}</key>");
        assert_eq!(scan_mac_words(&sample, &[word]).len(), 1, "{word}");
    }
    // 静止画 1 枚の撮影の設定・許可の確認・窓の一覧・クレート名・無関係な名前は、禁止の語に当たらない。
    let all: Vec<&str> = MAC_FORBIDDEN
        .iter()
        .flat_map(|(_, words)| words.iter().copied())
        .collect();
    for fine in [
        "SCStreamConfiguration::new()",
        "AXIsProcessTrusted()",
        "CGPreflightScreenCaptureAccess()",
        "CGWindowListCopyWindowInfo(options, 0)",
        "use screencapturekit as sck;",
        "mach_absolute_time()",
        "SCScreenshotManager::captureImage",
        "CGEventTapCreate(..)",
        "VNRecognizeTextRequest::new()",
        "let postscript = 1; // ptrace_is_not_here",
    ] {
        let hits = scan_mac_words(fine, &all);
        assert!(hits.is_empty(), "{fine}: {hits:?}");
    }
    // 前方一致の語（`*` で終わる）は、続きを問わない。
    assert_eq!(
        scan_mac_words("x.vm_readable_pages()", &["vm_read*"]).len(),
        1
    );
    // 使わない部品は名前で見つけ、tao・wry を通して入る部品（objc2-core-graphics など）には当たらない。
    let declared = "[dependencies]
xcap = \"1\"
objc2-core-graphics = \"0.3\"
accessibility-sys = \"0.1\"
";
    let names: Vec<String> = forbidden_crates_in_manifest(declared, MAC_FORBIDDEN_CRATES)
        .into_iter()
        .map(|(_, name)| name)
        .collect();
    assert_eq!(names, vec!["xcap", "accessibility-sys"]);
    // 識別子の途中の語には当たらない。
    assert!(scan_mac_words("xSCStream y", &["SCStream"]).is_empty());
    assert!(scan_mac_words("SCStream_x", &["SCStream"]).is_empty());
    assert_eq!(scan_mac_words("Retained<SCStream>", &["SCStream"]).len(), 1);
}

#[test]
fn mac_no_source_uses_a_forbidden_api() {
    let files = mac_scanned_sources();
    assert!(
        files.len() >= 30,
        "走査の対象が見つからない: {}",
        files.len()
    );
    let mut violations = Vec::new();
    for file in &files {
        let text = read(file);
        let product = product_part(&text);
        for (kind, words) in MAC_FORBIDDEN {
            let hits = scan_mac_words(product, words);
            if !hits.is_empty() {
                violations.push(report(&format!("macOS {kind}"), file, &hits));
            }
        }
    }
    assert_no_violations(violations);
}

#[test]
fn mac_signing_and_build_files_grant_no_debug_or_injection_entitlement() {
    let files = mac_config_files();
    assert!(
        files.iter().any(|p| p
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("tauri.conf.json")),
        "走査の対象に tauri.conf.json が入っていない"
    );
    let mut violations = Vec::new();
    for file in &files {
        let hits = scan_mac_words(&read(file), MAC_FORBIDDEN_CONFIG);
        if !hits.is_empty() {
            violations.push(report("macOS 権限", file, &hits));
        }
    }
    assert_no_violations(violations);
}

#[test]
fn mac_still_screenshots_event_taps_are_used_only_in_their_listed_files() {
    for OnePlace {
        kind,
        words,
        allowed,
    } in MAC_ONE_PLACE
    {
        for (file, reason) in *allowed {
            assert!(!reason.is_empty(), "{kind}: {file} の理由が空");
        }
        let mut users: Vec<String> = Vec::new();
        for file in mac_scanned_sources() {
            let text = read(&file);
            if !scan_mac_words(product_part(&text), words).is_empty() {
                users.push(file.to_string_lossy().replace('\\', "/"));
            }
        }
        assert_eq!(
            users.len(),
            allowed.len(),
            "{kind}: 使っているソースと一覧が合わない: {users:?}"
        );
        for user in &users {
            assert!(
                allowed.iter().any(|(file, _)| user.ends_with(file)),
                "{kind}: 許していない場所が使っている: {user}"
            );
        }
    }
}

#[test]
fn mac_manifests_declare_no_screen_input_or_process_crate_and_gated_crates_stay_in_their_crate() {
    let mut crates = crate_dirs().to_vec();
    crates.push(ocr_dir());
    let mut violations = Vec::new();
    for dir in &crates {
        let toml_path = dir.join("Cargo.toml");
        let toml = read(&toml_path);
        for (line, name) in forbidden_crates_in_manifest(&toml, MAC_FORBIDDEN_CRATES) {
            violations.push(format!(
                "[macOS 部品] {}:{line}: 使わない部品 {name}",
                toml_path.display()
            ));
        }
        for (name, allowed_dir, reason) in MAC_GATED_CRATES {
            assert!(!reason.is_empty(), "{name} の理由が空");
            let allowed = crate_dir().join(allowed_dir);
            let declared = !forbidden_crates_in_manifest(&toml, &[name]).is_empty();
            if declared && dir.canonicalize().ok() != allowed.canonicalize().ok() {
                violations.push(format!(
                    "[macOS 部品] {}: {name} を宣言してよいのは {allowed_dir} だけ（{reason}）",
                    toml_path.display()
                ));
            }
        }
    }
    assert_no_violations(violations);
}

// ---- macOS 段階 2: クリップボードの文字・ごみ箱・メニューだけ。AppKit と Foundation は、決めた機能だけ ----

/// macOS でクリップボードの文字を読む実装（読み取りの口はここだけ）。
fn mac_clipboard_reader_source() -> PathBuf {
    crate_dir()
        .join("src")
        .join("platform")
        .join("mac")
        .join("clipboard.rs")
}

/// macOS でごみ箱へ送る実装（ごみ箱へ送る口はここだけ）。
fn mac_trash_source() -> PathBuf {
    crate_dir()
        .join("src")
        .join("platform")
        .join("mac")
        .join("trash.rs")
}

/// 本体の Cargo.toml の、`name = ...` の宣言の行から、`features = [...]` の中身（宣言の順）を取り出す。
fn declared_features(manifest: &str, name: &str) -> Vec<String> {
    let line = manifest
        .lines()
        .find(|l| l.trim_start().starts_with(&format!("{name} = ")))
        .unwrap_or_else(|| panic!("{name} の宣言が無い"));
    let start = line.find("features = [").expect("features の指定がある") + "features = [".len();
    let end = start + line[start..].find(']').expect("features が閉じている");
    line[start..end]
        .split(',')
        .map(|f| f.trim().trim_matches('"').to_string())
        .filter(|f| !f.is_empty())
        .collect()
}

#[test]
fn s4_the_macos_clipboard_is_only_read_as_text_from_one_file() {
    let reader = read(&mac_clipboard_reader_source());
    let product = product_part(&reader);
    // 読む口は 1 つ（文字の形式だけ）。
    assert_eq!(product.matches("stringForType(").count(), 1);
    assert!(product.contains("NSPasteboardTypeString"));
    // 書き込み・消去・ほかの形式（画像・ファイル・HTML・RTF）・複数の項目・変更の監視・別の名前のペーストボードは使わない。
    for forbidden in [
        "clearContents",
        "setString",
        "setData",
        "setPropertyList",
        "writeObjects",
        "declareTypes",
        "addTypes",
        "dataForType",
        "propertyListForType",
        "readObjects",
        "pasteboardItems",
        "changeCount",
        "pasteboardWithName",
        "pasteboardWithUniqueName",
        "NSPasteboardTypePNG",
        "NSPasteboardTypeTIFF",
        "NSPasteboardTypeFileURL",
        "NSPasteboardTypeURL",
        "NSPasteboardTypeHTML",
        "NSPasteboardTypeRTF",
        "NSPasteboardTypePDF",
        "NSPasteboardNameFind",
        "NSPasteboardNameDrag",
    ] {
        assert!(!product.contains(forbidden), "{forbidden} を使っている");
    }
    // AppKit に触れるのは、このファイルだけ。クリップボードの文字を読む関数を呼ぶのは、鍵を持つ `src/clipboard.rs` だけ
    // （Windows の読み取りの検査 `s4_the_clipboard_is_only_read_as_text_and_only_the_import_command_reads_it` が、両方の OS で確かめている）。
    let users: Vec<String> = rust_sources()
        .into_iter()
        .filter(|file| read(file).contains("objc2_app_kit"))
        .map(|file| file.to_string_lossy().replace('\\', "/"))
        .collect();
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(
        users[0].ends_with("src/platform/mac/clipboard.rs"),
        "{users:?}"
    );
}

#[test]
fn u9_the_macos_trash_api_is_called_from_one_place_and_nothing_deletes_in_place() {
    let users = product_files_containing("trashItemAtURL");
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(users[0].ends_with("src/platform/mac/trash.rs"), "{users:?}");

    let trash = read(&mac_trash_source());
    let product = product_part(&trash);
    assert_eq!(
        product
            .matches("trashItemAtURL_resultingItemURL_error(")
            .count(),
        1,
        "呼ぶのは 1 回だけ"
    );
    // ごみ箱を通さずに消す・動かす・写す呼び方を入れない。
    for banned in [
        "removeItemAtURL",
        "removeItemAtPath",
        "moveItemAtURL",
        "moveItemAtPath",
        "copyItemAtURL",
        "copyItemAtPath",
        "remove_dir_all",
        "remove_dir(",
        "remove_file",
    ] {
        assert!(!product.contains(banned), "{banned} がある");
    }
    // 本物のごみ箱の道具を作るのは、この 1 つのファイルの 1 つの関数だけ。
    let makers = product_files_containing("MacRecycler");
    assert_eq!(makers.len(), 1, "{makers:?}");
    assert_eq!(product.matches("Box::new(MacRecycler)").count(), 1);
    // 頼むパスは、完全なパスだけ（相対パスを渡さない）。
    assert!(product.contains("is_absolute()"));
}

#[test]
fn mac_appkit_and_foundation_are_declared_with_a_fixed_short_feature_list() {
    // 画面・入力・ほかのアプリの情報に触れる部分（NSEvent・NSScreen・NSWorkspace・NSRunningApplication・NSAccessibility など）を、
    // 黙って足さない。足すときは、ここの一覧と、使う 1 か所の理由を決めてから。
    let manifest = read(&crate_dir().join("Cargo.toml"));
    assert_eq!(
        declared_features(&manifest, "objc2-app-kit"),
        ["std", "NSPasteboard"]
    );
    assert_eq!(
        declared_features(&manifest, "objc2-foundation"),
        ["std", "NSError", "NSFileManager", "NSString", "NSURL"]
    );
    for name in ["objc2-app-kit", "objc2-foundation"] {
        let line = manifest
            .lines()
            .find(|l| l.trim_start().starts_with(&format!("{name} = ")))
            .expect("宣言がある");
        assert!(
            line.contains("default-features = false"),
            "{name}: 既定の機能（すべて）を入れない"
        );
    }
    // 部品を使うソースは、決めた 2 つのファイルだけ。
    let mut users: Vec<String> = rust_sources()
        .into_iter()
        .filter(|file| {
            let text = read(file);
            text.contains("objc2_app_kit") || text.contains("objc2_foundation")
        })
        .map(|file| file.to_string_lossy().replace('\\', "/"))
        .collect();
    users.sort();
    assert_eq!(users.len(), 2, "{users:?}");
    assert!(
        users[0].ends_with("src/platform/mac/clipboard.rs"),
        "{users:?}"
    );
    assert!(users[1].ends_with("src/platform/mac/trash.rs"), "{users:?}");
}

#[test]
fn mac_platform_config_files_are_scanned_and_the_windows_helper_is_not_built_for_macos() {
    // macOS 用の設定（tauri.macos.conf.json）も、署名・権限の検査（`mac_signing_and_build_files_grant_no_debug_or_injection_entitlement`）の
    // 対象になっている。補助プログラムは Windows だけ（macOS の梱包には入れない）。
    let files = mac_config_files();
    assert!(
        files.iter().any(|p| p
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("tauri.macos.conf.json")),
        "走査の対象に tauri.macos.conf.json が入っていない"
    );
    let conf = read(&crate_dir().join("tauri.macos.conf.json"));
    assert!(!conf.to_lowercase().contains("helper"));
}
