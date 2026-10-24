//! 右クリックのメニュー（ウィジェット）とタスクトレイのメニュー。同じ項目を出す。
//!
//! 並びは承認済みの見本（round7-samples/menu.html）どおり:
//! 新しい半荘・縦長と横長の切り替え / 音を鳴らす（入・切の印つき）・検討画面を開く / 終了。
//! 「音を鳴らす」は、設定のチェックと同じ設定（`Settings::sound`）を切り替える（W-12）。
//!
//! 迷いだけ（`Settings::doubt_only`。W-15）が入のときは、形の切り替えを出さず、その場所に「取り消し」を置く
//! （ウィジェットが 48px 角の「迷い」ボタン 1 つで、取り消しのボタンが無いため）。「取り消し」は、最後の記録が無いとき押せない。
//! 2 つのメニューの項目は、設定が変わったとき（設定のチェックからも、同期からも）と、記録の状態が変わったときに、その場で合わせる。
//!
//! macOS のアプリのメニュー（メニューバー。`mac_app_menu`）も、ここで作る。Quit（Cmd+Q）と、入力欄の取り消し・切り取り・
//! コピー・貼り付け・すべてを選択（Cmd+Z/X/C/V/A）に要る編集のメニュー、窓のメニューだけで、
//! ブラウザの機能（再読み込み・印刷・検索）は入れない。

use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands;

pub const MENU_NEW_SESSION: &str = "new_session";
pub const MENU_TOGGLE_ORIENTATION: &str = "toggle_orientation";
pub const MENU_UNDO: &str = "undo";
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

/// メニューの並び（上から順）。迷いだけが切のとき。ウィジェットの右クリックとタスクトレイで、同じものを使う。
pub const MENU_LAYOUT: [Entry; 7] = [
    Entry::Item(MENU_NEW_SESSION, "新しい半荘"),
    Entry::Item(MENU_TOGGLE_ORIENTATION, "縦長と横長を切り替える"),
    Entry::Separator,
    Entry::Check(MENU_TOGGLE_SOUND, "音を鳴らす"),
    Entry::Item(MENU_OPEN_MAIN, "検討画面を開く"),
    Entry::Separator,
    Entry::Item(MENU_QUIT, "終了"),
];

/// メニューの並び（上から順）。迷いだけが入のとき（W-15）。形の切り替えは出さず、同じ場所に「取り消し」を置く。
pub const MENU_LAYOUT_DOUBT_ONLY: [Entry; 7] = [
    Entry::Item(MENU_NEW_SESSION, "新しい半荘"),
    Entry::Item(MENU_UNDO, "取り消し"),
    Entry::Separator,
    Entry::Check(MENU_TOGGLE_SOUND, "音を鳴らす"),
    Entry::Item(MENU_OPEN_MAIN, "検討画面を開く"),
    Entry::Separator,
    Entry::Item(MENU_QUIT, "終了"),
];

/// 迷いだけの入・切に合わせたメニューの並び。
pub fn menu_layout(doubt_only: bool) -> &'static [Entry] {
    if doubt_only {
        &MENU_LAYOUT_DOUBT_ONLY
    } else {
        &MENU_LAYOUT
    }
}

/// 2 番目に置く、迷いだけの入・切で入れ替わる項目（どちらの並びでも、新しい半荘の次）。
const SWAP_POSITION: usize = 1;

/// メニューの中で、迷いだけの入・切に合わせて入れ替わる 2 つの項目（「取り消し」と「縦長と横長を切り替える」）。
/// 入れ替えは、メニューを作り直さずに、項目の出し入れで行う（メニューは、開いたままのトレイにも付いているため）。
pub struct ModeItems<R: Runtime> {
    menu: Menu<R>,
    undo: MenuItem<R>,
    orientation: MenuItem<R>,
    /// 「取り消し」を最後に合わせた、押せる・押せない。`None` は分からない（同じ値を重ねて合わせないために覚える）。
    undo_enabled: Mutex<Option<bool>>,
}

/// 「取り消し」の押せる・押せないを、`now` に合わせ直す必要があるか。`last` は、最後に合わせた値（分からなければ `None`）。
fn needs_update(last: Option<bool>, now: bool) -> bool {
    last != Some(now)
}

/// 覚えてある値と違うときだけ `apply` で合わせ、合わせられたら覚え直す（失敗したら「分からない」に戻す）。
/// 項目を合わせるには本体のスレッドの手が空くのを待つので、錠は `apply` の間は持たない
/// （本体のスレッドが、メニューの操作から同じ錠を取ろうとして待つと、お互いに待って止まる）。
fn apply_when_needed<E>(
    remembered: &Mutex<Option<bool>>,
    now: bool,
    apply: impl FnOnce(bool) -> Result<(), E>,
) -> Result<(), E> {
    if !needs_update(*lock_remembered(remembered), now) {
        return Ok(());
    }
    let result = apply(now);
    *lock_remembered(remembered) = result.as_ref().ok().map(|_| now);
    result
}

/// 別のスレッドが途中で止まっていても、メニューを合わせ続けられるよう、毒された錠は使い続ける。
fn lock_remembered(remembered: &Mutex<Option<bool>>) -> MutexGuard<'_, Option<bool>> {
    remembered.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<R: Runtime> ModeItems<R> {
    /// 迷いだけの入・切に合わせて、どちらかの項目を出し、もう一方を外す。いまの状態と同じなら、何もしない。
    pub fn set_doubt_only(&self, doubt_only: bool) -> tauri::Result<()> {
        let (show, show_id, hide, hide_id) = if doubt_only {
            (
                &self.undo,
                MENU_UNDO,
                &self.orientation,
                MENU_TOGGLE_ORIENTATION,
            )
        } else {
            (
                &self.orientation,
                MENU_TOGGLE_ORIENTATION,
                &self.undo,
                MENU_UNDO,
            )
        };
        // 出し入れしたあとの「取り消し」の押せる・押せないは、覚えている値と同じとは限らないので、次は必ず合わせ直す。
        *lock_remembered(&self.undo_enabled) = None;
        if self.menu.get(hide_id).is_some() {
            self.menu.remove(hide)?;
        }
        if self.menu.get(show_id).is_none() {
            self.menu.insert(show, SWAP_POSITION)?;
        }
        Ok(())
    }

    /// 「取り消し」を押せるか（取り消せる記録があるか）に合わせる。覚えている値と同じなら、何もしない。
    pub fn set_can_undo(&self, can_undo: bool) -> tauri::Result<()> {
        apply_when_needed(&self.undo_enabled, can_undo, |value| {
            self.undo.set_enabled(value)
        })
    }
}

/// 作ったメニューと、その中の、設定や記録の状態が変わったときに合わせる項目。
pub struct BuiltMenu<R: Runtime> {
    pub menu: Menu<R>,
    /// 「音を鳴らす」（設定が変わったときに、印を合わせる）。
    pub sound: CheckMenuItem<R>,
    /// 迷いだけの入・切で入れ替わる項目と、「取り消し」の押せる・押せない。
    pub mode: ModeItems<R>,
}

/// メニューを作る。ウィジェットの右クリックとトレイで、別々に作って使う。
/// `sound` は、いまの音の設定。`doubt_only` は、いまの迷いだけの設定。`can_undo` は、取り消せる記録があるか。
pub fn build_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    sound: bool,
    doubt_only: bool,
    can_undo: bool,
) -> tauri::Result<BuiltMenu<R>> {
    let menu = Menu::new(manager)?;
    // 入れ替わる 2 つの項目は、どちらの並びでも使うので、先に作っておく（並びに無い方は、メニューに入れない）。
    let undo = MenuItem::with_id(manager, MENU_UNDO, "取り消し", can_undo, None::<&str>)?;
    let orientation = MenuItem::with_id(
        manager,
        MENU_TOGGLE_ORIENTATION,
        "縦長と横長を切り替える",
        true,
        None::<&str>,
    )?;
    let mut sound_item = None;
    for entry in menu_layout(doubt_only) {
        match *entry {
            Entry::Item(MENU_UNDO, _) => menu.append(&undo)?,
            Entry::Item(MENU_TOGGLE_ORIENTATION, _) => menu.append(&orientation)?,
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
    let mode = ModeItems {
        menu: menu.clone(),
        undo,
        orientation,
        // 「取り消し」は、`can_undo` で作ったばかり
        undo_enabled: Mutex::new(Some(can_undo)),
    };
    Ok(BuiltMenu { menu, sound, mode })
}

/// macOS のアプリのメニューに入れる、標準の項目（動きは macOS が持っている）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacItem {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    BringAllToFront,
    CloseWindow,
}

/// macOS のアプリのメニューの 1 行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacEntry {
    /// 標準の項目（表示の文字）。
    Item(MacItem, &'static str),
    /// 区切り線。
    Separator,
}

/// macOS のアプリのメニューの 1 つ分（メニューバーの 1 つの項目）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacMenu {
    /// 題名。`None` はアプリの名前（最初のメニューは、macOS が、アプリの名前で出す）。
    pub title: Option<&'static str>,
    pub entries: &'static [MacEntry],
}

/// macOS のアプリのメニューの並び（左から順）。表示の文字は、アプリの文言と同じ日本語。
pub const MAC_MENUS: [MacMenu; 3] = [
    MacMenu {
        title: None,
        entries: &[
            MacEntry::Item(MacItem::About, "JantamaReviewer について"),
            MacEntry::Separator,
            MacEntry::Item(MacItem::Services, "サービス"),
            MacEntry::Separator,
            MacEntry::Item(MacItem::Hide, "JantamaReviewer を隠す"),
            MacEntry::Item(MacItem::HideOthers, "ほかを隠す"),
            MacEntry::Item(MacItem::ShowAll, "すべてを表示"),
            MacEntry::Separator,
            MacEntry::Item(MacItem::Quit, "JantamaReviewer を終了"),
        ],
    },
    MacMenu {
        title: Some("編集"),
        entries: &[
            MacEntry::Item(MacItem::Undo, "取り消す"),
            MacEntry::Item(MacItem::Redo, "やり直す"),
            MacEntry::Separator,
            MacEntry::Item(MacItem::Cut, "カット"),
            MacEntry::Item(MacItem::Copy, "コピー"),
            MacEntry::Item(MacItem::Paste, "ペースト"),
            MacEntry::Item(MacItem::SelectAll, "すべてを選択"),
        ],
    },
    MacMenu {
        title: Some("ウインドウ"),
        entries: &[
            MacEntry::Item(MacItem::Minimize, "しまう"),
            MacEntry::Item(MacItem::Zoom, "拡大/縮小"),
            MacEntry::Separator,
            MacEntry::Item(MacItem::BringAllToFront, "すべてを手前に移動"),
            MacEntry::Item(MacItem::CloseWindow, "ウインドウを閉じる"),
        ],
    },
];

fn mac_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    item: MacItem,
    label: &str,
) -> tauri::Result<PredefinedMenuItem<R>> {
    let text = Some(label);
    match item {
        MacItem::About => PredefinedMenuItem::about(manager, text, None),
        MacItem::Services => PredefinedMenuItem::services(manager, text),
        MacItem::Hide => PredefinedMenuItem::hide(manager, text),
        MacItem::HideOthers => PredefinedMenuItem::hide_others(manager, text),
        MacItem::ShowAll => PredefinedMenuItem::show_all(manager, text),
        MacItem::Quit => PredefinedMenuItem::quit(manager, text),
        MacItem::Undo => PredefinedMenuItem::undo(manager, text),
        MacItem::Redo => PredefinedMenuItem::redo(manager, text),
        MacItem::Cut => PredefinedMenuItem::cut(manager, text),
        MacItem::Copy => PredefinedMenuItem::copy(manager, text),
        MacItem::Paste => PredefinedMenuItem::paste(manager, text),
        MacItem::SelectAll => PredefinedMenuItem::select_all(manager, text),
        MacItem::Minimize => PredefinedMenuItem::minimize(manager, text),
        MacItem::Zoom => PredefinedMenuItem::maximize(manager, text),
        MacItem::BringAllToFront => PredefinedMenuItem::bring_all_to_front(manager, text),
        MacItem::CloseWindow => PredefinedMenuItem::close_window(manager, text),
    }
}

/// macOS のアプリ全体のメニュー（メニューバー）を作る。
/// Windows では使わない（メニューバーが窓ごとに付いてしまう。`platform::with_app_menu`）。
pub fn mac_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for (index, spec) in MAC_MENUS.iter().enumerate() {
        let title = spec
            .title
            .map_or_else(|| app.package_info().name.clone(), str::to_string);
        // 最後のメニューは、窓のメニュー。この識別子だと、macOS が開いている窓の一覧を足してくれる。
        let submenu = if index == MAC_MENUS.len() - 1 {
            Submenu::with_id(app, WINDOW_SUBMENU_ID, title, true)?
        } else {
            Submenu::new(app, title, true)?
        };
        for entry in spec.entries {
            match entry {
                MacEntry::Item(item, label) => submenu.append(&mac_item(app, *item, label)?)?,
                MacEntry::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
            }
        }
        menu.append(&submenu)?;
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
        MENU_UNDO => {
            if let Err(e) = commands::undo_now(app) {
                eprintln!("最後の記録を取り消せませんでした: {e}");
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
    use std::cell::{Cell, RefCell};

    use super::*;

    fn labels_of(layout: &[Entry]) -> Vec<&'static str> {
        layout
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item(_, label) | Entry::Check(_, label) => Some(*label),
                Entry::Separator => None,
            })
            .collect()
    }

    fn labels() -> Vec<&'static str> {
        labels_of(&MENU_LAYOUT)
    }

    fn ids_of(layout: &[Entry]) -> Vec<&'static str> {
        layout
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item(id, _) | Entry::Check(id, _) => Some(*id),
                Entry::Separator => None,
            })
            .collect()
    }

    fn kinds_of(layout: &[Entry]) -> Vec<&'static str> {
        layout
            .iter()
            .map(|e| match e {
                Entry::Item(..) => "item",
                Entry::Check(..) => "check",
                Entry::Separator => "sep",
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
        // 迷いだけが切のときの並びは、これまでのまま
        assert_eq!(menu_layout(false), &MENU_LAYOUT[..]);
    }

    #[test]
    fn w12_the_sound_item_is_a_checkable_item_and_the_only_one() {
        for doubt_only in [false, true] {
            let checks: Vec<_> = menu_layout(doubt_only)
                .iter()
                .filter(|e| matches!(e, Entry::Check(..)))
                .collect();
            assert_eq!(
                checks,
                vec![&Entry::Check(MENU_TOGGLE_SOUND, "音を鳴らす")],
                "{doubt_only}"
            );
        }
    }

    #[test]
    fn w12_separators_group_the_items_like_the_approved_sample() {
        // 新しい半荘・形 | 音・検討画面 | 終了
        assert_eq!(
            kinds_of(&MENU_LAYOUT),
            vec!["item", "item", "sep", "check", "item", "sep", "item"]
        );
        // 迷いだけでも、同じ区切り（形の代わりに取り消しが、同じ組に入る）
        assert_eq!(kinds_of(&MENU_LAYOUT), kinds_of(&MENU_LAYOUT_DOUBT_ONLY));
    }

    #[test]
    fn w15_with_doubt_only_the_menu_offers_undo_and_no_shape_switch() {
        assert_eq!(
            labels_of(menu_layout(true)),
            vec![
                "新しい半荘",
                "取り消し",
                "音を鳴らす",
                "検討画面を開く",
                "終了"
            ]
        );
        let ids = ids_of(menu_layout(true));
        assert!(ids.contains(&MENU_UNDO));
        assert!(
            !ids.contains(&MENU_TOGGLE_ORIENTATION),
            "形の切り替えは出さない"
        );
        // 切のときは、取り消しを出さない（ウィジェットに取り消しのボタンがあるため）
        let ids = ids_of(menu_layout(false));
        assert!(!ids.contains(&MENU_UNDO));
        assert!(ids.contains(&MENU_TOGGLE_ORIENTATION));
    }

    #[test]
    fn w15_the_two_layouts_differ_only_in_the_one_swapped_item_and_it_sits_at_the_swap_position() {
        let off = menu_layout(false);
        let on = menu_layout(true);
        assert_eq!(off.len(), on.len());
        let differing: Vec<usize> = (0..off.len()).filter(|&i| off[i] != on[i]).collect();
        assert_eq!(
            differing,
            vec![SWAP_POSITION],
            "入れ替わるのは 2 番目の 1 つだけ"
        );
        assert_eq!(
            off[SWAP_POSITION],
            Entry::Item(MENU_TOGGLE_ORIENTATION, "縦長と横長を切り替える")
        );
        assert_eq!(on[SWAP_POSITION], Entry::Item(MENU_UNDO, "取り消し"));
        // 出し入れで入れ替えるとき（`ModeItems`）に入れる場所と、並びの場所が同じ
        assert_eq!(SWAP_POSITION, 1);
    }

    #[test]
    fn w15_the_undo_item_is_touched_only_when_the_value_differs_from_the_last_applied() {
        // まだ合わせていない（分からない）ときは、どちらの値でも合わせる
        assert!(needs_update(None, true));
        assert!(needs_update(None, false));
        // 最後に合わせた値と同じなら、合わせない。違えば合わせる
        assert!(!needs_update(Some(true), true));
        assert!(!needs_update(Some(false), false));
        assert!(needs_update(Some(true), false));
        assert!(needs_update(Some(false), true));
    }

    #[test]
    fn w15_repeating_the_same_value_does_not_apply_again() {
        // 起動したとき（取り消せる記録が無い）に作ったメニューは、その値で覚えてある
        let remembered = Mutex::new(Some(false));
        let applied = RefCell::new(Vec::new());
        let apply = |value: bool| -> Result<(), String> {
            applied.borrow_mut().push(value);
            Ok(())
        };
        // 迷いマークが続く間（取り消せる記録がある）は、最初の 1 回だけ合わせる
        for _ in 0..3 {
            apply_when_needed(&remembered, true, apply).unwrap();
        }
        assert_eq!(*applied.borrow(), vec![true]);
        // 取り消して記録が無くなったら、また 1 回だけ合わせる
        for _ in 0..3 {
            apply_when_needed(&remembered, false, apply).unwrap();
        }
        assert_eq!(*applied.borrow(), vec![true, false]);
        assert_eq!(*remembered.lock().unwrap(), Some(false));
    }

    #[test]
    fn w15_when_the_remembered_value_is_unknown_the_next_value_is_always_applied() {
        // 項目を出し入れしたあと（`set_doubt_only`）は「分からない」に戻すので、同じ値でも 1 回は合わせる
        let remembered = Mutex::new(None);
        let applied = Cell::new(0);
        let apply = |_: bool| -> Result<(), String> {
            applied.set(applied.get() + 1);
            Ok(())
        };
        apply_when_needed(&remembered, true, apply).unwrap();
        assert_eq!(applied.get(), 1);
        apply_when_needed(&remembered, true, apply).unwrap();
        assert_eq!(applied.get(), 1);
        *remembered.lock().unwrap() = None;
        apply_when_needed(&remembered, true, apply).unwrap();
        assert_eq!(applied.get(), 2);
    }

    #[test]
    fn w15_a_failed_apply_is_tried_again_with_the_same_value() {
        let remembered = Mutex::new(Some(false));
        let calls = Cell::new(0);
        let fail = |_: bool| -> Result<(), String> {
            calls.set(calls.get() + 1);
            Err("本体のスレッドに頼めなかった".to_string())
        };
        assert!(apply_when_needed(&remembered, true, fail).is_err());
        // 合わせられたか分からないので、覚えていない（元の値の false に戻さない）
        assert_eq!(*remembered.lock().unwrap(), None);
        // 同じ値でもう一度頼まれたら、もう一度合わせる。今度は通る
        let ok = |_: bool| -> Result<(), String> {
            calls.set(calls.get() + 1);
            Ok(())
        };
        apply_when_needed(&remembered, true, ok).unwrap();
        assert_eq!(calls.get(), 2);
        assert_eq!(*remembered.lock().unwrap(), Some(true));
    }

    #[test]
    fn w15_the_lock_is_not_held_while_the_item_is_being_applied() {
        // 合わせている間（本体のスレッドを待つ間）に、本体のスレッドが同じ錠を取りに来ても、待たされない
        let remembered = Mutex::new(Some(false));
        apply_when_needed(&remembered, true, |_| -> Result<(), String> {
            assert!(remembered.try_lock().is_ok());
            Ok(())
        })
        .unwrap();
    }

    fn mac_items(menu: &MacMenu) -> Vec<MacItem> {
        menu.entries
            .iter()
            .filter_map(|entry| match entry {
                MacEntry::Item(item, _) => Some(*item),
                MacEntry::Separator => None,
            })
            .collect()
    }

    fn mac_labels() -> Vec<&'static str> {
        let mut labels = Vec::new();
        for menu in &MAC_MENUS {
            labels.extend(menu.title);
            for entry in menu.entries {
                if let MacEntry::Item(_, label) = entry {
                    labels.push(*label);
                }
            }
        }
        labels
    }

    #[test]
    fn the_macos_menu_has_quit_and_the_edit_commands_inputs_need() {
        let app = mac_items(&MAC_MENUS[0]);
        assert!(app.contains(&MacItem::Quit), "Cmd+Q で終われる");
        assert!(app.contains(&MacItem::Hide));
        let edit = mac_items(&MAC_MENUS[1]);
        for needed in [
            MacItem::Undo,
            MacItem::Redo,
            MacItem::Cut,
            MacItem::Copy,
            MacItem::Paste,
            MacItem::SelectAll,
        ] {
            assert!(
                edit.contains(&needed),
                "{needed:?}: 入力欄の Cmd+Z/X/C/V/A に要る"
            );
        }
        assert!(mac_items(&MAC_MENUS[2]).contains(&MacItem::CloseWindow));
    }

    #[test]
    fn the_macos_menu_is_japanese_and_offers_no_browser_commands() {
        for label in mac_labels() {
            assert!(
                label
                    .chars()
                    .any(|c| matches!(c, '\u{3040}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}')),
                "日本語の文言: {label}"
            );
            for browser in [
                "再読み込み",
                "印刷",
                "検索",
                "ズーム",
                "開発者",
                "Reload",
                "Print",
                "Find",
            ] {
                assert!(
                    !label.contains(browser),
                    "ブラウザの機能は入れない（N-1）: {label}"
                );
            }
        }
        // 標準の項目は、どれも 1 回ずつ（同じ項目が 2 つあると、ショートカットが取り合いになる）。
        let mut all: Vec<MacItem> = MAC_MENUS.iter().flat_map(mac_items).collect();
        let total = all.len();
        all.sort_by_key(|item| format!("{item:?}"));
        all.dedup();
        assert_eq!(all.len(), total);
    }

    #[test]
    fn menu_ids_are_unique_in_both_layouts() {
        for doubt_only in [false, true] {
            let mut ids = ids_of(menu_layout(doubt_only));
            let total = ids.len();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), total, "{doubt_only}");
        }
    }
}
