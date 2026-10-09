//! 右クリックのメニュー（ウィジェット）とタスクトレイのメニュー。同じ項目を出す。
//!
//! 並びは承認済みの見本（round7-samples/menu.html）どおり:
//! 新しい半荘・縦長と横長の切り替え / 音を鳴らす（入・切の印つき）・検討画面を開く / 終了。
//! 「音を鳴らす」は、設定のチェックと同じ設定（`Settings::sound`）を切り替える（W-12）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands;

pub const MENU_NEW_SESSION: &str = "new_session";
pub const MENU_TOGGLE_ORIENTATION: &str = "toggle_orientation";
pub const MENU_TOGGLE_SOUND: &str = "toggle_sound";
pub const MENU_OPEN_MAIN: &str = "open_main";
pub const MENU_QUIT: &str = "quit";

/// メニューの 1 行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// 押すと動く項目（id と表示）。
    Item(&'static str, &'static str),
    /// 入・切の印がつく項目（id と表示）。
    Check(&'static str, &'static str),
    /// 区切り線。
    Separator,
}

/// メニューの並び（上から順）。ウィジェットの右クリックとタスクトレイで、同じものを使う。
pub const MENU_LAYOUT: [Entry; 7] = [
    Entry::Item(MENU_NEW_SESSION, "新しい半荘"),
    Entry::Item(MENU_TOGGLE_ORIENTATION, "縦長と横長を切り替える"),
    Entry::Separator,
    Entry::Check(MENU_TOGGLE_SOUND, "音を鳴らす"),
    Entry::Item(MENU_OPEN_MAIN, "検討画面を開く"),
    Entry::Separator,
    Entry::Item(MENU_QUIT, "終了"),
];

/// 作ったメニューと、その中の「音を鳴らす」の項目（設定が変わったときに、印を合わせるため）。
pub struct BuiltMenu<R: Runtime> {
    pub menu: Menu<R>,
    pub sound: CheckMenuItem<R>,
}

/// メニューを作る。ウィジェットの右クリックとトレイで、別々に作って使う。`sound` は、いまの音の設定。
pub fn build_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    sound: bool,
) -> tauri::Result<BuiltMenu<R>> {
    let menu = Menu::new(manager)?;
    let mut sound_item = None;
    for entry in MENU_LAYOUT {
        match entry {
            Entry::Item(id, label) => {
                menu.append(&MenuItem::with_id(manager, id, label, true, None::<&str>)?)?
            }
            Entry::Check(id, label) => {
                let item = CheckMenuItem::with_id(manager, id, label, true, sound, None::<&str>)?;
                menu.append(&item)?;
                sound_item = Some(item);
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(manager)?)?,
        }
    }
    let sound = sound_item.ok_or_else(|| {
        tauri::Error::Io(std::io::Error::other(
            "メニューに「音を鳴らす」の項目がありません",
        ))
    })?;
    Ok(BuiltMenu { menu, sound })
}

/// メニューの項目が選ばれたときの動き。
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_NEW_SESSION => {
            if let Err(e) = commands::new_session_now(app) {
                eprintln!("新しい半荘を始められませんでした: {e}");
            }
        }
        MENU_TOGGLE_ORIENTATION => {
            if let Err(e) = commands::toggle_orientation_now(app) {
                eprintln!("ウィジェットの形を切り替えられませんでした: {e}");
            }
        }
        MENU_TOGGLE_SOUND => {
            if let Err(e) = commands::toggle_sound_now(app) {
                eprintln!("音の入・切を切り替えられませんでした: {e}");
            }
        }
        MENU_OPEN_MAIN => commands::open_main_window_now(app),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> Vec<&'static str> {
        MENU_LAYOUT
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item(_, label) | Entry::Check(_, label) => Some(*label),
                Entry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn w12_the_menu_has_the_requested_items_in_the_approved_order() {
        assert_eq!(
            labels(),
            vec![
                "新しい半荘",
                "縦長と横長を切り替える",
                "音を鳴らす",
                "検討画面を開く",
                "終了"
            ]
        );
    }

    #[test]
    fn w12_the_sound_item_is_a_checkable_item_and_the_only_one() {
        let checks: Vec<_> = MENU_LAYOUT
            .iter()
            .filter(|e| matches!(e, Entry::Check(..)))
            .collect();
        assert_eq!(checks, vec![&Entry::Check(MENU_TOGGLE_SOUND, "音を鳴らす")]);
    }

    #[test]
    fn w12_separators_group_the_items_like_the_approved_sample() {
        // 新しい半荘・形 | 音・検討画面 | 終了
        let kinds: Vec<&str> = MENU_LAYOUT
            .iter()
            .map(|e| match e {
                Entry::Item(..) => "item",
                Entry::Check(..) => "check",
                Entry::Separator => "sep",
            })
            .collect();
        assert_eq!(
            kinds,
            vec!["item", "item", "sep", "check", "item", "sep", "item"]
        );
    }

    #[test]
    fn menu_ids_are_unique() {
        let mut ids: Vec<&str> = MENU_LAYOUT
            .iter()
            .filter_map(|e| match e {
                Entry::Item(id, _) | Entry::Check(id, _) => Some(*id),
                Entry::Separator => None,
            })
            .collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }
}
