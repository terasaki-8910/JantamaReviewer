//! タスクスケジューラの XML の名前空間。URL の形をした識別子の文字列で、通信には使わない。
//! URL の書き方を禁じる走査（tests/safety.rs の S-2）の許可の一覧に、理由つきで載せている、この 1 行だけのファイル。

pub const TASK_SCHEMA_NAMESPACE: &str = "http://schemas.microsoft.com/windows/2004/02/mit/task";
