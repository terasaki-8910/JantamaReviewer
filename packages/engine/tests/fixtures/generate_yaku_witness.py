"""近い役の witness（最も近い和了形）を、Python の mahjong ライブラリで採点する（役の表示の調査。analysis/yaku/README.md）。

TypeScript の探索（packages/engine/src/yaku-near.ts）が、役ごとに「あと r 枚引けばこの和了形になる」と答えた和了形（witness）を、
独立した実装の HandCalculator で採点して、本当にその役が付くかを確かめる材料にする。
力ずくで数えられない遠さ（r が 4・5）の答えの健全性を確かめるのが目的（r が 3 まで、2 向聴の手は 4 までは、generate_yaku_near.py の
力ずくの値と、探索の値を突き合わせる）。

手順（packages/engine で）:

    YAKU_WITNESS_DUMP=1 pnpm exec vitest run tests/yaku-witness-dump.test.ts   # yaku-witness.json（oracle なし）を作る
    cd tests/fixtures
    uv run --offline --with mahjong python generate_yaku_witness.py             # oracle（役の名前）を足して、同じファイルに書く

入力: yaku-near.json（手）、yaku-witness.json（TypeScript が書き出した witness）。出力: yaku-witness.json（oracle を足したもの）。
"""

import json
from importlib.metadata import version
from pathlib import Path

from yaku_oracle_lib import estimate, parse_notation

HERE = Path(__file__).parent
NEAR = HERE / "yaku-near.json"
WITNESS = HERE / "yaku-witness.json"


def main() -> None:
    samples = json.loads(NEAR.read_text(encoding="utf-8"))["samples"]
    document = json.loads(WITNESS.read_text(encoding="utf-8"))
    for row in document["rows"]:
        sample = samples[row["sample"]]
        melds = [(t, f, o) for t, f, o in sample["melds"]]
        result = estimate(parse_notation(row["target"]), melds, row["win"], True, False, sample["seat"], sample["round"])
        row["oracle"] = result["yaku"]
        if result["error"] not in (None, "no_yaku") or result["yakuman"]:
            raise AssertionError(f"witness が和了形でない（または役満）: {row} {result['error']}")
    document["library"] = "mahjong " + version("mahjong")
    with WITNESS.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        f.write(f'  "library": {json.dumps(document["library"])},\n')
        f.write(f'  "every": {document["every"]},\n')
        f.write('  "rows": [\n')
        for i, row in enumerate(document["rows"]):
            f.write("    " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) + ("," if i < len(document["rows"]) - 1 else "") + "\n")
        f.write("  ]\n}\n")
    print("rows", len(document["rows"]))


if __name__ == "__main__":
    main()
