# FX-E: 解析エンジンの固定データ

ACCEPTANCE の FX-E（E-52〜E-56）。個人の記録を含まない。

- `game.json`: S42 同士の自己対局 1 局の mjai の牌譜（`player_id` は 0）。別セッション（MahjongAI）の評価の煙試験 `eval/smoke-s42-vs-s42/logs/1000000_120303736217964_a.json.gz`（2026-10-26、libriichi の arena、天鳳のルールの半荘）を、`{ "player_id": 0, "mjai_log": [...] }` の形にしたもの。
- `moments.json`: 席 0 の自分のツモ 126 場面ごとの、次の値。
  - 観測（v3 は 934×34、v4 は 1012×34）の float32（リトルエンディアン、行の順）の sha256
  - 合法手の印（46 文字の 0/1）
  - S42 の Q（PyTorch、合法でない手は null）
  - 他家（下家・対面・上家の順）の実際の待ち
  - 最初に他家がリーチしている場面（moment 17）の反実仮想（`counterfactual`）
- `reads_ref.json`: `tenpai.onnx`（sha256 50893ddc…）を onnxruntime（CPU）で推論した値（小数 6 桁）。126 場面と、反実仮想の 9 行。

作り方（2026-10-30。`tools/`）:

- `make_fixture.py`: Python の libriichi（Mortal 0cff2b5。このリポジトリの `engine/libriichi` の元と同じ）、PyTorch、Mortal の `model.py`、S42 の `s42-inference.pth`（sha256 e5f6955b…）を使う。
- `make_reads_ref.py`: onnxruntime と `tenpai.onnx` を使う。

モデルのファイルは、このリポジトリに入れない（SPEC の F24）。
