//! 安全の検査（ACCEPTANCE の S-1〜S-4、SPEC 2章）。
//!
//! 製品のソース（Rust・TypeScript・HTML・CSS）と依存の一覧を走査して、次のものが入っていないことを確かめる。
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

/// 通信してよい場所（ファイル名とその理由）。今は無い。F1 が足すときは、必ず理由を書く。
const ALLOWED_NETWORK_FILES: &[(&str, &str)] = &[];

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

/// 製品の Rust のソース。
fn rust_sources() -> Vec<PathBuf> {
    files_under(&crate_dir().join("src"), &|p| has_ext(p, &["rs"]))
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
    let toml = read(&crate_dir().join("Cargo.toml"));
    let mut violations = Vec::new();
    for (line, feature) in scan_lines(&toml, FORBIDDEN_WINDOWS_FEATURES, false) {
        violations.push(format!(
            "[S-1] Cargo.toml:{line}: windows の feature {feature}"
        ));
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
    let toml = read(&crate_dir().join("Cargo.toml"));
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
        "tauri-plugin-opener",
    ];
    let hits = forbidden_crates_in_manifest(&toml, &network);
    assert_no_violations(
        hits.iter()
            .map(|(line, name)| format!("[S-2] Cargo.toml:{line}: 通信の部品 {name}"))
            .collect(),
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
    for file in ["Cargo.toml", "Cargo.lock"] {
        let path = crate_dir().join(file);
        for (line, name) in forbidden_crates_in_manifest(&read(&path), VISION_CRATES) {
            violations.push(format!(
                "[S-3] {file}:{line}: 画像解析・文字認識の部品 {name}"
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
