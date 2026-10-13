//! 同期の失敗（F15）。画面に出せる日本語の文を持つ。文の中に、トークンは入れない
//! （通信の部品のエラーの文は、`credentials::redact` を通してから入れる）。

use std::fmt;

/// 大量の消去の向き。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MassDeleteSide {
    /// 手元で、記録のほとんどが無くなっている（消した印を、ほかの端末に送ろうとしていた）。
    Local,
    /// ほかの端末が、記録のほとんどを消した（手元の記録を消そうとしていた）。
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// つながらない・時間切れ（あとでやり直す。手元の記録は、ふだんどおり使える）。
    Offline(String),
    /// トークンが通らない（401・403）。
    Unauthorized,
    /// 同期用の DB の操作に失敗した。
    Remote(String),
    /// 手元の記録を読み書きできなかった。
    Local(String),
    /// 新しい版のアプリが作った同期用の DB（この版では、読み書きしない。壊さないため）。
    NewerSchema { found: u32, supported: u32 },
    /// 大量の消去を止めた（手元の記録がほとんど無くなっている・ほかの端末がほとんど消した）。
    MassDelete {
        side: MassDeleteSide,
        count: usize,
        total: usize,
    },
    /// URL かトークンが、まだ設定されていない。
    NotConfigured(String),
}

impl SyncError {
    /// 通信の失敗か（あとでやり直せば、直るもの）。
    pub fn is_offline(&self) -> bool {
        matches!(self, SyncError::Offline(_))
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Offline(reason) => write!(
                f,
                "同期先につながりません。つながったときに、続きを同期します（{reason}）"
            ),
            SyncError::Unauthorized => f.write_str(
                "同期先がトークンを受け付けません。トークンを貼り直してください（DB 用のトークンか、確かめてください）",
            ),
            SyncError::Remote(reason) => write!(f, "同期用の DB を扱えませんでした: {reason}"),
            SyncError::Local(reason) => write!(f, "手元の記録を扱えませんでした: {reason}"),
            SyncError::NewerSchema { found, supported } => write!(
                f,
                "同期用の DB は、新しい版のアプリで作られています（版 {found}。この版は {supported} まで）。アプリを新しくしてください。"
            ),
            SyncError::MassDelete { side, count, total } => match side {
                MassDeleteSide::Local => write!(
                    f,
                    "手元の記録が {total} 件のうち {count} 件、無くなっています。ほかの端末の記録を消さないよう、同期を止めました。"
                ),
                MassDeleteSide::Remote => write!(
                    f,
                    "ほかの端末が、記録 {total} 件のうち {count} 件を消しています。手元の記録を消さないよう、同期を止めました。"
                ),
            },
            SyncError::NotConfigured(what) => write!(f, "{what}が設定されていません"),
        }
    }
}

impl std::error::Error for SyncError {}
