# 第三者のソフトウェアの表示

このアプリが使っている、第三者のソフトウェアのうち、著作権と許諾の表示を残す決まりのあるものです。
どちらも MIT ライセンスで、許諾の全文は、下に原文のまま書きます。ほかの依存パッケージ（フォント・牌の画像・Tauri・React など）は、
[README.md](README.md) のライセンスの節と、それぞれのパッケージのライセンスに従います。

## @kobalab/majiang-core 1.4.1

- 何に使っているか: 答え合わせのタブ「待ちと打点」の、和了の役・飜・符・点数の計算と、待ちの形の判定（面子の分解）。npm のパッケージとして、版を 1.4.1 に固定して依存に入れ、
  エンジンの 1 つのファイル（`packages/engine/src/majiang-adapter.ts`）の中だけで読み込みます。ほかに、試験が、役の判定の 2 つ目の正解として使います。
- 入手先: npm の `@kobalab/majiang-core`（リポジトリは kobalab/majiang-core。電脳麻将）。

```
MIT License

Copyright (c) 2021 Satoshi Kobayashi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## mahjong（Python のライブラリ。MahjongRepository/mahjong 2.0.0）

- 何に使っているか: 符の内訳（`fu_details`）の数え方を、TypeScript に移したものを、エンジンに持っています（`packages/engine/src/fu-detail.ts`。実行時に Python は使いません）。
  また、試験の正解表（`packages/engine/tests/fixtures/*-oracle.json` など）を作る道具として、Python のまま使います（`generate_*.py`）。
- 入手先: PyPI の `mahjong`（リポジトリは MahjongRepository/mahjong）。

```
MIT License

Copyright (c) 2017 mahjong Python library contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
