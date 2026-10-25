fn main() {
    // 同じソースから作った実行ファイルが、同じ中身になるようにする（リンクの時刻を、中身から決める）。
    // 本体を入れ直して配るたびに、補助プログラムを作り直すが、これが無いと、中身が同じでも、リンクの時刻のぶんだけ違う実行ファイルになり、
    // 設定済みの写しとの比べ（本体 src/platform/win/helper_setup.rs の `files_differ`）が、いつも「新しい補助プログラムがあります」になってしまう。
    // 補助プログラムのコードそのものは、変えない。
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_env == "msvc" {
        println!("cargo:rustc-link-arg-bins=/Brepro");
    }
}
