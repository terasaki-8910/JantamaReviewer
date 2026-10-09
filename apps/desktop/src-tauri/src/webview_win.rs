//! WebView2 への設定の書き込み（Windows 専用。N-1〜N-12）。
//!
//! 何を書くかは `webview_policy::WebviewFlags`（純粋な記述）が決める。ここは、それを WebView2 の COM の
//! 設定に書き込む薄い層（`Webview2Settings`）と、右クリックのメニューを絞る処理だけを持つ。
//! Tauri が公式に出している設定（`zoom_hotkeys_enabled`・`general_autofill_enabled`・`devtools`・
//! `on_navigation`・`on_new_window`・`on_download`）は窓を作るときに渡す（`widget_window::build_window`）。
//! ここで書くのは、Tauri が出していないものだけ。ただし、実際に効いているかを読み戻して確かめるために、
//! 全項目を書いて読み戻す。
//!
//! COM の呼び出しは、Tauri が窓のスレッドで呼ぶ `with_webview` の中で行う。
//! webview2-com は Tauri（wry）が使う版（0.39）にそろえている。

use tauri::{Runtime, WebviewWindow};
use webview2_com::take_pwstr;
use webview2_com::ContextMenuRequestedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Settings,
    ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5, ICoreWebView2Settings6,
    ICoreWebView2_11, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND,
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
};
use windows::core::{Interface, BOOL, PWSTR};

use crate::webview_policy::{
    apply_flags, plan_context_menu, ContextMenuPlan, MenuItemInfo, Setting, SettingsAccess,
    WebviewFlags,
};

fn describe(error: windows::core::Error) -> String {
    format!("{error}")
}

/// WebView2 の設定（`ICoreWebView2Settings` と、その上位のインターフェース）。
struct Webview2Settings {
    settings: ICoreWebView2Settings,
}

impl Webview2Settings {
    fn cast<T: Interface>(&self) -> Result<T, String> {
        self.settings
            .cast::<T>()
            .map_err(|e| format!("この WebView2 は対応していません（{e}）"))
    }
}

/// 読み戻した BOOL を bool にする。
fn read(result: windows::core::Result<()>, value: BOOL) -> Result<bool, String> {
    result.map(|()| value.as_bool()).map_err(describe)
}

impl SettingsAccess for Webview2Settings {
    fn set(&mut self, setting: Setting, value: bool) -> Result<(), String> {
        // SAFETY: settings は生きている webview の設定で、この呼び出しは窓のスレッドで行う。
        unsafe {
            match setting {
                Setting::BrowserAcceleratorKeys => self
                    .cast::<ICoreWebView2Settings3>()?
                    .SetAreBrowserAcceleratorKeysEnabled(value),
                Setting::ZoomControl => self.settings.SetIsZoomControlEnabled(value),
                Setting::PinchZoom => self
                    .cast::<ICoreWebView2Settings5>()?
                    .SetIsPinchZoomEnabled(value),
                Setting::SwipeNavigation => self
                    .cast::<ICoreWebView2Settings6>()?
                    .SetIsSwipeNavigationEnabled(value),
                Setting::StatusBar => self.settings.SetIsStatusBarEnabled(value),
                Setting::BuiltInErrorPage => self.settings.SetIsBuiltInErrorPageEnabled(value),
                Setting::GeneralAutofill => self
                    .cast::<ICoreWebView2Settings4>()?
                    .SetIsGeneralAutofillEnabled(value),
                Setting::PasswordAutosave => self
                    .cast::<ICoreWebView2Settings4>()?
                    .SetIsPasswordAutosaveEnabled(value),
                Setting::DevTools => self.settings.SetAreDevToolsEnabled(value),
                Setting::DefaultContextMenus => {
                    self.settings.SetAreDefaultContextMenusEnabled(value)
                }
            }
            .map_err(describe)
        }
    }

    fn get(&self, setting: Setting) -> Result<bool, String> {
        let mut value = BOOL::default();
        // SAFETY: 同上。value は呼び出しの間だけ使う。
        unsafe {
            let result = match setting {
                Setting::BrowserAcceleratorKeys => self
                    .cast::<ICoreWebView2Settings3>()?
                    .AreBrowserAcceleratorKeysEnabled(&mut value),
                Setting::ZoomControl => self.settings.IsZoomControlEnabled(&mut value),
                Setting::PinchZoom => self
                    .cast::<ICoreWebView2Settings5>()?
                    .IsPinchZoomEnabled(&mut value),
                Setting::SwipeNavigation => self
                    .cast::<ICoreWebView2Settings6>()?
                    .IsSwipeNavigationEnabled(&mut value),
                Setting::StatusBar => self.settings.IsStatusBarEnabled(&mut value),
                Setting::BuiltInErrorPage => self.settings.IsBuiltInErrorPageEnabled(&mut value),
                Setting::GeneralAutofill => self
                    .cast::<ICoreWebView2Settings4>()?
                    .IsGeneralAutofillEnabled(&mut value),
                Setting::PasswordAutosave => self
                    .cast::<ICoreWebView2Settings4>()?
                    .IsPasswordAutosaveEnabled(&mut value),
                Setting::DevTools => self.settings.AreDevToolsEnabled(&mut value),
                Setting::DefaultContextMenus => {
                    self.settings.AreDefaultContextMenusEnabled(&mut value)
                }
            };
            read(result, value)
        }
    }
}

/// 窓の webview に設定を書き込み、読み戻して確かめる。結果は標準エラー出力に書く
/// （書けなかった項目があっても、アプリは動かす）。
pub fn harden<R: Runtime>(window: &WebviewWindow<R>, flags: WebviewFlags) {
    let label = window.label().to_string();
    let scheduled = window.with_webview(move |platform| {
        // SAFETY: Tauri が窓のスレッドで呼ぶ。controller は生きている webview のもの。
        unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(core) => core,
                Err(e) => {
                    eprintln!("[{label}] WebView2 を取得できません: {e}");
                    return;
                }
            };
            match core.Settings() {
                Ok(settings) => {
                    let mut access = Webview2Settings { settings };
                    let problems = apply_flags(&flags, &mut access);
                    if problems.is_empty() {
                        eprintln!(
                            "[{label}] WebView2 の設定 {} 項目を書き込み、読み戻して確かめました",
                            flags.webview2_settings().len()
                        );
                    }
                    for problem in problems {
                        eprintln!("[{label}] WebView2 の設定: {problem}");
                    }
                }
                Err(e) => eprintln!("[{label}] WebView2 の設定を取得できません: {e}"),
            }
            if let Err(e) = install_context_menu_filter(&core) {
                eprintln!("[{label}] 右クリックのメニューの絞り込みを入れられません: {e}");
            }
        }
    });
    if let Err(e) = scheduled {
        eprintln!("WebView2 の設定を予約できませんでした: {e}");
    }
}

/// 右クリックのメニューを絞る処理を、webview に登録する。
unsafe fn install_context_menu_filter(core: &ICoreWebView2) -> Result<(), String> {
    let core11: ICoreWebView2_11 = core
        .cast()
        .map_err(|e| format!("この WebView2 は対応していません（{e}）"))?;
    let handler = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        // SAFETY: WebView2 が、このイベントの間だけ有効な引数を渡す。
        if let Err(e) = unsafe { filter_context_menu(&args) } {
            // 絞れなかったときは、標準のメニュー（ブラウザの項目だらけ）を出さずに止める。
            eprintln!("右クリックのメニューを絞れませんでした: {e}");
            let _ = unsafe { args.SetHandled(true) };
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: handler と token は呼び出しの間だけ使う。登録は webview が生きている間ずっと有効。
    unsafe { core11.add_ContextMenuRequested(&handler, &mut token) }.map_err(describe)
}

/// 右クリックのメニューを、`plan_context_menu` の決めたとおりにする。
unsafe fn filter_context_menu(
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
) -> windows::core::Result<()> {
    unsafe {
        let mut editable = BOOL::default();
        args.ContextMenuTarget()?.IsEditable(&mut editable)?;
        let items = args.MenuItems()?;
        let mut count = 0u32;
        items.Count(&mut count)?;
        let mut infos = Vec::with_capacity(count as usize);
        for index in 0..count {
            let item = items.GetValueAtIndex(index)?;
            let mut name = PWSTR::null();
            item.Name(&mut name)?;
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
            item.Kind(&mut kind)?;
            infos.push(MenuItemInfo {
                name: take_pwstr(name),
                separator: kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
            });
        }
        match plan_context_menu(editable.as_bool(), &infos) {
            ContextMenuPlan::Suppress => args.SetHandled(true),
            ContextMenuPlan::Keep { keep } => {
                // 後ろから消す（前から消すと、番号がずれる）。
                for index in (0..count).rev() {
                    if !keep[index as usize] {
                        items.RemoveValueAtIndex(index)?;
                    }
                }
                Ok(())
            }
        }
    }
}
