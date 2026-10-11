"""FX-6 の画像（画面の中央だけを残した迷いマークの画像 19 枚）を、本物のスクリーンショットから作る。

FX-6: FX-5 の迷い 13 枚（1368×800）と、FX-4 の迷い 6 枚（1447×935）の、画面の中央（幅 35〜65%・高さ 25〜60%）だけを残し、
そのほかを一色で塗りつぶした画像。窓の大きさ（画像の大きさ）はそのまま。プレイヤー名・アバター・称号・チャットは、この範囲の外に
あるので入らない（できた画像は、必ず目で見て確かめてから置く）。

本物のスクリーンショットは読むだけで、書き換えない。元の画像は、どこにも写さない（できる画像は、中央だけを残したもの）。
使い方（このフォルダの中から。`pip install pillow` のある環境）:

    python make_fx6.py --fx4 <10月9日の半荘のフォルダ> --fx5 <10月11日 15:35 の半荘のフォルダ>

それぞれのフォルダの `marks/` の画像を、ファイル名の順（押した順）に、`fx6-fx4-mark1.png`…`fx6-fx4-mark6.png`、
`fx6-fx5-mark01.png`…`fx6-fx5-mark13.png` として、このスクリプトのあるフォルダに書く。
正解（目で読んだ値）は、`../ocr_fixtures.rs` と `../locate_fixtures.rs` の `FX6` の表にある。
"""

import argparse
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent

# 残す範囲（画面の幅・高さに対する割合）。局・残り枚数・自分の点数の板だけが入る広さ（プレイヤー名・アバター・称号・チャットは、この外）。
# 板の文字を探す範囲ではない（探す側 `locate` は画像全体から探す。この画像は、名前などを含まない形にするための切り取り）。
LEFT, RIGHT, TOP, BOTTOM = 0.35, 0.65, 0.25, 0.60
# 塗りつぶす一色（水色でも、点数の橙でもない、暗い灰色）。
FLAT = (32, 32, 32)


def keep_center_only(source: Path, target: Path) -> None:
    image = Image.open(source).convert("RGB")
    width, height = image.size
    box = (int(width * LEFT), int(height * TOP), int(width * RIGHT), int(height * BOTTOM))
    canvas = Image.new("RGB", image.size, FLAT)
    canvas.paste(image.crop(box), box[:2])
    canvas.save(target, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fx4", type=Path, required=True, help="10月9日の半荘のフォルダ（marks/ が入っている）")
    parser.add_argument("--fx5", type=Path, required=True, help="10月11日 15:35 の半荘のフォルダ（marks/ が入っている）")
    args = parser.parse_args()

    for folder, label, digits, expected in ((args.fx4, "fx4", 1, 6), (args.fx5, "fx5", 2, 13)):
        marks = sorted((folder / "marks").glob("*.png"))
        if len(marks) != expected:
            raise SystemExit(f"{label}: 迷いの画像が {expected} 枚のはずが {len(marks)} 枚ある")
        for number, source in enumerate(marks, start=1):
            keep_center_only(source, HERE / f"fx6-{label}-mark{number:0{digits}d}.png")


if __name__ == "__main__":
    main()
