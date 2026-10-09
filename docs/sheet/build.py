"""確認シートを組み立てる。

SPEC.md と ACCEPTANCE.md を HTML に変換し、jantama-sheet.src.html の
{{SPEC}} と {{ACCEPTANCE}} に差し込んで jantama-sheet.html を書き出す。

実行: uv run --with markdown python docs/sheet/build.py
"""
import pathlib

import markdown

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def to_fragment(md_path: pathlib.Path) -> str:
    html = markdown.markdown(md_path.read_text(encoding="utf-8"), extensions=["tables", "fenced_code"])
    # シートの h3 の下に収まるよう、見出しを2段下げる（大きい番号から順に置き換える）
    for level in (4, 3, 2, 1):
        new = min(level + 2, 6)
        html = html.replace(f"<h{level}>", f"<h{new}>").replace(f"</h{level}>", f"</h{new}>")
    return html


def main() -> None:
    src = (HERE / "jantama-sheet.src.html").read_text(encoding="utf-8")
    assert "{{SPEC}}" in src and "{{ACCEPTANCE}}" in src
    out = src.replace("{{SPEC}}", to_fragment(ROOT / "SPEC.md")).replace(
        "{{ACCEPTANCE}}", to_fragment(ROOT / "ACCEPTANCE.md")
    )
    (HERE / "jantama-sheet.html").write_text(out, encoding="utf-8")
    print(f"jantama-sheet.html: {len(out)} 文字")


if __name__ == "__main__":
    main()
