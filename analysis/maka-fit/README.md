# MAKA の評価を Mortal のデータで当てる分析

確認シート5回目（2026-10-09）に載せた分析の再現用。5半荘・67局について、Mortal の検討結果から局ごとの点数を作り、
ユーザーが入力した MAKA の評価（S+〜D）をどこまで当てられるかを、半荘を1つずつ外す検証で調べた。

- `features.py`: 結果 JSON（`%USERPROFILE%\JantamaReviewerData\reports\`、環境変数 `JANTAMA_DATA` で変更可）から `dataset.csv` を作る。
- `fit.py`: 点数ごとの相関、1つの点数での当てはめ、組み合わせの当てはめ、結果（和了・放銃）との関係。
- `nested.py`: 組み合わせの選び方まで含めた入れ子の検証。
- `export.py`: シートの表と散布図のデータ（`chart.json`）を作る。

実行（このフォルダで）:

```
python features.py
uv run --with numpy --with scipy --with scikit-learn python fit.py
uv run --with numpy --with scipy --with scikit-learn python nested.py
uv run --with numpy --with scipy --with scikit-learn python export.py
```

結果の要約: どの点数も MAKA の評価と強く連動（順位の相関 0.7〜0.8）。半荘を外す検証で、Mortal の Rating はぴったり 34%・±1段階以内 66%、
候補から自動で選ぶ方法はぴったり 40%・±1段階以内 67%（2026-10-09 に丸めを四捨五入に直した値。5回目のシートの表は偶数丸めで 42% だった）。判断の数や和了・放銃の結果とはほぼ無関係だった。
