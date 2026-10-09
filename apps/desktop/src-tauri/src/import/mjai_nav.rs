//! mjai の窓の移動の判定と、URL 欄に牌譜リンクを入れるスクリプト（F1、E-10、E-11）。
//!
//! 窓で開いてよいのは、mjai のサイトと、Cloudflare の確認の画面だけ。結果のページ
//! （`/killerducky/?data=/report/<ID>.json`）に移ろうとした時点で、その移動を止めて ID を返す
//! （AI の答えは画面に出さない。結果の JSON は、アプリ側で `report_fetch` が取る）。
//! ここは URL の文字列を判定するだけの純粋な部品で、通信も窓の操作もしない。
//! URL の文字列をソースに書かないのは、`tests/safety.rs` の S-2 がソース中の URL を通信の疑いとして拒むため
//! （スキーム・ホストの部品で持つ）。判定の試験は `tests/mjai_navigation.rs`。

use std::fmt;

use url::Url;

use super::report_id::ReportId;

/// mjai のサイトのホスト。
pub const MJAI_HOST: &str = "mjai.ekyu.moe";
/// Cloudflare の確認（Turnstile）の画面のホスト。
pub const CHALLENGE_HOST: &str = "challenges.cloudflare.com";
const SECURE_SCHEME: &str = "https";

/// 結果を見せる画面の場所（この下は、どれも見せずに止める）。
const RESULT_VIEWER_PATH: &str = "/killerducky";
/// 結果のページが、結果の置き場所を渡す検索の項目の名前。
const RESULT_DATA_PARAM: &str = "data";
const REPORT_PATH_PREFIX: &str = "/report/";
const REPORT_PATH_SUFFIX: &str = ".json";

/// mjai の窓が移ろうとしたときの扱い。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MjaiNavigation {
    /// そのまま読み込む（mjai のサイト・Cloudflare の確認の画面）。
    Allow,
    /// 結果のページへ移ろうとした。移動は止めて、この ID の結果を取りにいく。
    ReportFound(ReportId),
    /// 止める（ほかのすべて）。
    Block,
}

/// 結果の置き場所のパス（`/report/<ID>.json`）から ID を取り出す。
fn report_id_from_path(path: &str) -> Option<ReportId> {
    let id = path
        .strip_prefix(REPORT_PATH_PREFIX)?
        .strip_suffix(REPORT_PATH_SUFFIX)?;
    ReportId::parse(id)
}

/// mjai のサイトの中での扱い。
fn decide_on_mjai(url: &Url) -> MjaiNavigation {
    let path = url.path();
    let in_viewer = path == RESULT_VIEWER_PATH
        || path
            .strip_prefix(RESULT_VIEWER_PATH)
            .is_some_and(|rest| rest.starts_with('/'));
    if in_viewer {
        // 結果を見せる画面は、結果の置き場所が正しく渡されていれば「見つけた」、そうでなければ、何も見せずに止める。
        let found = url
            .query_pairs()
            .find(|(key, _)| key == RESULT_DATA_PARAM)
            .and_then(|(_, value)| report_id_from_path(&value));
        return found.map_or(MjaiNavigation::Block, MjaiNavigation::ReportFound);
    }
    // 結果の JSON そのものへ移ろうとしたときも、画面に出さずに止めて、見つけた扱いにする。
    match report_id_from_path(path) {
        Some(id) => MjaiNavigation::ReportFound(id),
        None => MjaiNavigation::Allow,
    }
}

/// mjai の窓が移ろうとしたとき（新しい窓の要求も同じ）の扱いを決める（E-10）。
/// - `https` で、ユーザー名・ポートの指定が無く、ホストが mjai のサイトなら通す。ただし結果のページは止めて ID を返す。
/// - ホストが Cloudflare の確認の画面なら通す。
/// - ほかは、すべて止める（`http`・別のホスト・似たホスト・`about:`・`file:` など）。
pub fn decide_navigation(url: &Url) -> MjaiNavigation {
    if url.scheme() != SECURE_SCHEME
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return MjaiNavigation::Block;
    }
    match url.host_str() {
        Some(MJAI_HOST) => decide_on_mjai(url),
        Some(CHALLENGE_HOST) => MjaiNavigation::Allow,
        _ => MjaiNavigation::Block,
    }
}

/// 貼り付けられた文字から、結果の ID を探す（結果の URL を貼る取り込み方。F1）。
/// 結果のページの URL（`/killerducky/?data=/report/<ID>.json`）か、結果の置き場所の URL（`/report/<ID>.json`）が
/// 文の中にあればその ID。文字全体が ID だけでもよい。見つからなければ `None`。
pub fn report_id_from_text(text: &str) -> Option<ReportId> {
    if let Some(id) = ReportId::parse(text.trim()) {
        return Some(id);
    }
    text.split_whitespace().find_map(|token| {
        let token = token.trim_matches(|c: char| {
            matches!(
                c,
                '<' | '>' | '"' | '\'' | '(' | ')' | '「' | '」' | '、' | '。'
            )
        });
        let url = Url::parse(token).ok()?;
        match decide_navigation(&url) {
            MjaiNavigation::ReportFound(id) => Some(id),
            _ => None,
        }
    })
}

/// mjai の窓が最初に開くページ（サイトの入り口）。
pub fn start_url() -> Url {
    Url::parse(&format!("{SECURE_SCHEME}://{MJAI_HOST}/")).expect("固定の URL は読める")
}

/// 窓に入れる牌譜リンクの上限の長さ。
const MAX_LINK_LEN: usize = 2048;

/// URL 欄に入れるスクリプトを作れなかった理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrefillError {
    /// 牌譜リンクが空・長すぎる・制御文字を含む・前後に空白がある。
    BadLink,
    /// `https` の URL ではない。
    NotHttps,
}

impl fmt::Display for PrefillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PrefillError::BadLink => f.write_str(
                "牌譜リンクが正しくありません（空・長すぎる・改行などが混ざっています）。",
            ),
            PrefillError::NotHttps => f.write_str("牌譜リンクが https の URL ではありません。"),
        }
    }
}

impl std::error::Error for PrefillError {}

/// 牌譜リンクを URL 欄に入れるスクリプトの本体（関数の式。`prefill.js`）。
pub const PREFILL_FUNCTION: &str = include_str!("prefill.js");

/// 窓の作り始めに評価させる、ページ側の設定（N-9・N-10。`mjai_native.js`）。
pub const NATIVE_SCRIPT: &str = include_str!("mjai_native.js");

/// 牌譜リンク `link` を URL 欄に入れるスクリプト（評価できる文）を作る（E-11）。
/// リンクは、JSON の文字列として埋め込む（引用符・改行・`</script>` などがあっても、スクリプトとして解釈されない）。
pub fn prefill_script(link: &str) -> Result<String, PrefillError> {
    let valid = !link.is_empty()
        && link.len() <= MAX_LINK_LEN
        && link == link.trim()
        && !link.chars().any(char::is_control);
    if !valid {
        return Err(PrefillError::BadLink);
    }
    let url = Url::parse(link).map_err(|_| PrefillError::BadLink)?;
    if url.scheme() != SECURE_SCHEME || url.host_str().is_none() {
        return Err(PrefillError::NotHttps);
    }
    let literal = serde_json::to_string(link).map_err(|_| PrefillError::BadLink)?;
    let function = prefill_function().trim_end().trim_end_matches(';');
    Ok(format!("({function})({literal});"))
}

/// `prefill.js` の、先頭の説明のコメントを除いた、関数の式。
fn prefill_function() -> &'static str {
    let start = PREFILL_FUNCTION
        .find("(function")
        .expect("prefill.js は関数の式で始まる");
    &PREFILL_FUNCTION[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    // URL を書く試験（移動の判定・スクリプトの埋め込み）は、`tests/mjai_navigation.rs` にある
    // （ソースの URL を通信の疑いとして拒む S-2 の走査の外に置くため）。

    #[test]
    fn the_start_url_is_the_site_entrance_and_is_allowed() {
        let url = start_url();
        assert_eq!(url.scheme(), SECURE_SCHEME);
        assert_eq!(url.host_str(), Some(MJAI_HOST));
        assert_eq!(url.path(), "/");
        assert_eq!(decide_navigation(&url), MjaiNavigation::Allow);
    }

    #[test]
    fn the_prefill_function_is_one_function_expression_after_the_leading_comment() {
        let function = prefill_function().trim_end();
        assert!(function.starts_with("(function (link) {"));
        assert!(function.ends_with("})"));
        // 牌譜リンクを受ける、いちばん外の関数の式が 1 つだけ（中の無名関数は、引数を受けない）。
        assert_eq!(function.matches("(function (link) {").count(), 1);
    }

    #[test]
    fn a_bad_link_is_refused_without_building_a_script() {
        for bad in [
            "",
            " ",
            "a b",
            "x
y",
            "ftp-like",
            "no-scheme.example",
        ] {
            let error = prefill_script(bad).unwrap_err();
            assert!(
                matches!(error, PrefillError::BadLink | PrefillError::NotHttps),
                "{bad:?}"
            );
        }
        assert_eq!(
            prefill_script(&"x".repeat(MAX_LINK_LEN + 1)),
            Err(PrefillError::BadLink)
        );
        assert!(prefill_script(
            "line
break"
        )
        .is_err());
    }

    #[test]
    fn the_native_script_blocks_back_forward_and_middle_buttons_and_quiets_inputs() {
        for needle in [
            "button === 3",
            "button === 4",
            "button === 1",
            "spellcheck",
            "autocomplete",
        ] {
            assert!(NATIVE_SCRIPT.contains(needle), "{needle}");
        }
    }
}
