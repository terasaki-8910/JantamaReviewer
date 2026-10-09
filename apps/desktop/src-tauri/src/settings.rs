//! 設定。JSON で保存し、欠けた項目は既定値で補う（W-5）。
//!
//! 保存する項目: 迷いマークのボタン（マウスのボタン、または修飾キー付きのキー）、ウィジェットの形と位置、音、
//! 雀魂の窓を探す語、データの保存先。

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use jantama_input::keys::{code_from_vk, vk_from_code, Modifiers};
use jantama_input::logic::{ActiveTrigger, MouseButton};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 雀魂の窓を探す語の既定値（W-7）。
pub const DEFAULT_CAPTURE_KEYWORDS: [&str; 2] = ["雀魂", "Mahjong Soul"];

/// 設定ファイルの名前。
pub const SETTINGS_FILE_NAME: &str = "settings.json";

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
    pub capture_keywords: Vec<String>,
    pub data_dir: PathBuf,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            trigger: Trigger::default(),
            orientation: Orientation::default(),
            widget_position: None,
            sound: true,
            capture_keywords: DEFAULT_CAPTURE_KEYWORDS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            data_dir: default_data_dir(),
        }
    }
}

/// 設定の値が使えないときの理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsError {
    /// 割り当てられないキー。
    UnsupportedKey(String),
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettingsError::UnsupportedKey(code) => {
                write!(f, "このキーは割り当てられません: {code}")
            }
        }
    }
}

impl std::error::Error for SettingsError {}

/// データの保存先の既定: `%USERPROFILE%\JantamaReviewerData`。
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
            capture_keywords: field(value, "capture_keywords").unwrap_or(defaults.capture_keywords),
            data_dir: data_dir.unwrap_or(defaults.data_dir),
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
        self
    }

    /// 使えない値が入っていないかを確かめる。
    pub fn validate(&self) -> Result<(), SettingsError> {
        if let Trigger::Key { code, .. } = &self.trigger {
            if vk_from_code(code).is_none() {
                return Err(SettingsError::UnsupportedKey(code.clone()));
            }
        }
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
