//! 設定。JSON で保存し、欠けた項目は既定値で補う（W-5）。
//!
//! 保存する項目: 迷いマークのボタン（マウスのボタン、または修飾キー付きのキー）、ウィジェットの形と位置、音、
//! 迷いだけを記録する（既定は入。ウィジェットが 48px 角の「迷い」ボタン 1 つになり、〇△✕ と終局直後メモの画面の部品を出さない）、
//! 雀魂の窓を探す語、データの保存先、出題の設定（1 日に出す数・大きな不一致の基準・ドラを目立たせる）、
//! 半荘を通して見る画面の設定（AI の1位と違う判断も不一致として出す・キーの割り当て）。

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use jantama_input::keys::{code_from_vk, vk_from_code, Modifiers};
use jantama_input::logic::{ActiveTrigger, MouseButton};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::replay_keys::{self, ReplayKeys, ReplayKeysError};

/// 雀魂の窓を探す語の既定値（W-7）。
pub const DEFAULT_CAPTURE_KEYWORDS: [&str; 2] = ["雀魂", "Mahjong Soul"];

/// 設定ファイルの名前。
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// 1 日に出す数（今日の出題。F2）の既定値と、設定できる範囲。
pub const DEFAULT_DAILY_COUNT: u32 = 5;
pub const MIN_DAILY_COUNT: u32 = 1;
pub const MAX_DAILY_COUNT: u32 = 50;

/// 大きな不一致の基準（AI が実戦の行動に付けた確率が、この %（未満）の判断を不一致とする。F2）の既定値と、設定できる範囲。
pub const DEFAULT_DISAGREEMENT_PERCENT: u32 = 5;
pub const MIN_DISAGREEMENT_PERCENT: u32 = 1;
pub const MAX_DISAGREEMENT_PERCENT: u32 = 50;

/// データの保存先の既定のフォルダ名（ユーザーのフォルダの直下）。
pub const DEFAULT_DATA_DIR_NAME: &str = "JantamaReviewerData";

/// 迷いマークを付けるボタン。設定の「ボタンを登録」で、押したマウスのボタン（戻る・進む・中ボタン）か、
/// 修飾キー付きのキーをそのまま覚える（W-10）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// 「戻る」ボタン（XBUTTON1）。既定。
    #[default]
    MouseX1,
    /// 「進む」ボタン（XBUTTON2）。
    MouseX2,
    /// 中ボタン。
    MouseMiddle,
    /// キーボードのキー。`code` は DOM の `KeyboardEvent.code`（例: "F13"、"KeyM"）。
    /// 修飾キーの印は、付いているものだけ保存する（昔の設定ファイルの `{"kind":"key","code":"F8"}` もそのまま読める）。
    Key {
        code: String,
        #[serde(default, skip_serializing_if = "is_false")]
        ctrl: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        alt: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        shift: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        win: bool,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Trigger {
    /// 修飾キー無しのキー。
    pub fn key(code: &str) -> Trigger {
        Trigger::key_with(code, Modifiers::NONE)
    }

    /// 修飾キー付きのキー。
    pub fn key_with(code: &str, mods: Modifiers) -> Trigger {
        Trigger::Key {
            code: code.to_string(),
            ctrl: mods.ctrl,
            alt: mods.alt,
            shift: mods.shift,
            win: mods.win,
        }
    }

    /// フックの中で使う形（キーは仮想キーコード）にする。割り当てられないキーなら `None`。
    pub fn to_active(&self) -> Option<ActiveTrigger> {
        match self {
            Trigger::MouseX1 => Some(ActiveTrigger::Mouse(MouseButton::X1)),
            Trigger::MouseX2 => Some(ActiveTrigger::Mouse(MouseButton::X2)),
            Trigger::MouseMiddle => Some(ActiveTrigger::Mouse(MouseButton::Middle)),
            Trigger::Key {
                code,
                ctrl,
                alt,
                shift,
                win,
            } => vk_from_code(code)
                .map(|vk| ActiveTrigger::key(vk, Modifiers::new(*ctrl, *alt, *shift, *win))),
        }
    }

    /// 登録で拾った入力から設定を作る。設定に保存できない入力（左右のボタン・割り当てられないキー）は `None`。
    pub fn from_active(active: ActiveTrigger) -> Option<Trigger> {
        match active {
            ActiveTrigger::Mouse(MouseButton::X1) => Some(Trigger::MouseX1),
            ActiveTrigger::Mouse(MouseButton::X2) => Some(Trigger::MouseX2),
            ActiveTrigger::Mouse(MouseButton::Middle) => Some(Trigger::MouseMiddle),
            ActiveTrigger::Mouse(_) => None,
            ActiveTrigger::Key(chord) => {
                code_from_vk(chord.vk).map(|code| Trigger::key_with(&code, chord.mods))
            }
        }
    }
}

/// ウィジェットの形。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    /// 縦長（幅 76px）。既定。
    #[default]
    Vertical,
    /// 横長（340×64px）。
    Horizontal,
}

impl Orientation {
    /// 縦と横を入れ替える。
    pub fn toggled(self) -> Self {
        match self {
            Orientation::Vertical => Orientation::Horizontal,
            Orientation::Horizontal => Orientation::Vertical,
        }
    }
}

/// ウィジェットの窓の位置（物理ピクセル。画面全体の座標）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub trigger: Trigger,
    pub orientation: Orientation,
    pub widget_position: Option<WidgetPosition>,
    pub sound: bool,
    /// 迷いだけを記録する（既定は入。F0、W-15）。入のとき、ウィジェットは形（`orientation`）によらず 48px 角の「迷い」ボタン 1 つになり、
    /// 〇△✕（局の自己評価）と終局直後メモの画面の部品を出さない。記録は消さず、切れば元どおり出る。
    pub doubt_only: bool,
    pub capture_keywords: Vec<String>,
    pub data_dir: PathBuf,
    /// 1 日に出す問題の数（今日の出題。既定 5）。
    pub daily_count: u32,
    /// 大きな不一致の基準（%。既定 5）。
    pub disagreement_percent: u32,
    /// 出題・半荘を通して見る画面で、ドラ表示牌が指す牌の面を黄色にする（既定は切。U-19）。
    pub highlight_dora: bool,
    /// 半荘を通して見る画面で、AI の1位と違う判断もすべて不一致として出す（既定は切。R10-4、E-26）。出題の基準は変えない。
    pub show_all_mismatches: bool,
    /// 半荘を通して見る画面のキーの割り当て（操作の名前 → キー。割り当て無しは null。R10-3、U-21）。
    pub replay_keys: ReplayKeys,
    /// `replay_keys` の表の版（`replay_keys::KEYS_REVISION`）。読み込みと保存のたびに、いまの版にそろえる。
    /// 版 1 のファイル（この項目が無い）の、局の頭・局の終わりの null を、「書いていない」と読み分けるために書く（R11-4）。
    pub replay_keys_revision: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            trigger: Trigger::default(),
            orientation: Orientation::default(),
            widget_position: None,
            sound: true,
            doubt_only: true,
            capture_keywords: DEFAULT_CAPTURE_KEYWORDS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            data_dir: default_data_dir(),
            daily_count: DEFAULT_DAILY_COUNT,
            disagreement_percent: DEFAULT_DISAGREEMENT_PERCENT,
            highlight_dora: false,
            show_all_mismatches: false,
            replay_keys: replay_keys::default_keys(),
            replay_keys_revision: replay_keys::KEYS_REVISION,
        }
    }
}

/// 設定の値が使えないときの理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsError {
    /// 割り当てられないキー。
    UnsupportedKey(String),
    /// 1 日に出す数が範囲の外。
    DailyCountOutOfRange(u32),
    /// 大きな不一致の基準が範囲の外。
    DisagreementPercentOutOfRange(u32),
    /// 半荘を通して見る画面のキーの割り当てが使えない。
    ReplayKeys(ReplayKeysError),
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettingsError::UnsupportedKey(code) => {
                write!(f, "このキーは割り当てられません: {code}")
            }
            SettingsError::DailyCountOutOfRange(value) => write!(
                f,
                "1日に出す数は {MIN_DAILY_COUNT} から {MAX_DAILY_COUNT} の間で指定してください: {value}"
            ),
            SettingsError::DisagreementPercentOutOfRange(value) => write!(
                f,
                "大きな不一致の基準は {MIN_DISAGREEMENT_PERCENT}% から {MAX_DISAGREEMENT_PERCENT}% の間で指定してください: {value}"
            ),
            SettingsError::ReplayKeys(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SettingsError {}

/// データの保存先の既定: ユーザーのフォルダの直下の `JantamaReviewerData`（Windows は `%USERPROFILE%\JantamaReviewerData`、
/// macOS は `~/JantamaReviewerData`）。macOS でも、`~/Library/Application Support` ではなく、ユーザーのフォルダの直下に置く:
/// Finder で見える場所で、Windows から写す・書き出す・同期する記録のフォルダを、同じ名前・同じ置き方にそろえられる。
/// 設定ファイルだけは、macOS の決まり（`~/Library/Application Support/<識別子>`。Tauri の設定フォルダ）に置く。
pub fn default_data_dir() -> PathBuf {
    default_data_dir_from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")))
}

/// 環境変数の値を渡して既定の保存先を作る（テスト用に切り出している）。
pub fn default_data_dir_from(home: Option<OsString>) -> PathBuf {
    match home {
        Some(home) if !home.is_empty() => PathBuf::from(home).join(DEFAULT_DATA_DIR_NAME),
        _ => PathBuf::from(DEFAULT_DATA_DIR_NAME),
    }
}

impl Settings {
    /// JSON の文字列から読む。構文が壊れていればエラー。
    /// 構文が正しければ、欠けた項目・読めない項目は既定値で補う。
    pub fn from_json_str(text: &str) -> Result<Settings, serde_json::Error> {
        // Windows のエディタや PowerShell 5.1 は UTF-8 の先頭に BOM を付けることがある。
        // BOM 付きを壊れたファイルとして退避しないよう、先に取り除く。
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let value: Value = serde_json::from_str(text)?;
        Ok(Settings::from_value(&value))
    }

    /// 項目ごとに読む。欠けている項目や型の合わない項目は既定値にし、ほかの項目は守る。
    pub fn from_value(value: &Value) -> Settings {
        let defaults = Settings::default();
        let data_dir = field::<PathBuf>(value, "data_dir").filter(|p| !p.as_os_str().is_empty());
        Settings {
            trigger: field(value, "trigger").unwrap_or(defaults.trigger),
            orientation: field(value, "orientation").unwrap_or(defaults.orientation),
            widget_position: field(value, "widget_position").unwrap_or(defaults.widget_position),
            sound: field(value, "sound").unwrap_or(defaults.sound),
            doubt_only: field(value, "doubt_only").unwrap_or(defaults.doubt_only),
            capture_keywords: field(value, "capture_keywords").unwrap_or(defaults.capture_keywords),
            data_dir: data_dir.unwrap_or(defaults.data_dir),
            // 範囲の外の値（手で書き換えた設定ファイル）は、既定値にする。
            daily_count: field::<u32>(value, "daily_count")
                .filter(|n| (MIN_DAILY_COUNT..=MAX_DAILY_COUNT).contains(n))
                .unwrap_or(defaults.daily_count),
            disagreement_percent: field::<u32>(value, "disagreement_percent")
                .filter(|n| (MIN_DISAGREEMENT_PERCENT..=MAX_DISAGREEMENT_PERCENT).contains(n))
                .unwrap_or(defaults.disagreement_percent),
            highlight_dora: field(value, "highlight_dora").unwrap_or(defaults.highlight_dora),
            show_all_mismatches: field(value, "show_all_mismatches")
                .unwrap_or(defaults.show_all_mismatches),
            // 無い・読めない・使えないキーは、既定のキーにする（replay_keys.rs）。版 1 のファイルの null は、書いていないものとして読む。
            replay_keys: replay_keys::from_value(
                value.get("replay_keys"),
                field::<u32>(value, "replay_keys_revision").unwrap_or(0),
            ),
            replay_keys_revision: replay_keys::KEYS_REVISION,
        }
    }

    /// 窓を探す語の前後の空白を取り、空の語と重複を除く。
    /// 空の語を残すと、どの窓の題名にも当たってしまう（W-7）。
    pub fn normalized(mut self) -> Settings {
        let mut kept: Vec<String> = Vec::new();
        for word in self.capture_keywords.drain(..) {
            let word = word.trim().to_string();
            if !word.is_empty() && !kept.iter().any(|w| w.to_lowercase() == word.to_lowercase()) {
                kept.push(word);
            }
        }
        self.capture_keywords = kept;
        // キーの割り当ては、足りない操作に既定を入れ、書き方をそろえる（使えないものは、`validate` が断る）。
        self.replay_keys = replay_keys::normalized(std::mem::take(&mut self.replay_keys));
        self.replay_keys_revision = replay_keys::KEYS_REVISION;
        self
    }

    /// 使えない値が入っていないかを確かめる。
    pub fn validate(&self) -> Result<(), SettingsError> {
        if let Trigger::Key { code, .. } = &self.trigger {
            if vk_from_code(code).is_none() {
                return Err(SettingsError::UnsupportedKey(code.clone()));
            }
        }
        if !(MIN_DAILY_COUNT..=MAX_DAILY_COUNT).contains(&self.daily_count) {
            return Err(SettingsError::DailyCountOutOfRange(self.daily_count));
        }
        if !(MIN_DISAGREEMENT_PERCENT..=MAX_DISAGREEMENT_PERCENT)
            .contains(&self.disagreement_percent)
        {
            return Err(SettingsError::DisagreementPercentOutOfRange(
                self.disagreement_percent,
            ));
        }
        replay_keys::validate(&self.replay_keys).map_err(SettingsError::ReplayKeys)?;
        Ok(())
    }

    /// ファイルから読む。ファイルが無ければ既定値。構文が壊れていればエラー。
    pub fn load(path: &Path) -> io::Result<Settings> {
        match fs::read_to_string(path) {
            Ok(text) => Settings::from_json_str(&text)
                .map(Settings::normalized)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(e),
        }
    }

    /// 起動時の読み込み。壊れた設定ファイルは `.broken` に退避して既定値で始める（上書きで失わない）。
    /// 退避した場合は、そのことを知らせる文を返す。
    pub fn load_or_recover(path: &Path) -> (Settings, Option<String>) {
        match Settings::load(path) {
            Ok(settings) => (settings, None),
            Err(e) => {
                let backup = path.with_extension("json.broken");
                let note = match fs::rename(path, &backup) {
                    Ok(()) => format!(
                        "設定ファイルを読めなかったため既定値で始めます（{e}）。元のファイルは {} に退避しました。",
                        backup.display()
                    ),
                    Err(rename_err) => format!(
                        "設定ファイルを読めなかったため既定値で始めます（{e}）。退避にも失敗しました（{rename_err}）。"
                    ),
                };
                (Settings::default(), Some(note))
            }
        }
    }

    /// ファイルに保存する。一時ファイルに書いてから置き換えるので、途中で止まっても元の設定を壊さない。
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json)?;
        fs::rename(&tmp, path)
    }
}

/// JSON のオブジェクトから 1 項目を読む。無い・型が合わないときは `None`。
fn field<T: serde::de::DeserializeOwned>(value: &Value, key: &str) -> Option<T> {
    value
        .get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// 設定ファイルの場所（設定のフォルダの中）。
pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("一時フォルダを作れる")
    }

    #[test]
    fn w5_defaults_are_vertical_x1_sound_on_and_japanese_keywords() {
        let s = Settings::default();
        assert_eq!(s.orientation, Orientation::Vertical);
        assert_eq!(s.trigger, Trigger::MouseX1);
        assert!(s.sound);
        assert_eq!(s.capture_keywords, vec!["雀魂", "Mahjong Soul"]);
        assert_eq!(s.widget_position, None);
        assert!(s.data_dir.ends_with(DEFAULT_DATA_DIR_NAME));
    }

    #[test]
    fn w15_doubt_only_is_on_by_default_and_a_file_without_it_reads_as_on() {
        assert!(Settings::default().doubt_only);
        // 昔の設定ファイル（この項目が無い）は、入として読む。ほかの項目は守る。
        let old =
            Settings::from_json_str(r#"{ "sound": false, "orientation": "horizontal" }"#).unwrap();
        assert!(old.doubt_only);
        assert!(!old.sound);
        assert_eq!(old.orientation, Orientation::Horizontal);
        assert!(Settings::from_json_str("{}").unwrap().doubt_only);
        // 画面から届く設定にこの項目が無くても（`#[serde(default)]`）、入になる。
        let from_page: Settings = serde_json::from_str(r#"{ "sound": false }"#).unwrap();
        assert!(from_page.doubt_only);
    }

    #[test]
    fn w15_doubt_only_is_saved_and_read_back_in_both_states() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        for value in [false, true] {
            let saved = Settings {
                doubt_only: value,
                ..Settings::default()
            };
            saved.save(&path).unwrap();
            let loaded = Settings::load(&path).unwrap();
            assert_eq!(loaded, saved);
            assert_eq!(loaded.doubt_only, value);
            let text = fs::read_to_string(&path).unwrap();
            assert!(text.contains(&format!("\"doubt_only\": {value}")), "{text}");
        }
        // 切にして、形と窓の位置を選んであれば、次の起動で残る（切にすると、選んでいた形に戻るため）。
        let saved = Settings {
            doubt_only: false,
            orientation: Orientation::Horizontal,
            widget_position: Some(WidgetPosition { x: 10, y: 20 }),
            ..Settings::default()
        };
        saved.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert!(!loaded.doubt_only);
        assert_eq!(loaded.orientation, Orientation::Horizontal);
        assert_eq!(
            loaded.widget_position,
            Some(WidgetPosition { x: 10, y: 20 })
        );
    }

    #[test]
    fn w15_an_unreadable_doubt_only_falls_back_to_on_without_discarding_the_others() {
        for bad in [r#""yes""#, "1", "null", r#"{ "on": true }"#] {
            let s = Settings::from_json_str(&format!(
                r#"{{ "doubt_only": {bad}, "sound": false, "daily_count": 8 }}"#
            ))
            .unwrap();
            assert!(s.doubt_only, "{bad}");
            assert!(!s.sound, "{bad}");
            assert_eq!(s.daily_count, 8, "{bad}");
        }
        let off = Settings::from_json_str(r#"{ "doubt_only": false }"#).unwrap();
        assert!(!off.doubt_only);
        assert_eq!(off.validate(), Ok(()));
    }

    #[test]
    fn u19_the_study_settings_default_to_5_a_day_5_percent_and_no_dora_emphasis() {
        let s = Settings::default();
        assert_eq!(s.daily_count, 5);
        assert_eq!(s.disagreement_percent, 5);
        assert!(!s.highlight_dora);
        // ファイルに無い項目は、既定値（昔の設定ファイル）
        let old = Settings::from_json_str(r#"{ "sound": false }"#).unwrap();
        assert_eq!(old.daily_count, 5);
        assert_eq!(old.disagreement_percent, 5);
        assert!(!old.highlight_dora);
        assert!(!old.sound);
    }

    #[test]
    fn u19_the_study_settings_are_saved_and_read_back() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        let saved = Settings {
            daily_count: 8,
            disagreement_percent: 10,
            highlight_dora: true,
            ..Settings::default()
        };
        saved.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded, saved);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"daily_count\": 8"), "{text}");
        assert!(text.contains("\"highlight_dora\": true"), "{text}");
    }

    #[test]
    fn u19_study_settings_outside_their_ranges_are_validated_and_a_file_with_such_values_falls_back(
    ) {
        for bad in [0, 51, 1000] {
            let s = Settings {
                daily_count: bad,
                ..Settings::default()
            };
            assert_eq!(s.validate(), Err(SettingsError::DailyCountOutOfRange(bad)));
        }
        for bad in [0, 51] {
            let s = Settings {
                disagreement_percent: bad,
                ..Settings::default()
            };
            assert_eq!(
                s.validate(),
                Err(SettingsError::DisagreementPercentOutOfRange(bad))
            );
        }
        for good in [1, 5, 50] {
            let s = Settings {
                daily_count: good,
                disagreement_percent: good,
                ..Settings::default()
            };
            assert_eq!(s.validate(), Ok(()));
        }
        // 手で書き換えた設定ファイルの範囲の外・型の違う値は、その項目だけ既定値にする（ほかの項目は守る）
        let s = Settings::from_json_str(
            r#"{ "daily_count": 0, "disagreement_percent": "five", "highlight_dora": true, "sound": false }"#,
        )
        .unwrap();
        assert_eq!(s.daily_count, 5);
        assert_eq!(s.disagreement_percent, 5);
        assert!(s.highlight_dora);
        assert!(!s.sound);
        assert!(SettingsError::DailyCountOutOfRange(0)
            .to_string()
            .contains("1 から 50"));
    }

    #[test]
    fn u21_the_replay_settings_default_to_big_mismatches_only_and_the_keys_of_round_10() {
        let s = Settings::default();
        assert!(!s.show_all_mismatches);
        assert_eq!(s.replay_keys, replay_keys::default_keys());
        assert_eq!(s.replay_keys["step_back"].as_deref(), Some("Comma"));
        assert_eq!(
            s.replay_keys["next_kyoku"].as_deref(),
            Some("Shift+ArrowRight")
        );
        assert_eq!(s.replay_keys["next_turn"], None);
        // 局の頭・局の終わりは、Home・End（R11-4）
        assert_eq!(s.replay_keys["kyoku_start"].as_deref(), Some("Home"));
        assert_eq!(s.replay_keys["kyoku_end"].as_deref(), Some("End"));
        // 昔の設定ファイル（この 2 つの項目が無い）は、既定値
        let old = Settings::from_json_str(r#"{ "sound": false, "highlight_dora": true }"#).unwrap();
        assert!(!old.show_all_mismatches);
        assert_eq!(old.replay_keys, replay_keys::default_keys());
        assert!(old.highlight_dora);
        assert_eq!(s.validate(), Ok(()));
    }

    #[test]
    fn u21_the_replay_settings_are_saved_and_read_back_so_they_survive_a_restart() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        let mut keys = replay_keys::default_keys();
        keys.insert("step_back".into(), Some("KeyJ".into()));
        keys.insert("step_forward".into(), Some("KeyL".into()));
        keys.insert("prev_turn".into(), Some("Shift+Comma".into()));
        keys.insert("next_kyoku".into(), None);
        let saved = Settings {
            show_all_mismatches: true,
            replay_keys: keys,
            ..Settings::default()
        };
        assert_eq!(saved.validate(), Ok(()));
        saved.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded, saved);
        assert!(loaded.show_all_mismatches);
        assert_eq!(loaded.replay_keys["step_back"].as_deref(), Some("KeyJ"));
        assert_eq!(
            loaded.replay_keys["prev_turn"].as_deref(),
            Some("Shift+Comma")
        );
        assert_eq!(loaded.replay_keys["next_kyoku"], None);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"show_all_mismatches\": true"), "{text}");
        assert!(text.contains("\"step_back\": \"KeyJ\""), "{text}");
        assert!(text.contains("\"next_kyoku\": null"), "{text}");
    }

    #[test]
    fn u21_home_and_end_reach_a_settings_file_written_before_they_were_the_defaults() {
        // 版 1 のアプリが書いた設定ファイル: 割り当ての表は全部の操作が入り、局の頭・終わりは、既定の null
        let old = r#"{ "sound": false, "show_all_mismatches": true,
            "replay_keys": { "step_back": "KeyJ", "step_forward": "Period",
              "prev_decision": "ArrowLeft", "next_decision": "ArrowRight",
              "prev_mismatch": "ArrowUp", "next_mismatch": "ArrowDown",
              "prev_doubt": "Shift+ArrowUp", "next_doubt": "Shift+ArrowDown",
              "prev_kyoku": "Shift+ArrowLeft", "next_kyoku": "Shift+ArrowRight",
              "prev_turn": null, "next_turn": null, "kyoku_start": null, "kyoku_end": null } }"#;
        let s = Settings::from_json_str(old).unwrap().normalized();
        assert_eq!(s.replay_keys["kyoku_start"].as_deref(), Some("Home"));
        assert_eq!(s.replay_keys["kyoku_end"].as_deref(), Some("End"));
        // 書いてあったキーと、ほかの設定は守る
        assert_eq!(s.replay_keys["step_back"].as_deref(), Some("KeyJ"));
        assert_eq!(s.replay_keys["next_turn"], None);
        assert!(s.show_all_mismatches);
        assert!(!s.sound);
        assert_eq!(s.replay_keys_revision, replay_keys::KEYS_REVISION);
        assert_eq!(s.validate(), Ok(()));
    }

    #[test]
    fn u21_a_key_cleared_after_the_change_stays_cleared_through_save_and_load() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        // 局の頭を外して保存する → 読み直しても外れたまま（版が書いてあるので、「書いていない」とは読まれない）
        let mut s = Settings::default();
        s.replay_keys.insert("kyoku_start".into(), None);
        s.save(&path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"kyoku_start\": null"), "{text}");
        assert!(text.contains("\"kyoku_end\": \"End\""), "{text}");
        assert!(
            text.contains(&format!(
                "\"replay_keys_revision\": {}",
                replay_keys::KEYS_REVISION
            )),
            "{text}"
        );
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded.replay_keys["kyoku_start"], None);
        assert_eq!(loaded.replay_keys["kyoku_end"].as_deref(), Some("End"));
        // もう一度保存して読み直しても、同じ
        loaded.save(&path).unwrap();
        assert_eq!(Settings::load(&path).unwrap(), loaded);
        // 版を持たずに保存された設定（画面から版が落ちて届いた設定）も、保存のときに、いまの版にそろえる
        let mut stale = Settings::default();
        stale.replay_keys.insert("kyoku_end".into(), None);
        stale.replay_keys_revision = 0;
        let stale = stale.normalized();
        assert_eq!(stale.replay_keys_revision, replay_keys::KEYS_REVISION);
        stale.save(&path).unwrap();
        assert_eq!(
            Settings::load(&path).unwrap().replay_keys["kyoku_end"],
            None
        );
    }

    #[test]
    fn u21_replay_keys_that_cannot_be_used_are_refused_when_saving_and_a_broken_file_falls_back() {
        // 保存: 同じキーを 2 つの操作に（入れ替えない）・割り当てられないキーは、理由つきで断る
        let mut twice = Settings::default();
        twice
            .replay_keys
            .insert("prev_turn".into(), Some("Comma".into()));
        let error = twice.validate().unwrap_err();
        assert!(matches!(
            error,
            SettingsError::ReplayKeys(ReplayKeysError::DuplicateKey { .. })
        ));
        assert!(error.to_string().contains("2 つの操作"), "{error}");
        for reserved in ["Alt+ArrowLeft", "Ctrl+KeyK", "Escape", "Ctrl+KeyZ"] {
            let mut s = Settings::default();
            s.replay_keys
                .insert("step_back".into(), Some(reserved.into()));
            let error = s.validate().unwrap_err();
            assert!(
                matches!(
                    error,
                    SettingsError::ReplayKeys(ReplayKeysError::ReservedKey { .. })
                ),
                "{reserved}"
            );
        }
        // 読み込み: 手で書き換えたファイルは、その項目だけ（重なり・割り当てられないキーはキーの全部）既定に戻り、ほかの設定は守る
        let s = Settings::from_json_str(
            r#"{ "sound": false, "show_all_mismatches": true,
                 "replay_keys": { "step_back": "KeyJ", "step_forward": "KeyJ" } }"#,
        )
        .unwrap();
        assert_eq!(s.replay_keys, replay_keys::default_keys());
        assert!(s.show_all_mismatches);
        assert!(!s.sound);
        let s = Settings::from_json_str(r#"{ "show_all_mismatches": "yes", "replay_keys": 3 }"#)
            .unwrap();
        assert!(!s.show_all_mismatches);
        assert_eq!(s.replay_keys, replay_keys::default_keys());
    }

    #[test]
    fn w5_missing_file_gives_defaults() {
        let dir = temp_dir();
        let s = Settings::load(&settings_path(dir.path())).unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn w5_orientation_and_position_survive_save_and_load() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        let saved = Settings {
            orientation: Orientation::Horizontal,
            widget_position: Some(WidgetPosition { x: -1800, y: 240 }),
            trigger: Trigger::key("F8"),
            sound: false,
            ..Settings::default()
        };
        saved.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded, saved);
        assert_eq!(loaded.orientation, Orientation::Horizontal);
        assert_eq!(
            loaded.widget_position,
            Some(WidgetPosition { x: -1800, y: 240 })
        );
    }

    #[test]
    fn w5_missing_fields_fall_back_to_defaults() {
        let s = Settings::from_json_str(r#"{ "orientation": "horizontal" }"#).unwrap();
        assert_eq!(s.orientation, Orientation::Horizontal);
        assert_eq!(s.trigger, Trigger::MouseX1);
        assert!(s.sound);
        assert_eq!(s.capture_keywords, vec!["雀魂", "Mahjong Soul"]);
        assert_eq!(s.data_dir, default_data_dir());
    }

    #[test]
    fn w5_empty_object_gives_defaults() {
        assert_eq!(Settings::from_json_str("{}").unwrap(), Settings::default());
    }

    #[test]
    fn w5_unreadable_field_does_not_discard_the_others() {
        let s = Settings::from_json_str(
            r#"{ "orientation": "diagonal", "sound": false, "trigger": { "kind": "mouse_x2" } }"#,
        )
        .unwrap();
        assert_eq!(s.orientation, Orientation::Vertical);
        assert!(!s.sound);
        assert_eq!(s.trigger, Trigger::MouseX2);
    }

    #[test]
    fn w5_broken_json_is_recovered_and_backed_up() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        fs::write(&path, "{ not json").unwrap();
        let (s, note) = Settings::load_or_recover(&path);
        assert_eq!(s, Settings::default());
        assert!(note.is_some());
        assert!(!path.exists());
        assert!(path.with_extension("json.broken").exists());
    }

    #[test]
    fn w5_a_settings_file_with_a_utf8_bom_is_read_not_backed_up() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        fs::write(
            &path,
            "\u{feff}{\"orientation\":\"horizontal\",\"sound\":false}",
        )
        .unwrap();
        let (s, note) = Settings::load_or_recover(&path);
        assert!(note.is_none());
        assert_eq!(s.orientation, Orientation::Horizontal);
        assert!(!s.sound);
        assert!(path.exists());
        assert!(!path.with_extension("json.broken").exists());
    }

    #[test]
    fn w5_save_leaves_no_temp_file() {
        let dir = temp_dir();
        let path = settings_path(dir.path());
        Settings::default().save(&path).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![SETTINGS_FILE_NAME.to_string()]);
    }

    #[test]
    fn keywords_are_trimmed_deduplicated_and_empty_ones_dropped() {
        let s = Settings {
            capture_keywords: vec![
                "  雀魂 ".into(),
                "".into(),
                "   ".into(),
                "Mahjong Soul".into(),
                "mahjong soul".into(),
            ],
            ..Settings::default()
        }
        .normalized();
        assert_eq!(s.capture_keywords, vec!["雀魂", "Mahjong Soul"]);
    }

    #[test]
    fn unsupported_key_is_rejected_and_supported_key_is_accepted() {
        let bad = Settings {
            trigger: Trigger::key("NoSuchKey"),
            ..Settings::default()
        };
        assert_eq!(
            bad.validate(),
            Err(SettingsError::UnsupportedKey("NoSuchKey".into()))
        );
        let good = Settings {
            trigger: Trigger::key("F8"),
            ..Settings::default()
        };
        assert_eq!(good.validate(), Ok(()));
        assert_eq!(Settings::default().validate(), Ok(()));
    }

    #[test]
    fn default_data_dir_is_under_the_user_profile() {
        let dir = default_data_dir_from(Some(OsString::from(r"C:\Users\someone")));
        assert_eq!(
            dir,
            PathBuf::from(r"C:\Users\someone").join("JantamaReviewerData")
        );
        assert_eq!(
            default_data_dir_from(None),
            PathBuf::from(DEFAULT_DATA_DIR_NAME)
        );
    }

    #[test]
    fn default_data_dir_is_directly_under_the_home_folder_on_macos_too() {
        // macOS: USERPROFILE は無く、HOME（`/Users/<名前>`）を使う。`~/Library/Application Support` の下には置かない。
        let dir = default_data_dir_from(Some(OsString::from("/Users/someone")));
        assert_eq!(dir.parent(), Some(Path::new("/Users/someone")));
        assert_eq!(
            dir.file_name(),
            Some(OsString::from("JantamaReviewerData").as_os_str())
        );
        assert!(!dir.to_string_lossy().contains("Library"));
    }

    #[test]
    fn trigger_json_shape_is_stable() {
        assert_eq!(
            serde_json::to_string(&Trigger::MouseX1).unwrap(),
            r#"{"kind":"mouse_x1"}"#
        );
        assert_eq!(
            serde_json::to_string(&Trigger::key("F8")).unwrap(),
            r#"{"kind":"key","code":"F8"}"#
        );
    }

    #[test]
    fn w10_a_key_with_modifiers_is_saved_with_only_the_flags_that_are_set() {
        let trigger = Trigger::key_with("KeyM", Modifiers::new(true, true, false, false));
        let json = serde_json::to_string(&trigger).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"key","code":"KeyM","ctrl":true,"alt":true}"#
        );
        assert_eq!(serde_json::from_str::<Trigger>(&json).unwrap(), trigger);
    }

    #[test]
    fn w10_settings_files_from_before_modifiers_still_load() {
        // 昔の形（修飾キーの印が無い）は、修飾キー無しのキーとして読む。
        let s =
            Settings::from_json_str(r#"{ "trigger": { "kind": "key", "code": "F8" } }"#).unwrap();
        assert_eq!(s.trigger, Trigger::key("F8"));
        for old in [
            r#"{ "trigger": { "kind": "mouse_x1" } }"#,
            r#"{ "trigger": { "kind": "mouse_x2" } }"#,
            r#"{ "trigger": { "kind": "mouse_middle" } }"#,
        ] {
            let loaded = Settings::from_json_str(old).unwrap();
            assert!(loaded.trigger.to_active().is_some(), "{old}");
        }
    }

    #[test]
    fn w10_a_registered_input_becomes_a_setting_and_back() {
        let ctrl_alt_m = ActiveTrigger::key(0x4D, Modifiers::new(true, true, false, false));
        let trigger = Trigger::from_active(ctrl_alt_m).unwrap();
        assert_eq!(
            trigger,
            Trigger::key_with("KeyM", Modifiers::new(true, true, false, false))
        );
        assert_eq!(trigger.to_active(), Some(ctrl_alt_m));
        assert_eq!(
            Trigger::from_active(ActiveTrigger::key(0x7C, Modifiers::NONE)),
            Some(Trigger::key("F13"))
        );
        for (button, expected) in [
            (MouseButton::X1, Trigger::MouseX1),
            (MouseButton::X2, Trigger::MouseX2),
            (MouseButton::Middle, Trigger::MouseMiddle),
        ] {
            let trigger = Trigger::from_active(ActiveTrigger::Mouse(button)).unwrap();
            assert_eq!(trigger, expected);
            assert_eq!(trigger.to_active(), Some(ActiveTrigger::Mouse(button)));
        }
        // 左右のボタン・割り当てられないキーは、設定にしない。
        assert_eq!(
            Trigger::from_active(ActiveTrigger::Mouse(MouseButton::Left)),
            None
        );
        assert_eq!(
            Trigger::from_active(ActiveTrigger::Mouse(MouseButton::Right)),
            None
        );
        assert_eq!(
            Trigger::from_active(ActiveTrigger::key(0x1B, Modifiers::NONE)),
            None
        );
        assert_eq!(Trigger::key("NoSuchKey").to_active(), None);
    }

    #[test]
    fn w10_a_key_with_modifiers_in_the_settings_is_validated_by_its_key() {
        let ok = Settings {
            trigger: Trigger::key_with("KeyM", Modifiers::new(true, true, false, false)),
            ..Settings::default()
        };
        assert_eq!(ok.validate(), Ok(()));
        let bad = Settings {
            trigger: Trigger::key_with("Enter", Modifiers::new(true, false, false, false)),
            ..Settings::default()
        };
        assert!(bad.validate().is_err());
    }
}
