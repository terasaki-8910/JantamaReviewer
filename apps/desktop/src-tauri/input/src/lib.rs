//! ボタンを拾う部品（W-2、W-9、W-10）。本体（Tauri のアプリ）と、管理者で動く補助プログラム（jantama-helper）が共有する。
//!
//! 雀魂のランチャーは管理者の権限で動くので、その窓が前面にあると、普通の権限の本体のフックには入力が届かない（UIPI）。
//! そこで、ボタンを拾う部分だけを小さな補助プログラムに分け、管理者で動かして、本体に名前付きパイプで知らせる。
//! 判定は、本体の中のフックと補助プログラムで同じもの（`logic`）を使う。
//!
//! この部品は、補助プログラムの中でも管理者で動く。入力を拾って知らせる以外のことは、ここに入れない
//! （画面・ネット・ファイルの部品を持たないことを、tests/safety.rs が確かめる）。

pub mod clock;
pub mod keys;
pub mod logic;
pub mod protocol;
pub mod setup;
pub mod xml_ns;

#[cfg(windows)]
pub mod hook_win;
#[cfg(windows)]
pub mod pipe_win;
#[cfg(windows)]
pub mod user_win;
