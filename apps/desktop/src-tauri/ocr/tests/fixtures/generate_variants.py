"""読み直し用の画像（コントラストを上げたもの・1.5 倍に広げたもの）の、試験の見本を作る。

Rust 側の `resample::enhance_contrast` と `resample::resize` が、Pillow と同じ画素を作ることを確かめるための見本で、
`pip install pillow` のある環境で、このフォルダの中から `python generate_variants.py` を動かすと作り直せる。

- variant-source.png: mark6-center.png（迷い 6 の中央の切り出しを 3 倍にしたもの）の一部（61×28）
- variant-contrast-expected.png: `ImageEnhance.Contrast(source).enhance(1.8)`
- variant-enlarged-expected.png: `source.resize((int(61 * 1.5), int(28 * 1.5)), Image.LANCZOS)`（91×42。小数は切り捨て）

迷い 6 の全体（654×393）でも、Pillow の結果と画素が同じになることは、手元で確かめた（コントラスト ×1.8 は 654×393、
1.5 倍は 981×589。どちらも文字認識で「東 3 局」「余 38」「4400」と読める。ACCEPTANCE の E-20）。
"""

from pathlib import Path

from PIL import Image, ImageEnhance

HERE = Path(__file__).resolve().parent

whole = Image.open(HERE / "mark6-center.png").convert("RGB")
source = whole.crop((226, 96, 287, 124))
assert source.size == (61, 28)
source.save(HERE / "variant-source.png", optimize=True)

ImageEnhance.Contrast(source).enhance(1.8).save(HERE / "variant-contrast-expected.png", optimize=True)

width, height = source.size
enlarged = source.resize((int(width * 1.5), int(height * 1.5)), Image.LANCZOS)
assert enlarged.size == (91, 42)
enlarged.save(HERE / "variant-enlarged-expected.png", optimize=True)
