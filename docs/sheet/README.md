# 確認シート

決定を聞くためのページ。公開先: https://claude.ai/artifact/NxJBRZW5kzaXb2VG1ZiJR2
回答はページのデータベースの `answers/round<N>` に保存される。決定は docs/decisions.md に写す。

- `jantama-sheet.src.html`: ページの元。回ごとに質問を書き換える。
- `build.py`: SPEC.md と ACCEPTANCE.md を差し込んで `jantama-sheet.html` を作る（`uv run --with markdown python docs/sheet/build.py`）。
- `tiles/`: 牌の画像（FluffyStuff/riichi-mahjong-tiles、パブリックドメイン）。
- `samples/`: 2回目のシートに載せた画面サンプルのスクショ。サンプル本体は `samples/round2` ブランチ。
