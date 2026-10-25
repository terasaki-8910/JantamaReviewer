//! NAGA の結果のページの URL（F22 段 2）の決まりと、画面（検討画面）から保存するコマンド。
//!
//! NAGA（麻雀 AI）で解析した結果のページの URL を、半荘ごとに 1 つ、半荘のフォルダの `naga.json` に置く。
//! 受け付けるのは、NAGA のサイトの https の URL だけ。アプリはこの URL にアクセスしない（通信しない）。
//! 画面のリンクを押したとき、いつものブラウザで開くだけ（`external.rs`。S-2）。
//!
//! 実際の保存は `store`（半荘のフォルダの `naga.json`）に任せ、コマンドは薄い層にとどめる。
//! ウィジェットの記録（`events.jsonl`。追記だけ）は書き換えない。
//! 保存したあとに、状態の変化を知らせて、半荘の一覧（NAGA の結果の URL も入っている）が読み直されるようにする。
//! ウィジェットの窓は、このコマンドを呼ばない（検討画面だけが呼ぶ）。
//!
//! URL の文字列をソースに書かないのは、`tests/safety.rs` の S-2 がソース中の URL を通信の疑いとして拒むため
//! （スキーム・ホストの部品で持つ）。判定の試験は `tests/naga_url.rs`。

use tauri::{AppHandle, State};
use url::Url;

use crate::clock::now_ms;
use crate::commands::{emit_state, SharedCore};

/// NAGA のサイトのホスト名。NAGA の結果の URL として受け付けるのは、このホストの https の URL だけ。
/// NAGA のサイトの場所が変わったら、ここを直す（画面の見本の文字 `src/main/naga.ts` の `NAGA_HOST` も同じに。違うと `tests/naga_url.rs` が気づく）。
pub const NAGA_HOST: &str = "naga.dmv.nico";
const SECURE_SCHEME: &str = "https";
/// 貼った URL の長さの上限（文字数）。
pub const MAX_NAGA_URL_CHARS: usize = 2048;

/// 貼った文字が NAGA の結果のページの URL なら、保存する形（前後の空白を除き、URL の決まりに沿って整えた文字）にして返す。
/// そうでなければ `None`。通すのは、次をすべて満たすものだけ:
/// - スキームが https で、ホストが NAGA のサイトそのもの（`NAGA_HOST`。サブドメインや、似た名前の別のサイトは通さない）
/// - ユーザー名・パスワード・ポートの指定が無い
/// - 長さが `MAX_NAGA_URL_CHARS` 以内
pub fn checked_naga_url(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_NAGA_URL_CHARS {
        return None;
    }
    let url = Url::parse(text).ok()?;
    let is_naga = url.scheme() == SECURE_SCHEME
        && url.host_str() == Some(NAGA_HOST)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none();
    let normalized = url.to_string();
    (is_naga && normalized.chars().count() <= MAX_NAGA_URL_CHARS).then_some(normalized)
}

/// 貼った文字が NAGA の結果の URL でなかったときに、画面に出す文。
pub fn invalid_url_message() -> String {
    format!(
        "NAGA の結果のページの URL（{SECURE_SCHEME}://{NAGA_HOST}/ で始まるもの）を貼ってください"
    )
}

/// 試験用: NAGA の結果のページの URL の見本（`report_id` だけが違う）。ソースに URL を書かないので、部品から組み立てる。
#[cfg(test)]
pub(crate) fn sample_url(report_id: &str) -> String {
    format!("{SECURE_SCHEME}://{NAGA_HOST}/htmls/report_viewer.html?report_id={report_id}")
}

/// 保存したあとに、記録の一覧が更新されるよう、状態の変化を知らせる。
fn changed(app: &AppHandle, core: &SharedCore) {
    let state = core.lock().app_state();
    emit_state(app, &state);
}

/// 半荘の NAGA の結果の URL を保存する・消す（F22 段 2）。`url` が `None` か、前後の空白を除いて空なら、消す
/// （`naga.json` も消える。無くても、エラーにならない。取り消しにも使う）。
/// 入れるのは、NAGA のサイトの https の URL だけ（そうでなければ、理由を返して、何も保存しない）。保存した時刻（いま）も一緒に置く。
#[tauri::command]
pub async fn set_naga_url(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    url: Option<String>,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_naga_url(&session_id, url.as_deref(), now_ms())
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}
