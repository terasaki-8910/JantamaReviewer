# jantama-engine（解析エンジン）

JantamaReviewer の解析エンジン（SPEC の F24）。**AGPL-3.0-or-later**（`LICENSE`）の、本体（MIT）とは別のプログラム。
段階 A1 では、取り込み済みの牌譜から、他家の聴牌と待ちの読み（F23）を `reads.json` に書く `read` コマンドだけを持つ。

## 出どころ

- 局面の更新と観測の組み立ては、Mortal の `libriichi` を使っている。
  - 出どころ: https://github.com/Equim-chan/Mortal（Equim-chan/Mortal）、コミット `0cff2b5`
  - ライセンス: AGPL-3.0-or-later（`LICENSE` は Mortal のもの。`libriichi/LICENSE` と同じ）
  - 元は Python の拡張モジュール（pyo3）として使う Rust の crate。このリポジトリの `libriichi/` は、それを Python なしの普通の
    rlib（crate 名 `libriichi`、lib 名 `riichi`）に直したもの。
- 推論は tract（Rust だけの ONNX の実行部品）。読みのモデル（`tenpai.onnx`）は、この中に入れない（SPEC の F24。ユーザーの操作で取る）。
- 変えていないこと: 局面の更新（`PlayerState::update`）・観測（`PlayerState::encode_obs`）・向聴数と和了の計算（`algo`）は上流のまま。
  固定データ FX-E で、Python 版の libriichi（同じコミット）と観測がビット単位で一致することを、試験（E-52）で毎回確かめている。

### 元から取り除いたファイル（`libriichi/` の中）

- `build.rs` — Python の拡張モジュール用のリンクの設定を足す build script（pyo3 用）。
- `benches/bench.rs` — criterion の計測。
- `src/agent/`（`akochan.rs`・`batchify.rs`・`defs.rs`・`mjai_log.rs`・`mod.rs`・`mortal.rs`・`py_agent.rs`・`tsumogiri.rs`）— 自己対局・Python から呼ぶエージェント。
- `src/arena/`（`board.rs`・`game.rs`・`mod.rs`・`one_vs_three.rs`・`result.rs`・`two_vs_two.rs`）— 自己対局の場。
- `src/dataset/`（`gameplay.rs`・`grp.rs`・`invisible.rs`・`mod.rs`）— 学習用のデータ作り。
- `src/bin/`（`stat.rs`・`validate_logs.rs`）— 統計と牌譜の検査の実行ファイル。
- `src/stat.rs` — 牌譜の統計。
- `src/py_helper.rs` — Python のモジュールに部品を登録する補助。
- `src/mjai/bot.rs` — Python から呼ぶ mjai の bot。

### 元から変えたファイル（`libriichi/` の中）

- `Cargo.toml` — Python の部品（pyo3・numpy・pyo3-log・pyo3-build-config）と、使わなくなった部品（indicatif・mimalloc・criterion・rand・rand_chacha・rayon・sha3・glob・log・crossbeam・parking_lot・derive_more）、bench、`cdylib` を外した。`serde_json` は単体テストだけが使うので dev-dependencies に移した。
- `src/lib.rs` — `#[pymodule]` の関数と、取り除いたモジュールの `mod` 行を消し、上流の `#![deny(...)]` の一覧を `#![allow(clippy::all, clippy::pedantic, clippy::nursery)]` に替えた（上流のコードなので、clippy の指摘は直さない。rustc の警告は 0 件）。`consts` は公開にした。
- `src/consts.rs` — `#[pyfunction]` と `register_module` を消した（定数と `obs_shape` はそのまま）。
- `src/mjai/mod.rs` — `bot` と `register_module` を消した（`Event` などはそのまま）。
- `src/rankings.rs` — `Rankings::player_by_rank` を、取り除いたモジュールだけが読んでいたため、未使用の警告を出さないよう `#[allow(dead_code)]` にした。
- `src/state/mod.rs` — `register_module` を消した。
- `src/state/action.rs` — `ActionCandidate` の `#[pyclass]`・`#[pyo3(get)]`・`#[pymethods]`・`#[getter]` と、`__repr__` を消した（欄と判定の関数はそのまま）。
- `src/state/getter.rs` — `#[pymethods]`・`#[getter]` と、Python 向けの `last_self_tsumo_py`・`last_kawa_tile_py`・`ankan_candidates_py`・`kakan_candidates_py` を消した。
- `src/state/player_state.rs` — `#[pyclass]`・`#[pymethods]`・`#[new]` と、Python 向けの `update_json`・`validate_reaction_json` を消した（`PlayerState::new` と `brief_info` はそのまま）。
- `src/state/obs_repr.rs` — numpy に渡す `encode_obs_py` と、numpy・pyo3 の `use` を消した（`PlayerState::encode_obs` はそのまま）。
- `src/state/test.rs` — 上流の単体テストの補助関数 `test_update_json` が、消した `update_json` の代わりに `serde_json` で読んで `update` を呼ぶ形に。

### 足したファイル

- `.gitignore` — リポジトリのルートの `.gitignore` の `state/`（パイプラインの実行時の状態）が、`libriichi/src/state/`（局面の更新と観測の組み立て）にも当たってしまうため、ここだけ無視から外す。
- `LICENSE` — AGPL-3.0（Mortal のもの）。

## 本体からの呼び方

本体（MIT のまま）は、エンジンを**別のプロセス**として起こし、**ファイルのパスだけ**でやり取りする（SPEC の F24）。本体はこの crate に依存しない（`Cargo.toml` に書かない。`tests/safety.rs` の S-5 が確かめる）。

```text
jantama-engine read --report <report.json> --model <tenpai.onnx> --out <reads.json> [--player 0-3]
```

- 入力: `--report` は、取り込み済みの `report.json`（`mjai_log` と `player_id` を持つ。ほかの欄は読み飛ばす）。`--player` を付けると `player_id` より優先する。
- モデル: `--model` は、読みのモデルの `tenpai.onnx`（入力 `obs` が n×934×34、出力 `tenpai`・`waits`・`any_wait`・`furiten`）。入出力の名前や形が違うモデルは断る。
- 出力: `--out` の 1 ファイルだけを書く（失敗したときは作らない）。エンジンは通信せず、ほかのプロセスを起こさず、画面を撮らず、ほかのファイルを書かない。
- 標準エラー: 進み具合は `progress <済み>/<全部>` の行（全部は場面の数）。失敗すると、終了コードは 0 でなく（引数の誤りは 2、ほかは 1）、日本語の 1 行を出す。libriichi は、壊れた牌譜（見えない牌 `?` を自分が打つ、など）で `Err` でなく panic で止まることがあるので、入口で拾って、同じ日本語の 1 行（`内部エラーで止まりました: 理由（場所）`）にする（`src/guard.rs`）。
- 標準出力: 何も出さない（`--help` だけ使い方を出す）。

## `reads.json`（形の名前 `jantama-reads/1`）

自分（`player_id`）の手番の場面ごとの読み。場面は、自分のツモの直後（嶺上牌を含む）と、自分のチー・ポンの直後（打牌が要るとき）。

| 欄 | 中身 |
| --- | --- |
| `format` | `"jantama-reads/1"` |
| `model` | `{ file, sha256 }` — モデルのファイル名と、中身の sha256（モデルが替わったら作り直す印） |
| `player_id` | 見た席 |
| `moments[]` | 場面（下の欄） |

場面（`moments[]`）:

- `event_index` — 場面の事象（ツモ・チー・ポン）の、`mjai_log` での番号。
- `kyoku_index` — 何局目か（0 から）。`bakaze`・`kyoku`（mjai の数え方で 1 から）・`honba` — その局の場風・局・本場。
- `junme` — その局の自分のツモの回数（この場面のツモを含む。チー・ポンの場面では増えない）。
- `hand` — 自分の手牌（鳴いていない牌）の種類。重ならず、牌の順（1m..9m, 1p..9p, 1s..9s, E S W N P F C）。
- `any_wait` — 3 人をまとめた、牌の種類ごとに待っている確率（34 個、牌の順）。
- `opponents[]` — 他家 3 人（`step` 1・2・3 = 自分から見て下家・対面・上家の順）:
  - `seat`・`step`、`riichi`（リーチを受け付けられているか）、`tenpai`・`furiten`（確率）、`waits`（牌の種類ごとの待つ確率。34 個）。
  - `top_waits` — 待つ確率の上位 5 牌 `{ tile, p }`（高い順。同じなら牌の順）。
  - `actual_waits` — 牌譜の全員の手牌から数えた実際の待ち（牌の順。聴牌でなければ空）。フリテン・役は問わない。
  - `reasons` — 効いた捨て牌。リーチした他家と、聴牌の確率が 0.5 以上の他家だけ（ほかは `{}`）。手牌の牌 → 最大 2 つの `{ turn, event_index, pai, without }`。その他家の、この局の捨て牌（鳴かれたものを除く）を 1 枚ずつ、見えている枚数のいちばん少ない字牌に替えて読み直し、その牌を待つ確率がいちばん大きく動いた捨て牌（動きの絶対値が 0.01 未満は出さない）。`turn` はその他家の何枚目の打牌か（1 から）、`pai` は元の牌、`without` は替えたときの待つ確率。キーが無い牌は「大きく動かす捨て牌なし」。替えた牌譜を libriichi が断った捨て牌は、飛ばす（元の牌譜が通っていれば起きない）。

確率は小数 4 桁。牌の名前は mjai の書き方（`1m`〜`9m`・`1p`〜`9p`・`1s`〜`9s`・`E S W N P F C`）で、赤牌も元の種類（`5m`）。

## 試験

```text
cd apps/desktop/src-tauri/engine
JANTAMA_MODEL_DIR=<tenpai.onnx のあるフォルダ> cargo test --workspace
```

- 固定データは `tests/fixtures/fx-e`（S42 同士の自己対局 1 局。個人の記録を含まない。作り方は同じフォルダの README）。
- モデルが要らない試験（E-52 観測のビット一致・E-55 実際の待ち・E-54 替える捨て牌の計画・エラーの出し方・libriichi の単体テスト）は、いつも動く。
- モデルを使う試験（E-53 の推論と `read` の実行）は、`JANTAMA_MODEL_DIR` の `tenpai.onnx` の sha256 が `50893ddc…` のときだけ動き、無ければ `skip: ...` を出して通る。モデルのファイルは git に入れない。
- 本体の `pnpm test:rust`・`pnpm lint:clippy`・`pnpm lint:fmt`・`pnpm check:mac` は、この workspace も見る。
