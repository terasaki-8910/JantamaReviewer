//! 安全の検査（ACCEPTANCE の S-1〜S-4、SPEC 2章）。
//!
//! 製品のソース（Rust・TypeScript・HTML・CSS）と依存の一覧を走査して、次のものが入っていないことを確かめる。
//! Rust のソースは、本体（src）・共有の部品（input/src）・管理者で動く補助プログラム（helper/src）のすべて。
//! 補助プログラムには、さらに W-9 の決まり（ファイル・ほかのプログラム・画面・文字認識の部品を持たない。例外は設定と解除の 1 ファイル）を課す。
//! - S-1: ほかのプロセス（ゲーム）のメモリを読み書きする・スレッドを差し込むなどの API。
//! - S-2: 雀魂のドメインへの通信、通信の部品（HTTP クライアントなど）。
//! - S-3: 画像の解析・文字認識のライブラリ（PNG の書き出しは良い）。
//! - S-4: ウィジェットのコードが、ファイル保存と記録の追記以外の窓口（プラグインなど）を読み込むこと。
//!
//! 走査の道具そのものも、禁止の一覧のすべてを実際に検出できることをテストする。
//! 後の機能（F1 の取り込みなど）が通信を足すときは、`ALLOWED_*` に理由つきで足す。
//! 一覧を黙って緩めない。

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

/// S-3: Rust の画像の解析の窓口。
const VISION_RUST: &[&str] = &["Media_Ocr", "OcrEngine", "Windows.Media.Ocr"];

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

/// ウィジェットの画面のコードが読み込んでよいもの。ウィジェットはファイル保存と記録の追記しかしない（S-4）ので、
/// プラグインは一切読まない。`@tauri-apps/api` も、記録のコマンドとイベントの窓口に限る。
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
    for dir in crate_dirs() {
        let toml = read(&dir.join("Cargo.toml"));
        for (line, name) in forbidden_crates_in_manifest(&toml, &network) {
            violations.push(format!(
                "[S-2] {}/Cargo.toml:{line}: 通信の部品 {name}",
                dir.display()
            ));
        }
    }
    assert_no_violations(violations);
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
    let crates: Vec<String> = text
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect();
    assert!(
        crates.iter().any(|c| c == "tauri"),
        "依存の一覧を読めていない"
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
    for name in &crates {
        if network.contains(&name.as_str()) {
            violations.push(format!("[S-2] 実行時の依存に通信の部品 {name}"));
        }
        let manifest_line = format!("{name} = 1");
        for (_, hit) in forbidden_crates_in_manifest(&manifest_line, VISION_CRATES) {
            violations.push(format!("[S-3] 実行時の依存に画像解析の部品 {hit}"));
        }
    }
    assert_no_violations(violations);
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
fn product_part(text: &str) -> &str {
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
