//! Mortal の libriichi から、Python との橋渡しと、解析エンジンで使わない部品（自己対局・学習用のデータ・
//! 統計・エージェント）を外したもの。局面の更新（`state::PlayerState`）と、Mortal の観測の組み立て
//! （`PlayerState::encode_obs`）を、Python なしの普通の Rust の crate として使える。
//!
//! 上流のコードの動きは変えていない（変えた所の一覧は、エンジンの README.md に書いている）。

// 上流（Mortal）から取り込んだコードなので、上流の書き方は直さない（上流との差を小さく保つため）。
// 上流の厳しい lint の一覧（#![deny(...)]）は外し、clippy の指摘は許す。rustc の警告は許さない。
#![allow(clippy::all, clippy::pedantic, clippy::nursery)]
#![allow(clippy::manual_range_patterns)] // because of matches_tu8

mod array;
mod macros;
mod rankings;
mod vec_ops;

pub mod consts;

pub mod chi_type;
pub mod mjai;
pub mod state;
pub mod tile;

pub mod algo;
pub mod hand;
