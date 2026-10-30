//! 解析エンジン `jantama-engine`（SPEC の F24。AGPL-3.0-or-later）。
//!
//! 本体（MIT）とは別のプログラムで、本体は別のプロセスとして呼び、渡したファイルと出力先だけでやり取りする。
//! 通信せず、ほかのプロセスを起こさず、画面を撮らない。読むのは渡されたファイルだけ、書くのは渡された出力先だけ。
//!
//! 今できること（段階 A1）: `read` — 取り込み済みの牌譜（mjai の事象）の、自分の手番の場面ごとに、
//! 他家の聴牌・待ちの確率を `tenpai.onnx` で読み、reads.json に書く（F23）。
//!
//! 部品:
//! - [`args`](crate::args): コマンドラインの引数。
//! - [`report`](crate::report): 入力の report.json。
//! - [`replay`](crate::replay): 牌譜を再生して、読みを出す場面を集める。
//! - [`waits`](crate::waits): 牌譜の全員の手牌から数える、実際の待ち。
//! - [`counterfactual`](crate::counterfactual): 他家の捨て牌を字牌に替えて読み直す準備（効いた捨て牌）。
//! - [`model`](crate::model): `tenpai.onnx` の推論（tract）。
//! - [`reads`](crate::reads): `read` の本体と、reads.json の形。
//! - [`tiles`](crate::tiles): 牌の名前と 34 種の番号。

pub mod args;
pub mod counterfactual;
pub mod model;
pub mod reads;
pub mod replay;
pub mod report;
pub mod tiles;
pub mod waits;
