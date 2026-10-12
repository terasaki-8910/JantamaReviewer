"""E-21（場面の向聴数）の正解表を作る。

独立した実装として Python の `mahjong` ライブラリの向聴計算を使い、FX-1 の5半荘と FX-4 の、結果 JSON の全判断
（`review.kyokus[*].entries[*]`）について、場面の向聴数を数える。TypeScript 側の実装（packages/engine/src/scene-shanten.ts）や
牌譜の再生には依存しない。手牌は、結果 JSON の各判断に記録された手牌（`state.tehai`。ツモ牌を含む）をそのまま使う。

場面の向聴数の決まり（ACCEPTANCE E-21）:
- 手牌が 3n+2 枚（打牌の判断。ツモったあとの手）: 切る牌（種類）ごとの向聴数の最小
- 手牌が 3n+1 枚（鳴きの判断。鳴く前の手）: そのままの向聴数
記録の `shanten` は、ツモる前の手のものなので使わない（比べるために、記録の値も出力に添える）。

実行（このフォルダで）:

    uv run --with mahjong python generate_scene_shanten.py

出力: scene-shanten.json。判断の並びは、半荘の順（局の順、局の中の判断の順）。
"""

import json
from importlib.metadata import version
from pathlib import Path

from mahjong.shanten import Shanten

HERE = Path(__file__).parent
OUT = HERE / "scene-shanten.json"
REPORTS = HERE / "reports"
IDS = [
    "f9da87cbcd7af5e9",
    "f738896995c33fed",
    "be0a2a523fdd7758",
    "002ca97adccc486d",
    "3a36dac7c7fc18ce",
    "5b821c8a048ff791",
]

HONORS = "ESWNPFC"
KIND_COUNT = 34


def kind_of(tile: str) -> int:
    """mjai の牌（5mr は赤五）の種類（0..33）。0-8 が萬子、9-17 が筒子、18-26 が索子、27-33 が E S W N P F C。"""
    if tile in HONORS:
        return 27 + HONORS.index(tile)
    return "mps".index(tile[1]) * 9 + int(tile[0]) - 1


def counts_of(tiles: list[str]) -> list[int]:
    counts = [0] * KIND_COUNT
    for tile in tiles:
        counts[kind_of(tile)] += 1
    return counts


def shanten(counts: list[int]) -> int:
    return Shanten.calculate_shanten(counts)


def scene_shanten(tiles: list[str]) -> int:
    counts = counts_of(tiles)
    if len(tiles) % 3 == 2:
        best = 99
        for kind in range(KIND_COUNT):
            if counts[kind] == 0:
                continue
            counts[kind] -= 1
            best = min(best, shanten(counts))
            counts[kind] += 1
        return best
    return shanten(counts)


def main() -> None:
    reports: dict[str, dict] = {}
    for report_id in IDS:
        data = json.loads((REPORTS / f"{report_id}.json").read_text(encoding="utf-8"))
        scene: list[int] = []
        recorded: list[int] = []
        three_n_plus_two = 0
        for kyoku in data["review"]["kyokus"]:
            for entry in kyoku["entries"]:
                tehai = entry["state"]["tehai"]
                scene.append(scene_shanten(tehai))
                recorded.append(entry["shanten"])
                if len(tehai) % 3 == 2:
                    three_n_plus_two += 1
        histogram: dict[str, int] = {}
        for value in scene:
            histogram[str(value)] = histogram.get(str(value), 0) + 1
        reports[report_id] = {
            "decisions": len(scene),
            "discardType": three_n_plus_two,
            "scene": scene,
            "recorded": recorded,
            "histogram": dict(sorted(histogram.items(), key=lambda kv: int(kv[0]))),
        }
        print(report_id, len(scene), "decisions", "scene shanten", reports[report_id]["histogram"])

    document = {
        "description": "E-21: 判断ごとの場面の向聴数の正解表（Python の mahjong ライブラリで作成）",
        "generator": "generate_scene_shanten.py",
        "library": "mahjong " + version("mahjong"),
        "reports": reports,
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library"):
            f.write(f"  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n")
        f.write('  "reports": {\n')
        for index, (report_id, body) in enumerate(reports.items()):
            f.write(f'    "{report_id}": {{\n')
            f.write(f'      "decisions": {body["decisions"]},\n')
            f.write(f'      "discardType": {body["discardType"]},\n')
            f.write(f'      "histogram": {json.dumps(body["histogram"])},\n')
            f.write(f'      "scene": {json.dumps(body["scene"], separators=(",", ":"))},\n')
            f.write(f'      "recorded": {json.dumps(body["recorded"], separators=(",", ":"))}\n')
            f.write("    }" + ("," if index < len(reports) - 1 else "") + "\n")
        f.write("  }\n}\n")


if __name__ == "__main__":
    main()
