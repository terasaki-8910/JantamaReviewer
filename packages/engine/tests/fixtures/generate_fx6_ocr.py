"""FX-6（画面の中央だけを残した迷いマーク 19 枚）の文字認識の写し（fx6-ocr.json）を作る。

Windows の日本語の文字認識で読んだ行は、`apps/desktop/src-tauri/ocr/examples/survey.rs` が出す（1 行 1 件の JSON）。
このスクリプトは、その出力のうち FX-6 の 19 枚分を取り、目で読んだ正解（ACCEPTANCE の FX-6）と組にして、1 つの JSON にする。
- `box`: 画面の大きさに対する割合の箱で切り出して読んだ結果（E-32 より前の読み方。比べるための写し）
- `tight`: 局と残り枚数の水色の文字の位置から切り出して読んだ結果（いまの読み方。1 回目と読み直し）

実行（ocr クレートのフォルダの `tests/fixtures/` に FX-6 の画像がある。`apps/desktop/src-tauri` から）:

    cargo run -p jantama-ocr --example survey -- <FX-6 の画像を marks/ に並べたフォルダ> > fx6-survey.jsonl
    python ../../../../packages/engine/tests/fixtures/generate_fx6_ocr.py fx6-survey.jsonl

出力: fx6-ocr.json（このスクリプトのあるフォルダ）。
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (ファイル名, 局の風 E/S, 番号, 残りの牌の数, 自分の点数)。ACCEPTANCE の FX-6 の正解。FX-5 の 13 枚は押した順、FX-4 の 6 枚は E-16 の 5 枚と 6 枚目。
EXPECTED = [
    ("fx6-fx5-mark01.png", "E", 2, 50, 25000),
    ("fx6-fx5-mark02.png", "E", 2, 46, 25000),
    ("fx6-fx5-mark03.png", "E", 2, 37, 25000),
    ("fx6-fx5-mark04.png", "E", 3, 59, 23700),
    ("fx6-fx5-mark05.png", "E", 4, 52, 31700),
    ("fx6-fx5-mark06.png", "E", 4, 49, 31700),
    ("fx6-fx5-mark07.png", "E", 4, 39, 31700),
    ("fx6-fx5-mark08.png", "S", 1, 60, 33700),
    ("fx6-fx5-mark09.png", "S", 1, 34, 33700),
    ("fx6-fx5-mark10.png", "S", 2, 46, 32500),
    ("fx6-fx5-mark11.png", "S", 2, 32, 32500),
    ("fx6-fx5-mark12.png", "S", 3, 53, 20500),
    ("fx6-fx5-mark13.png", "S", 4, 49, 28500),
    ("fx6-fx4-mark1.png", "E", 1, 59, 25000),
    ("fx6-fx4-mark2.png", "E", 2, 23, 19000),
    ("fx6-fx4-mark3.png", "E", 2, 47, 15100),
    ("fx6-fx4-mark4.png", "E", 2, 35, 15100),
    ("fx6-fx4-mark5.png", "E", 3, 46, 4400),
    ("fx6-fx4-mark6.png", "E", 3, 38, 4400),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("使い方: python generate_fx6_ocr.py <survey の出力（JSON Lines）>")
    survey = {}
    for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            survey[row["file"]] = row
    images = []
    for file, wind, number, tiles_left, score in EXPECTED:
        row = survey[file]
        images.append(
            {
                "file": file,
                "width": row["width"],
                "height": row["height"],
                "expected": {"wind": wind, "number": number, "tilesLeft": tiles_left, "score": score},
                "located": row["located"],
                "tight": row["tight"],
                "box": row["box"],
            }
        )
    document = {
        "description": (
            "FX-6: 画面の中央だけを残した迷いマークの画像19枚（FX-5 の13枚と FX-4 の6枚。ocr クレートの tests/fixtures/fx6-*.png）を、"
            "Windows の日本語の文字認識で読んだ結果の写し。expected は目で読んだ正解。located は、水色の文字の位置から決めた切り出し"
            "（[左, 上, 幅, 高さ]。画面の画素）。tight は、その切り出しを読んだ結果（variant は 1 回目 plain・読み直し contrast1.8・upscale1.5 の順。"
            "lines は認識した行）。box は、画面の大きさに対する割合の箱で読んだ結果（E-32 より前の読み方）。誤読はそのまま残してある。"
        ),
        "date": "2026-10-11",
        "images": images,
    }
    out = HERE / "fx6-ocr.json"
    # 1 枚を 1 行に（fx4-ocr.json と同じ読みやすさ）。
    head = {key: value for key, value in document.items() if key != "images"}
    body = ",\n".join("    " + json.dumps(image, ensure_ascii=False) for image in images)
    text = json.dumps(head, ensure_ascii=False, indent=2)
    text = text[: text.rindex("}")].rstrip() + ',\n  "images": [\n' + body + "\n  ]\n}\n"
    out.write_text(text, encoding="utf-8")
    print(f"{out.name}: {len(images)} 枚")


if __name__ == "__main__":
    main()
