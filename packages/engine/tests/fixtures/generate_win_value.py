"""待ちと打点・待ちの形・符の内訳の正解表を作る（F14、E-36〜E-38）。

独立した実装として Python の `mahjong` ライブラリ（MahjongRepository/mahjong 2.0.0）の `HandCalculator` を使い、次の 2 つを書き出す。
TypeScript 側の実装（packages/engine/src/wait-value.ts・fu-detail.ts・majiang-adapter.ts）には依存しない。

  hands    実戦の聴牌になる手（win-value-hands.json。TypeScript が書き出した手牌・副露・風・ドラ表示牌だけ）。待ちを Python が自分で調べ
           （和了形になる牌。手牌と副露で 4 枚そろった牌は除く）、待ちごとに、ダマ・リーチ × ロン・ツモの役・飜・符・点数・符の内訳（fu_details）を計算する。
           同じ手を、自風を 1 つずらして本場 1・供託 1 を付けた変種（variant）でも計算する（本場・供託を含む点数の確かめ）
  random   乱数で作った和了形（yaku-oracle.json の complete の一部。副露・七対子・各種の偏りを含む）の符の内訳

雀魂の規則に合わせた設定: 喰いタン有り（has_open_tanyao）、赤ドラ有り（has_aka_dora）、切り上げ満貫なし（既定）。裏ドラ・一発・海底などは渡さない。
和了牌は赤でない牌（赤ドラは、手牌の中の赤だけを数える）。

手順（packages/engine で）:

    WIN_VALUE_DUMP=1 pnpm exec vitest run tests/win-value-dump.test.ts   # win-value-hands.json を作る
    cd tests/fixtures
    uv run --offline --with mahjong python generate_win_value.py          # win-value-oracle.json を作る

出力: win-value-oracle.json（乱数を使うのは random の選び方だけで、番号の間隔で選ぶので、同じライブラリの版なら同じ内容になる）。
"""

import json
from importlib.metadata import version
from pathlib import Path

from mahjong.constants import EAST, NORTH, SOUTH, WEST
from mahjong.hand_calculating.hand import HandCalculator
from mahjong.hand_calculating.hand_config import HandConfig, OptionalRules
from mahjong.meld import Meld

from yaku_oracle_lib import KIND_COUNT, parse_notation

HERE = Path(__file__).parent
HANDS = HERE / "win-value-hands.json"
YAKU_ORACLE = HERE / "yaku-oracle.json"
OUT = HERE / "win-value-oracle.json"

HONORS = "ESWNPFC"
WIND = {"E": EAST, "S": SOUTH, "W": WEST, "N": NORTH}
RED_ID = {4: 16, 13: 52, 22: 88}  # 赤五（萬・筒・索）の 136 形式の ID
RANDOM_EVERY = 3  # yaku-oracle.json の complete から、この間隔で選ぶ


def kind_of(tile: str) -> int:
    if tile in HONORS:
        return 27 + HONORS.index(tile)
    return "mps".index(tile[1]) * 9 + int(tile[0]) - 1


class Pool:
    """136 形式の ID を、同じ種類から重ならないように配る（赤五は決まった ID）。"""

    def __init__(self, aka: bool = True) -> None:
        self.used: set[int] = set()
        # aka が False（赤ドラを数えない計算）のときは、赤の ID も普通の牌として配る（五を 4 枚使う手がある）
        self.aka = aka

    def take(self, tile: str) -> int:
        kind = kind_of(tile)
        if len(tile) == 3:
            tid = RED_ID[kind]
            assert tid not in self.used, f"赤が 2 枚: {tile}"
            self.used.add(tid)
            return tid
        for i in range(4):
            tid = kind * 4 + i
            if self.aka and kind in RED_ID and tid == RED_ID[kind]:
                continue
            if tid not in self.used:
                self.used.add(tid)
                return tid
        raise AssertionError(f"同じ牌が足りない: {tile}")


def meld_of(m: dict, pool: Pool) -> tuple[Meld, list[int]]:
    t = m["type"]
    if t == "chi":
        ids = [pool.take(x) for x in [m["pai"], *m["consumed"]]]
        return Meld(meld_type=Meld.CHI, tiles=sorted(ids), opened=True), ids
    if t == "pon":
        ids = [pool.take(x) for x in [m["pai"], *m["consumed"]]]
        return Meld(meld_type=Meld.PON, tiles=sorted(ids), opened=True), ids
    if t == "daiminkan":
        ids = [pool.take(x) for x in [m["pai"], *m["consumed"]]]
        return Meld(meld_type=Meld.KAN, tiles=sorted(ids), opened=True), ids
    if t == "kakan":
        ids = [pool.take(x) for x in [m["previous_pon_pai"], *m["consumed"], m["pai"]]]
        return Meld(meld_type=Meld.SHOUMINKAN, tiles=sorted(ids), opened=True), ids
    ids = [pool.take(x) for x in m["consumed"]]
    return Meld(meld_type=Meld.KAN, tiles=sorted(ids), opened=False), ids


def meld_kind_counts(melds: list[dict]) -> list[int]:
    counts = [0] * KIND_COUNT
    for m in melds:
        tiles = {
            "chi": lambda: [m["pai"], *m["consumed"]],
            "pon": lambda: [m["pai"], *m["consumed"]],
            "daiminkan": lambda: [m["pai"], *m["consumed"]],
            "kakan": lambda: [m["previous_pon_pai"], *m["consumed"], m["pai"]],
            "ankan": lambda: m["consumed"],
        }[m["type"]]()
        for t in tiles:
            counts[kind_of(t)] += 1
    return counts


def compact(result) -> dict:
    """計算結果を、正解表に書く形にする（e: エラー、h: 飜、f: 符、m・a: 支払い、t: 勝者の受け取り合計、y: 役、x: 役満、d: 符の内訳）。"""
    if result.error is not None:
        return {"e": result.error}
    cost = result.cost or {}
    return {
        "e": None,
        "h": result.han,
        "f": result.fu,
        "m": cost.get("main", 0),
        "a": cost.get("additional", 0),
        "t": cost.get("total", 0),
        "y": [str(y) for y in result.yaku],
        "x": any(y.is_yakuman for y in result.yaku),
        "d": [[d["reason"], d["fu"]] for d in (result.fu_details or [])],
    }


def calc(closed: list[str], melds: list[dict], win_tile: str, tsumo: bool, riichi: bool, seat: int, round_wind: str, dora: list[str], honba: int, kyotaku: int, aka: bool = True) -> dict:
    """和了形（閉じた手牌 3n+1 枚 + 和了牌）を HandCalculator で計算する。seat は自風を、親からの相対席で。"""
    pool = Pool(aka)
    meld_objs: list[Meld] = []
    all_ids: list[int] = []
    for m in melds:
        meld, ids = meld_of(m, pool)
        meld_objs.append(meld)
        all_ids += ids
    closed_ids = [pool.take(t) for t in closed]
    try:
        win_id = pool.take(win_tile)
    except AssertionError:
        # 手牌に赤でない五が 3 枚あるとき、4 枚目の本物は赤。和了牌は赤でない牌として数える決まりなので、赤でない ID を重ねて使う
        # （ライブラリは、ID が赤の ID かどうかと、種類だけを見る）
        win_id = kind_of(win_tile) * 4 + 3
    all_ids += closed_ids + [win_id]
    # ドラ表示牌の ID は、手牌の ID と重ならなくてよい（ライブラリは種類だけを見る）。赤の ID を避けて、各種類の 4 番目を使う
    dora_ids = [kind_of(t) * 4 + 3 for t in dora]
    config = HandConfig(
        is_tsumo=tsumo,
        is_riichi=riichi,
        player_wind=WIND["ESWN"[seat]],
        round_wind=WIND[round_wind],
        kyoutaku_number=kyotaku,
        tsumi_number=honba,
        options=OptionalRules(has_open_tanyao=True, has_aka_dora=aka),
    )
    result = HandCalculator.estimate_hand_value(all_ids, win_id, melds=meld_objs, dora_indicators=dora_ids, config=config)
    return compact(result)


def hand_record(hand: dict) -> dict:
    closed = hand["closed"]
    melds = hand["melds"]
    held = [0] * KIND_COUNT
    for t in closed:
        held[kind_of(t)] += 1
    for kind, n in enumerate(meld_kind_counts(melds)):
        held[kind] += n
    closed_menzen = all(m["type"] == "ankan" for m in melds)
    waits: list[int] = []
    cases: dict[str, dict] = {}
    names = "123456789"
    for kind in range(KIND_COUNT):
        if held[kind] >= 4:
            continue
        tile = "ESWNPFC"[kind - 27] if kind >= 27 else names[kind % 9] + "mps"[kind // 9]
        probe = calc(closed, melds, tile, False, False, hand["seat"], hand["round"], hand["dora"], 0, 0)
        if probe["e"] == HandCalculator.ERR_HAND_NOT_WINNING:
            continue
        waits.append(kind)
        row: dict[str, dict] = {}
        for variant in ("base", "variant"):
            seat = hand["seat"] if variant == "base" else (hand["seat"] + 1) % 4
            honba = 0 if variant == "base" else 1
            kyotaku = 0 if variant == "base" else 1
            for riichi in ((False, True) if closed_menzen else (False,)):
                for tsumo in (False, True):
                    key = f"{variant}-{'riichi' if riichi else 'dama'}-{'tsumo' if tsumo else 'ron'}"
                    row[key] = calc(closed, melds, tile, tsumo, riichi, seat, hand["round"], hand["dora"], honba, kyotaku)
        cases[str(kind)] = row
    return {"id": hand["id"], "waits": waits, "cases": cases}


def random_records() -> list[dict]:
    """yaku-oracle.json の complete（乱数で作った和了形）の一部の、符の内訳。"""
    complete = json.loads(YAKU_ORACLE.read_text(encoding="utf-8"))["complete"]
    out: list[dict] = []
    for index, r in enumerate(complete):
        if index % RANDOM_EVERY != 0 or r["oracle"]["error"] == HandCalculator.ERR_HAND_NOT_WINNING:
            continue
        tiles = parse_notation(r["closed"])
        pool_melds = []
        for typ, first, is_open in r["melds"]:
            if typ == "seq":
                ids = [first, first + 1, first + 2]
            else:
                ids = [first] * (4 if typ == "kan" else 3)
            pool_melds.append((typ, ids, is_open))
        # 乱数の和了形は、種類で持っている。ここでは、種類を牌（赤でない）にして、calc に渡す
        def tile_of(kind: int) -> str:
            return "ESWNPFC"[kind - 27] if kind >= 27 else "123456789"[kind % 9] + "mps"[kind // 9]

        closed: list[str] = []
        win_kind = r["win"]
        counts = list(tiles)
        counts[win_kind] -= 1  # 和了牌を、閉じた手牌から外す
        for kind in range(KIND_COUNT):
            closed += [tile_of(kind)] * counts[kind]
        melds: list[dict] = []
        for typ, ids, is_open in pool_melds:
            tiles_m = [tile_of(k) for k in ids]
            if typ == "seq":
                melds.append({"type": "chi", "target": 3, "pai": tiles_m[0], "consumed": tiles_m[1:]})
            elif typ == "tri":
                melds.append({"type": "pon", "target": 1, "pai": tiles_m[0], "consumed": tiles_m[1:]})
            elif is_open:
                melds.append({"type": "daiminkan", "target": 1, "pai": tiles_m[0], "consumed": tiles_m[1:]})
            else:
                melds.append({"type": "ankan", "consumed": tiles_m})
        seat = "ESWN".index(r["seat"])
        result = calc(closed, melds, tile_of(win_kind), r["tsumo"], r["riichi"] and all(m["type"] == "ankan" for m in melds), seat, r["round"], [], 0, 0, aka=False)
        out.append({"id": f"random-{index}", "closed": r["closed"], "melds": r["melds"], "win": win_kind, "tsumo": r["tsumo"], "riichi": r["riichi"] and all(m["type"] == "ankan" for m in melds), "seat": r["seat"], "round": r["round"], "result": result})
    return out


def main() -> None:
    hands = json.loads(HANDS.read_text(encoding="utf-8"))["hands"]
    records = [hand_record(h) for h in hands]
    randoms = random_records()
    n_cases = sum(len(row) for r in records for row in r["cases"].values())
    print("hands", len(records), "waits", sum(len(r["waits"]) for r in records), "cases", n_cases, "random", len(randoms))
    document = {
        "description": "待ちと打点・符の内訳の正解表（Python の mahjong ライブラリの HandCalculator で作成）。hands は実戦の聴牌になる手の待ちごとの結果、random は乱数の和了形の符の内訳。",
        "generator": "generate_win_value.py",
        "library": "mahjong " + version("mahjong"),
        "rules": "喰いタン有り・赤ドラ有り・切り上げ満貫なし。裏ドラ・一発・海底などは渡さない。和了牌は赤でない牌。variant は、自風を 1 つずらして本場 1・供託 1 を付けたもの。",
        "keys": "e: エラー、h: 飜（ドラ込み）、f: 符、m・a: ロンの支払い（ツモは子の支払い・親の支払い）、t: 和了者の受け取り合計（本場・供託込み）、y: 役の名前、x: 役満、d: 符の内訳 [理由, 符]",
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library", "rules", "keys"):
            f.write(f"  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n")
        for key, rows in (("hands", records), ("random", randoms)):
            f.write(f'  "{key}": [\n')
            for i, row in enumerate(rows):
                f.write("    " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) + ("," if i < len(rows) - 1 else "") + "\n")
            f.write("  ]" + ("," if key == "hands" else "") + "\n")
        f.write("}\n")


if __name__ == "__main__":
    main()
