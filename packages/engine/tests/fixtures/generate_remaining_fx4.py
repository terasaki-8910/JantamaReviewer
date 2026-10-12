"""E-22（受け入れの残り）の正解表を作る（FX-4 の迷いと大きな不一致の 10 場面）。

独立した実装として、Python の `mahjong` ライブラリの向聴計算と、結果 JSON の牌譜（`mjai_log`）の素朴な再生を使う。
TypeScript 側の実装（packages/engine/src/ukeire-remaining.ts、牌譜の再生 replay.ts）には依存しない。

場面: FX-4（結果 5b821c8a048ff791）の
- 迷いマーク 6 つが結びつく判断（ACCEPTANCE E-17・E-27 の、ユーザーが本物のデータで選んだもの）
- 大きな不一致（AI が実戦の行動に付けた確率が 5% 未満の判断。5 つ。迷い 2 は両方に当たる）
のうち、手牌が 3n+2 枚の判断（打牌の判断）。それぞれの場面で、切る牌（種類）ごとに、切ったあとの向聴数・受け入れ牌・
受け入れ牌ごとの「手牌だけの枚数」と「残り」を出す。

残りの決まり（ACCEPTANCE E-22）: 残り = 4 − （切ったあとの自分の手牌にある数）− （場に見えている数）、0 未満にしない。
場に見えている数 = 全員の河（鳴かれた牌は、河では数えず、鳴いた副露の中で 1 回だけ数える）+ 全員の副露 + ドラ表示牌
+ 評価する打牌で切る牌（まだ河に出ていないが、見えているものとして数える）。
ここでは、牌譜の event を順に見て、次のように数える（河と副露を別々に持つ実装とは違う、「見えた牌」の足し合わせ）:
- 局の始め・dora の event: ドラ表示牌を 1 枚
- dahai: 打牌を 1 枚（誰の打牌でも）。鳴かれた牌も、ここで 1 回だけ数える
- chi・pon・daiminkan: 手牌から出した牌（consumed）を 1 枚ずつ（鳴いた牌は、打牌で数えてある）
- ankan: 4 枚。kakan: 加えた牌を 1 枚（ポンの 3 枚は、ポンのときに数えてある）
自分の手牌は、結果 JSON に記録された、その判断の時点の手牌（`state.tehai`。ツモ牌を含む）を使い、牌譜を自分で再生した手牌と
一致することを確かめる（判断が牌譜のどこに当たるかを、取り違えていないことの確認）。

実行（このフォルダで）:

    uv run --with mahjong python generate_remaining_fx4.py

出力: remaining-fx4.json。
"""

import json
from importlib.metadata import version
from pathlib import Path

from mahjong.shanten import Shanten

HERE = Path(__file__).parent
REPORT_ID = "5b821c8a048ff791"
OUT = HERE / "remaining-fx4.json"

# 迷い 1〜6 が結びつく判断（局の通し番号・本場・局の中の判断の番号）。E-17（迷い 1〜5）と E-27（迷い 6）。
MARK_KEYS = ["k0h0e4", "k1h0e12", "k1h1e7", "k1h1e10", "k2h1e6", "k2h1e14"]
THRESHOLD = 0.05

HONORS = "ESWNPFC"
KIND_COUNT = 34


def kind_of(tile: str) -> int:
    if tile in HONORS:
        return 27 + HONORS.index(tile)
    return "mps".index(tile[1]) * 9 + int(tile[0]) - 1


def tile_of(kind: int) -> str:
    """種類（0..33）を、赤でない牌の表記にする。"""
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


def replay_visible(data: dict) -> dict[str, dict]:
    """各判断（キー k<局>h<本場>e<番号>）の時点の、手牌（記録）と、場に見えている牌の枚数を求める。"""
    player = data["player_id"]
    log = data["mjai_log"]
    starts = [i for i, ev in enumerate(log) if ev["type"] == "start_kyoku"]
    scenes: dict[str, dict] = {}
    for position, review_kyoku in enumerate(data["review"]["kyokus"]):
        begin = starts[position]
        end = starts[position + 1] if position + 1 < len(starts) else len(log)
        events = log[begin:end]
        start = events[0]
        entries = review_kyoku["entries"]
        hand = list(start["tehais"][player])
        visible = [0] * KIND_COUNT
        visible[kind_of(start["dora_marker"])] += 1
        tiles_left = 70
        last_actor = None
        last_tile = None
        nxt = 0
        for ev in events[1:]:
            t = ev["type"]
            flags = None  # (at_self_chi_pon, at_self_riichi, at_opponent_kakan)
            if t == "tsumo":
                tiles_left -= 1
                last_actor = ev["actor"]
                if ev["actor"] == player:
                    hand.append(ev["pai"])
                    last_tile = ev["pai"]
                    flags = (False, False, False)
            elif t == "dahai":
                visible[kind_of(ev["pai"])] += 1
                if ev["actor"] == player:
                    hand.remove(ev["pai"])
                else:
                    flags = (False, False, False)
                last_actor = ev["actor"]
                last_tile = ev["pai"]
            elif t in ("chi", "pon", "daiminkan"):
                for c in ev["consumed"]:
                    visible[kind_of(c)] += 1
                if ev["actor"] == player:
                    for c in ev["consumed"]:
                        hand.remove(c)
                    if t != "daiminkan":
                        flags = (True, False, False)
                last_actor = ev["actor"]
            elif t == "ankan":
                for c in ev["consumed"]:
                    visible[kind_of(c)] += 1
                if ev["actor"] == player:
                    for c in ev["consumed"]:
                        hand.remove(c)
                else:
                    flags = (False, False, False)
                last_actor = ev["actor"]
            elif t == "kakan":
                visible[kind_of(ev["pai"])] += 1
                if ev["actor"] == player:
                    hand.remove(ev["pai"])
                else:
                    flags = (False, False, True)
                last_actor = ev["actor"]
                last_tile = ev["pai"]
            elif t == "reach":
                last_actor = ev["actor"]
                if ev["actor"] == player:
                    flags = (False, True, False)
            elif t == "reach_accepted":
                last_actor = ev["actor"]
            elif t == "dora":
                visible[kind_of(ev["dora_marker"])] += 1
            elif t == "hora":
                last_actor = ev["actor"]
            if flags is None or nxt >= len(entries):
                continue
            entry = entries[nxt]
            if (
                entry["last_actor"] != last_actor
                or entry["tile"] != last_tile
                or entry["tiles_left"] != tiles_left
                or (entry["at_self_chi_pon"], entry["at_self_riichi"], entry["at_opponent_kakan"]) != flags
            ):
                continue
            assert sorted(hand) == sorted(entry["state"]["tehai"]), (position, nxt, hand, entry["state"]["tehai"])
            key = f"k{review_kyoku['kyoku']}h{review_kyoku['honba']}e{nxt}"
            scenes[key] = {
                "kyoku": review_kyoku["kyoku"],
                "honba": review_kyoku["honba"],
                "entryIndex": nxt,
                "junme": entry["junme"],
                "hand": list(entry["state"]["tehai"]),
                "visible": list(visible),
                "entry": entry,
            }
            nxt += 1
        assert nxt == len(entries), (position, nxt, len(entries))
    return scenes


def options_of(hand: list[str], visible: list[int]) -> list[dict]:
    """手牌（3n+2 枚）の、切る牌（種類）ごとの結果。"""
    own = counts_of(hand)
    result = []
    for discard in range(KIND_COUNT):
        if own[discard] == 0:
            continue
        after = list(own)
        after[discard] -= 1
        base = shanten(after)
        accepted = []
        for k in range(KIND_COUNT):
            if after[k] >= 4:
                continue
            after[k] += 1
            better = shanten(after) < base
            after[k] -= 1
            if not better:
                continue
            count = 4 - after[k]
            seen = visible[k] + (1 if k == discard else 0)
            accepted.append([tile_of(k), count, max(0, 4 - after[k] - seen)])
        result.append(
            {
                "discard": tile_of(discard),
                "shanten": base,
                "ukeire": sum(a[1] for a in accepted),
                "remaining": sum(a[2] for a in accepted),
                "accepted": accepted,
            }
        )
    return result


def main() -> None:
    data = json.loads((HERE / "reports" / f"{REPORT_ID}.json").read_text(encoding="utf-8"))
    scenes = replay_visible(data)
    assert sum(len(k["entries"]) for k in data["review"]["kyokus"]) == len(scenes) == 70

    chosen: dict[str, list[str]] = {}
    for number, key in enumerate(MARK_KEYS, start=1):
        assert key in scenes, key
        chosen.setdefault(key, []).append(f"迷い{number}")
    for key, scene in scenes.items():
        entry = scene["entry"]
        probability = entry["details"][entry["actual_index"]]["prob"]
        if probability < THRESHOLD:
            chosen.setdefault(key, []).append("大きな不一致")
    assert len(chosen) == 10, sorted(chosen)

    out_scenes = []
    for key in sorted(chosen, key=lambda k: (scenes[k]["kyoku"], scenes[k]["honba"], scenes[k]["entryIndex"])):
        scene = scenes[key]
        hand = scene["hand"]
        options = options_of(hand, scene["visible"]) if len(hand) % 3 == 2 else []
        out_scenes.append(
            {
                "key": key,
                "reasons": chosen[key],
                "junme": scene["junme"],
                "tiles": len(hand),
                "visible": {tile_of(k): n for k, n in enumerate(scene["visible"]) if n},
                "options": options,
            }
        )
        print(key, chosen[key], "tiles", len(hand), "options", len(options))

    document = {
        "description": "E-22: FX-4 の迷いと大きな不一致の 10 場面の、切る牌ごとの受け入れ（手牌だけの枚数と残り）の正解表（Python）",
        "generator": "generate_remaining_fx4.py",
        "library": "mahjong " + version("mahjong"),
        "report": REPORT_ID,
        "scenes": out_scenes,
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library", "report"):
            f.write(f"  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n")
        f.write('  "scenes": [\n')
        for index, scene in enumerate(out_scenes):
            f.write("    {\n")
            for key in ("key", "reasons", "junme", "tiles", "visible"):
                f.write(f"      {json.dumps(key)}: {json.dumps(scene[key], ensure_ascii=False)},\n")
            f.write('      "options": [\n')
            for j, option in enumerate(scene["options"]):
                f.write("        " + json.dumps(option, ensure_ascii=False, separators=(",", ":")) + ("," if j < len(scene["options"]) - 1 else "") + "\n")
            f.write("      ]\n")
            f.write("    }" + ("," if index < len(out_scenes) - 1 else "") + "\n")
        f.write("  ]\n}\n")


if __name__ == "__main__":
    main()
