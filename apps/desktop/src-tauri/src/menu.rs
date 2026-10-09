//! 右クリックのメニュー（ウィジェット）とタスクトレイのメニュー。同じ項目を出す。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands;

pub const MENU_NEW_SESSION: &str = "new_session";
pub const MENU_TOGGLE_ORIENTATION: &str = "toggle_orientation";
pub const MENU_OPEN_MAIN: &str = "open_main";
pub const MENU_QUIT: &str = "quit";

/// メニューの項目（並び順どおり）。「終了」の前に区切り線を入れる。
pub const MENU_ENTRIES: [(&str, &str); 4] = [
    (MENU_NEW_SESSION, "新しい半荘"),
    (MENU_TOGGLE_ORIENTATION, "縦長と横長を切り替える"),
    (MENU_OPEN_MAIN, "検討画面を開く"),
    (MENU_QUIT, "終了"),
];

/// メニューを作る。ウィジェットの右クリックとトレイで、別々に作って使う。
pub fn build_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(manager)?;
    for (id, label) in MENU_ENTRIES {
        if id == MENU_QUIT {
            menu.append(&PredefinedMenuItem::separator(manager)?)?;
        }
        menu.append(&MenuItem::with_id(manager, id, label, true, None::<&str>)?)?;
    }
    Ok(menu)
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
        MENU_OPEN_MAIN => commands::open_main_window_now(app),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_has_exactly_the_four_requested_items_in_order() {
        let labels: Vec<&str> = MENU_ENTRIES.iter().map(|(_, label)| *label).collect();
        assert_eq!(
            labels,
            vec![
                "新しい半荘",
                "縦長と横長を切り替える",
                "検討画面を開く",
                "終了"
            ]
        );
    }

    #[test]
    fn menu_ids_are_unique() {
        let mut ids: Vec<&str> = MENU_ENTRIES.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MENU_ENTRIES.len());
    }
}
