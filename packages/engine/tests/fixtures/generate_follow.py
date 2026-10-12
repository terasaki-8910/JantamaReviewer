"""E-23（2向聴からの先）の正解表を作る。

独立した実装として、Python の `mahjong` ライブラリの向聴計算で、素朴に数える。TypeScript 側の実装
（packages/engine/src/two-shanten-follow.ts）には依存しない。

場面（ACCEPTANCE E-23）:
- f9da87cbcd7af5e9 の東4局13巡目（実戦の行動の確率が最も低い判断）
- FX-4（5b821c8a048ff791）の東2局1本場 8巡目（k1h1e9。実戦は打4p）
それぞれの判断の手牌（結果 JSON に記録された、ツモ牌を含む手牌）で、切る牌（種類）ごとに、切ったあとが 2 向聴のものについて:
- 1 向聴に進む牌（2 向聴の手の受け入れ牌）と、その枚数（手牌だけで数える）
- その牌を引いた 14 枚から、切って 1 向聴になる打牌のうち、そのあとの受け入れ枚数が最大のもの（同じなら牌の並びの先）と、その枚数
- 引く牌の枚数で重みを付けた平均（分数のまま: 合計 / 枚数）と最大

実行（このフォルダで）:

    uv run --with mahjong python generate_follow.py

出力: follow.json。
"""

import json
from importlib.metadata import version
from pathlib import Path

from mahjong.shanten import Shanten

HERE = Path(__file__).parent
OUT = HERE / "follow.json"

HONORS = "ESWNPFC"
KIND_COUNT = 34


def kind_of(tile: str) -> int:
    if tile in HONORS:
        return 27 + HONORS.index(tile)
    return "mps".index(tile[1]) * 9 + int(tile[0]) - 1


def tile_of(kind: int) -> str:
    if kind >= 27:
        return HONORS[kind - 27]
    return f"{kind % 9 + 1}{'mps'[kind // 9]}"


def counts_of(tiles: list[str]) -> list[int]:
    counts = [0] * KIND_COUNT
    for tile in tiles:
        counts[kind_of(tile)] += 1
    return counts


def shanten(counts: list[int]) -> int:
    return Shanten.calculate_shanten(counts)


def accepted_of(counts: list[int]) -> tuple[int, list[tuple[int, int]]]:
    """3n+1 枚の手牌（種類ごとの枚数）の、向聴数と、受け入れ牌（種類, 手牌だけの枚数）。"""
    base = shanten(counts)
    accepted = []
    for k in range(KIND_COUNT):
        if counts[k] >= 4:
            continue
        counts[k] += 1
        better = shanten(counts) < base
        counts[k] -= 1
        if better:
            accepted.append((k, 4 - counts[k]))
    return base, accepted


def follow_of(after: list[int]) -> dict:
    """打牌のあと（13 枚。種類ごとの枚数）が 2 向聴の手の、1 向聴に進む牌ごとの先。"""
    base, accepted = accepted_of(after)
    assert base == 2
    rows = []
    for k, count in accepted:
        drawn = list(after)
        drawn[k] += 1
        best_kind, best_ukeire = None, -1
        for d in range(KIND_COUNT):
            if drawn[d] == 0:
                continue
            drawn[d] -= 1
            if shanten(drawn) == 1:
                _, acc = accepted_of(drawn)
                ukeire = sum(n for _, n in acc)
                if ukeire > best_ukeire:
                    best_kind, best_ukeire = d, ukeire
            drawn[d] += 1
        rows.append([tile_of(k), count, tile_of(best_kind), best_ukeire])
    total = sum(r[1] for r in rows)
    weighted = sum(r[1] * r[3] for r in rows)
    return {
        "total": total,
        "kinds": len(rows),
        "weighted": weighted,
        "average": weighted / total,
        "max": max(r[3] for r in rows),
        "rows": rows,
    }


def position(data: dict, key: str | None) -> tuple[str, dict]:
    """鍵（k<局>h<本場>e<番号>）の判断。鍵が無ければ、実戦の行動の確率がいちばん低い判断。"""
    best = None
    for kyoku in data["review"]["kyokus"]:
        for index, entry in enumerate(kyoku["entries"]):
            k = f"k{kyoku['kyoku']}h{kyoku['honba']}e{index}"
            probability = entry["details"][entry["actual_index"]]["prob"]
            if key is not None:
                if k == key:
                    return k, entry
            elif best is None or probability < best[0]:
                best = (probability, k, entry)
    assert best is not None
    return best[1], best[2]


def main() -> None:
    positions = []
    for report_id, key, label in [
        ("f9da87cbcd7af5e9", None, "東4局13巡目"),
        ("5b821c8a048ff791", "k1h1e9", "東2局1本場8巡目"),
    ]:
        data = json.loads((HERE / "reports" / f"{report_id}.json").read_text(encoding="utf-8"))
        found_key, entry = position(data, key)
        hand = entry["state"]["tehai"]
        assert len(hand) == 14, (report_id, found_key, len(hand))
        own = counts_of(hand)
        options = []
        for discard in range(KIND_COUNT):
            if own[discard] == 0:
                continue
            after = list(own)
            after[discard] -= 1
            if shanten(after) != 2:
                continue
            options.append({"discard": tile_of(discard), "follow": follow_of(after)})
        positions.append({"report": report_id, "key": found_key, "label": label, "options": options})
        print(report_id, found_key, label, [(o["discard"], o["follow"]["total"], o["follow"]["kinds"], round(o["follow"]["average"], 3), o["follow"]["max"]) for o in options])

    document = {
        "description": "E-23: 2向聴からの先の正解表（Python の mahjong ライブラリで、素朴に数えたもの）",
        "generator": "generate_follow.py",
        "library": "mahjong " + version("mahjong"),
        "positions": positions,
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library"):
            f.write(f"  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n")
        f.write('  "positions": [\n')
        for pi, pos in enumerate(positions):
            f.write("    {\n")
            for key in ("report", "key", "label"):
                f.write(f"      {json.dumps(key)}: {json.dumps(pos[key], ensure_ascii=False)},\n")
            f.write('      "options": [\n')
            for oi, option in enumerate(pos["options"]):
                f.write("        " + json.dumps(option, ensure_ascii=False, separators=(",", ":")) + ("," if oi < len(pos["options"]) - 1 else "") + "\n")
            f.write("      ]\n")
            f.write("    }" + ("," if pi < len(positions) - 1 else "") + "\n")
        f.write("  ]\n}\n")


if __name__ == "__main__":
    main()
