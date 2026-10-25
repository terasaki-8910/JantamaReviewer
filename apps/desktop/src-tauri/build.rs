fn main() {
    tauri_build::build();
    embed_test_manifest();
}

/// 統合試験（tests/*.rs）の実行ファイルにも、Common Controls v6 を求める指定（マニフェスト）を入れる（Windows だけ）。
///
/// 偽の実行環境（`tauri::test`）でアプリを組み立てる試験（tests/update_layer.rs）は、メニューとトレイの部品を読み込む。
/// この部品は Common Controls v6 を要るが、アプリ本体の指定（tauri-build が入れる）は、試験の実行ファイルには入らず、
/// 指定が無いと、起動の時点で STATUS_ENTRYPOINT_NOT_FOUND で落ちる。製品の実行ファイルには関わらない。
/// 作る先の OS で決める（Windows 上で macOS 向けに検査するときは、何もしない）。
fn embed_test_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let manifest = std::path::Path::new(&dir)
        .join("tests")
        .join("windows-test.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}
