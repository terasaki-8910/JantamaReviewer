"""役の判定の正解表を作る（役の表示の調査。analysis/yaku/README.md）。

独立した実装として Python の `mahjong` ライブラリの `HandCalculator` を使い、次の 3 つを書き出す。
TypeScript 側の実装（packages/engine/src/yaku.ts）には依存しない。牌譜の再生も、この中の小さな再生（実戦の和了だけ）を使う。

  complete   乱数で作った和了形（副露・七対子・各種の役の偏りを含む）の役の一覧
  tenpai     乱数で作った聴牌の手（和了形から 1 枚抜いたもの）の、待ちごとの役（ロン）
  wins       実戦の半荘（FX-1・FX-4・FX-5 の 7 半荘）の和了の手の役。同じ手を、牌譜の再生から作る

実行（このフォルダで）:

    uv run --offline --with mahjong python generate_yaku.py

出力: yaku-oracle.json（乱数の種を固定してあるので、同じライブラリのバージョンなら同じ内容になる）。
"""

import json
import random
from collections import Counter
from importlib.metadata import version
from pathlib import Path

from yaku_oracle_lib import (
    KIND_COUNT,
    estimate,
    kind_of_mjai,
    meld_counts,
    notation,
)

HERE = Path(__file__).parent
OUT = HERE / "yaku-oracle.json"
REPORTS = HERE / "reports"
GAMES = [
    "f9da87cbcd7af5e9",
    "f738896995c33fed",
    "be0a2a523fdd7758",
    "002ca97adccc486d",
    "3a36dac7c7fc18ce",
    "5b821c8a048ff791",
    "20261011-153540",
]

SEED = 20261012
COMPLETE_COUNT = 5000
TENPAI_COUNT = 2500
WINDS = "ESWN"


def seq_kinds(first: int) -> list[int]:
    return [first, first + 1, first + 2]


def random_theme(rng: random.Random) -> str:
    return rng.choice(
        [
            "any",
            "any",
            "flush",
            "flush",
            "chinitsu",
            "tanyao",
            "tanyao",
            "terminal",
            "honors",
            "triplets",
            "sequences",
            "sanshoku",
            "ittsu",
            "iipeikou",
            "sanankou",
            "shosangen",
            "doukou",
            "junchan",
            "junchan",
            "chanta",
            "chanta",
            "pinfu",
            "pinfu",
            "pinfu",
            "ryanpeikou",
            "ryanpeikou",
            "kantsu",
            "kantsu",
            "chiitoitsu",
            "chiitoitsu-tanyao",
            "chiitoitsu-flush",
            "chiitoitsu-honors",
        ]
    )


def kind_weights(theme: str, rng: random.Random) -> list[float]:
    suit = rng.randrange(3)
    weights = [1.0] * KIND_COUNT
    for kind in range(KIND_COUNT):
        in_suit = kind < 27 and kind // 9 == suit
        number = kind % 9 if kind < 27 else -1
        if theme in ("flush", "chiitoitsu-flush"):
            weights[kind] = 8.0 if in_suit else (3.0 if kind >= 27 else 0.15)
        elif theme == "chinitsu":
            weights[kind] = 8.0 if in_suit else 0.0
        elif theme in ("tanyao", "chiitoitsu-tanyao"):
            weights[kind] = 1.0 if (kind < 27 and 1 <= number <= 7) else 0.12
        elif theme == "terminal":
            weights[kind] = 5.0 if (kind >= 27 or number in (0, 8)) else 0.3
        elif theme in ("honors", "chiitoitsu-honors"):
            weights[kind] = 6.0 if kind >= 27 else 0.6
    return weights


def pick_kind(weights: list[float], rng: random.Random) -> int:
    return rng.choices(range(KIND_COUNT), weights=weights)[0]


def random_blocks(rng: random.Random) -> tuple[list[tuple[str, int]], str] | None:
    """4 つの面子と 1 つの雀頭（['seq'|'tri', 先頭] ×4 + ['pair', 種類]）。作れなければ None。"""
    theme = random_theme(rng)
    if theme.startswith("chiitoitsu"):
        return None
    weights = kind_weights(theme, rng)
    blocks: list[tuple[str, int]] = []
    if theme == "sanshoku":
        a = rng.randrange(7)
        blocks += [("seq", a), ("seq", 9 + a), ("seq", 18 + a)]
    elif theme == "ittsu":
        s = rng.randrange(3)
        blocks += [("seq", 9 * s), ("seq", 9 * s + 3), ("seq", 9 * s + 6)]
    elif theme == "iipeikou":
        s = rng.randrange(3)
        a = rng.randrange(7)
        blocks += [("seq", 9 * s + a), ("seq", 9 * s + a)]
        if rng.random() < 0.3:
            blocks += [("seq", 9 * s + rng.randrange(7)), ("seq", 9 * s + rng.randrange(7))]
    elif theme == "sanankou":
        for _ in range(3):
            blocks.append(("tri", pick_kind(weights, rng)))
    elif theme == "shosangen":
        dragons = [31, 32, 33]
        rng.shuffle(dragons)
        blocks += [("tri", dragons[0]), ("tri", dragons[1])]
    elif theme == "doukou":
        n = rng.randrange(9)
        blocks += [("tri", n), ("tri", 9 + n), ("tri", 18 + n)]
    elif theme in ("junchan", "chanta"):
        terminals = [0, 8, 9, 17, 18, 26] + ([27, 28, 29, 30, 31, 32, 33] if theme == "chanta" else [])
        while len(blocks) < 4:
            if rng.random() < 0.6:
                blocks.append(("seq", rng.choice([0, 6]) + 9 * rng.randrange(3)))
            else:
                blocks.append(("tri", rng.choice(terminals)))
        pair = rng.choice(terminals)
        blocks.append(("pair", pair))
        rng.shuffle(blocks)
        return blocks, theme
    elif theme == "pinfu":
        while len(blocks) < 4:
            blocks.append(("seq", rng.randrange(3) * 9 + rng.randrange(7)))
        blocks.append(("pair", rng.choice([k for k in range(27)] + [28, 29, 30])))
        rng.shuffle(blocks)
        return blocks, theme
    elif theme == "ryanpeikou":
        s = rng.randrange(3)
        a, b = rng.randrange(7), rng.randrange(7)
        blocks += [("seq", 9 * s + a), ("seq", 9 * s + a), ("seq", 9 * s + b), ("seq", 9 * s + b)]
        blocks.append(("pair", rng.choice(range(KIND_COUNT))))
        rng.shuffle(blocks)
        return blocks, theme
    elif theme == "kantsu":
        for _ in range(4):
            blocks.append(("tri", pick_kind(weights, rng)))
        blocks.append(("pair", pick_kind(weights, rng)))
        rng.shuffle(blocks)
        return blocks, theme
    while len(blocks) < 4:
        if theme == "triplets":
            kind = pick_kind(weights, rng)
            blocks.append(("tri", kind))
        elif theme == "sequences":
            blocks.append(("seq", pick_kind([w if k < 27 and k % 9 <= 6 else 0.0 for k, w in enumerate(weights)], rng)))
        else:
            kind = pick_kind(weights, rng)
            if kind < 27 and kind % 9 <= 6 and rng.random() < 0.65:
                blocks.append(("seq", kind))
            else:
                blocks.append(("tri", kind))
    blocks = blocks[:4]
    if theme == "shosangen":
        free = [k for k in (31, 32, 33) if ("tri", k) not in blocks]
        if not free:
            return None
        pair = free[0]
    else:
        pair = pick_kind(weights, rng)
    blocks.append(("pair", pair))
    rng.shuffle(blocks)
    return blocks, theme


def block_counts(blocks: list[tuple[str, int]]) -> list[int]:
    counts = [0] * KIND_COUNT
    for typ, kind in blocks:
        if typ == "seq":
            for k in seq_kinds(kind):
                counts[k] += 1
        elif typ == "tri":
            counts[kind] += 3
        else:
            counts[kind] += 2
    return counts


def random_complete(rng: random.Random) -> dict | None:
    """和了形 1 つ。閉じた手牌の枚数と副露と和了牌と状況を決める。作れなければ None。"""
    theme = random_theme(rng)
    seat = rng.choice(WINDS)
    round_wind = rng.choice("EES")
    tsumo = rng.random() < 0.5
    if theme.startswith("chiitoitsu"):
        weights = kind_weights(theme, rng)
        kinds: set[int] = set()
        tries = 0
        while len(kinds) < 7 and tries < 500:
            kinds.add(pick_kind(weights, rng))
            tries += 1
        if len(kinds) < 7:
            return None
        counts = [0] * KIND_COUNT
        for k in kinds:
            counts[k] = 2
        win_kind = rng.choice(sorted(kinds))
        return {
            "counts": counts,
            "melds": [],
            "win": win_kind,
            "tsumo": tsumo,
            "riichi": rng.random() < 0.4,
            "seat": seat,
            "round": round_wind,
            "theme": theme,
        }
    made = random_blocks(rng)
    if made is None:
        return None
    blocks, theme = made
    sets = [b for b in blocks if b[0] != "pair"]
    # 副露にする面子を選ぶ（0〜4 つ）
    meld_total = rng.choice([0, 0, 0, 1, 1, 2, 2, 3, 4])
    if theme in ("pinfu", "ryanpeikou"):
        meld_total = 0 if theme == "pinfu" else rng.choice([0, 0, 0, 1])
    if theme == "kantsu":
        meld_total = rng.choice([3, 4])
    rng.shuffle(sets)
    sets.sort(key=lambda b: 0 if (theme == "kantsu" and b[0] == "tri") else 1)
    melds: list[tuple] = []
    concealed_blocks = [b for b in blocks if b[0] == "pair"]
    for index, (typ, kind) in enumerate(sets):
        if index < meld_total:
            if typ == "seq":
                melds.append(("seq", kind, True))
            else:
                if rng.random() < (1.0 if theme == "kantsu" else 0.25):
                    melds.append(("kan", kind, rng.random() < 0.5))
                else:
                    melds.append(("tri", kind, True))
        else:
            concealed_blocks.append((typ, kind))
    counts = block_counts(concealed_blocks)
    # 牌の数の上限（同じ牌は 4 枚まで。副露の分も含める）
    total = meld_counts(melds)
    for k in range(KIND_COUNT):
        if counts[k] + total[k] > 4:
            return None
    win_kind = rng.choice([k for k in range(KIND_COUNT) if counts[k] > 0])
    closed = all(not m[2] for m in melds)
    return {
        "counts": counts,
        "melds": melds,
        "win": win_kind,
        "tsumo": tsumo,
        "riichi": closed and rng.random() < 0.4,
        "seat": seat,
        "round": round_wind,
        "theme": theme,
    }


def serialize_melds(melds: list[tuple]) -> list[list]:
    return [[typ, first, bool(is_open)] for typ, first, is_open in melds]


def complete_records(rng: random.Random) -> tuple[list[dict], dict]:
    records: list[dict] = []
    stats: Counter = Counter()
    while len(records) < COMPLETE_COUNT:
        hand = random_complete(rng)
        if hand is None:
            continue
        oracle = estimate(hand["counts"], hand["melds"], hand["win"], hand["tsumo"], hand["riichi"], hand["seat"], hand["round"])
        if oracle["error"] == "hand_not_winning":
            raise AssertionError(f"和了形のはずが和了形ではない: {notation(hand['counts'])} {hand['melds']}")
        stats["yakuman" if oracle["yakuman"] else ("no_yaku" if oracle["error"] else "yaku")] += 1
        records.append(
            {
                "closed": notation(hand["counts"]),
                "melds": serialize_melds(hand["melds"]),
                "win": hand["win"],
                "tsumo": hand["tsumo"],
                "riichi": hand["riichi"],
                "seat": hand["seat"],
                "round": hand["round"],
                "theme": hand["theme"],
                "oracle": {"error": oracle["error"], "yaku": oracle["yaku"], "han": oracle["han"], "fu": oracle["fu"], "yakuman": oracle["yakuman"]},
            }
        )
    return records, dict(stats)


def tenpai_records(rng: random.Random) -> tuple[list[dict], dict]:
    """和了形から 1 枚抜いた 13 枚の手の、待ちごとの役（ロン。待ちの判定もライブラリに任せる）。"""
    records: list[dict] = []
    stats: Counter = Counter()
    while len(records) < TENPAI_COUNT:
        hand = random_complete(rng)
        if hand is None:
            continue
        counts = list(hand["counts"])
        removable = [k for k in range(KIND_COUNT) if counts[k] > 0]
        counts[rng.choice(removable)] -= 1
        meld_total = meld_counts(hand["melds"])
        riichi = hand["riichi"]
        waits: dict[str, dict] = {}
        yakuman = False
        for kind in range(KIND_COUNT):
            if counts[kind] + meld_total[kind] >= 4:
                continue
            counts[kind] += 1
            result = estimate(counts, hand["melds"], kind, False, riichi, hand["seat"], hand["round"])
            counts[kind] -= 1
            if result["error"] == "hand_not_winning":
                continue
            if result["yakuman"]:
                yakuman = True
            waits[str(kind)] = {"error": result["error"], "yaku": result["yaku"], "han": result["han"], "fu": result["fu"], "yakuman": result["yakuman"]}
        stats["yakuman" if yakuman else "ok"] += 1
        records.append(
            {
                "closed": notation(counts),
                "melds": serialize_melds(hand["melds"]),
                "riichi": riichi,
                "seat": hand["seat"],
                "round": hand["round"],
                "theme": hand["theme"],
                "yakuman": yakuman,
                "waits": waits,
            }
        )
    return records, dict(stats)


def replay_wins(game: str) -> list[dict]:
    """半荘の牌譜（mjai_log）を再生して、和了した手を取り出し、役を数える。"""
    data = json.loads((REPORTS / f"{game}.json").read_text(encoding="utf-8"))
    log = data["mjai_log"]
    player = data["player_id"]
    out: list[dict] = []
    hands: list[list[int]] = [[0] * KIND_COUNT for _ in range(4)]
    melds: list[list[tuple]] = [[] for _ in range(4)]
    riichi = [False] * 4
    round_wind = "E"
    oya = 0
    dora: list[int] = []
    last_discard: tuple[int, int] | None = None
    last_kakan: int | None = None
    kyoku_label = ""
    for index, event in enumerate(log):
        t = event["type"]
        if t == "start_kyoku":
            hands = [[0] * KIND_COUNT for _ in range(4)]
            for seat, row in enumerate(event["tehais"]):
                for tile in row:
                    hands[seat][kind_of_mjai(tile)] += 1
            melds = [[] for _ in range(4)]
            riichi = [False] * 4
            round_wind = event["bakaze"]
            oya = event["oya"]
            dora = [kind_of_mjai(event["dora_marker"])]
            last_discard = None
            last_kakan = None
            kyoku_label = f"{event['bakaze']}{event['kyoku']}局{event['honba']}本場"
        elif t == "tsumo":
            hands[event["actor"]][kind_of_mjai(event["pai"])] += 1
        elif t == "dahai":
            hands[event["actor"]][kind_of_mjai(event["pai"])] -= 1
            last_discard = (event["actor"], kind_of_mjai(event["pai"]))
            last_kakan = None
        elif t in ("chi", "pon", "daiminkan"):
            actor = event["actor"]
            for tile in event["consumed"]:
                hands[actor][kind_of_mjai(tile)] -= 1
            kinds = sorted(kind_of_mjai(x) for x in [event["pai"], *event["consumed"]])
            if t == "chi":
                melds[actor].append(("seq", kinds[0], True))
            elif t == "pon":
                melds[actor].append(("tri", kinds[0], True))
            else:
                melds[actor].append(("kan", kinds[0], True))
            last_discard = None
        elif t == "ankan":
            actor = event["actor"]
            for tile in event["consumed"]:
                hands[actor][kind_of_mjai(tile)] -= 1
            melds[actor].append(("kan", kind_of_mjai(event["consumed"][0]), False))
        elif t == "kakan":
            actor = event["actor"]
            kind = kind_of_mjai(event["pai"])
            hands[actor][kind] -= 1
            melds[actor] = [("kan", kind, True) if (m[0] == "tri" and m[1] == kind) else m for m in melds[actor]]
            last_kakan = kind
        elif t == "reach_accepted":
            riichi[event["actor"]] = True
        elif t == "dora":
            dora.append(kind_of_mjai(event["dora_marker"]))
        elif t == "hora":
            actor = event["actor"]
            tsumo = event["actor"] == event["target"]
            counts = list(hands[actor])
            if tsumo:
                # 直前のツモ牌は手牌に入っている。和了牌は、直前の tsumo の牌
                tsumo_event = next(e for e in reversed(log[:index]) if e["type"] == "tsumo" and e["actor"] == actor)
                win_kind = kind_of_mjai(tsumo_event["pai"])
            else:
                win_kind = last_kakan if last_kakan is not None else (last_discard or (0, 0))[1]
                counts[win_kind] += 1
            ura = [kind_of_mjai(x) for x in event.get("ura_markers", [])]
            seat = "ESWN"[(actor - oya) % 4]
            result = estimate(counts, melds[actor], win_kind, tsumo, riichi[actor], seat, round_wind, dora, ura)
            out.append(
                {
                    "game": game,
                    "kyoku": kyoku_label,
                    "actor": actor,
                    "me": actor == player,
                    "closed": notation(counts),
                    "melds": serialize_melds(melds[actor]),
                    "win": win_kind,
                    "tsumo": tsumo,
                    "riichi": riichi[actor],
                    "seat": seat,
                    "round": round_wind,
                    "oracle": {
                        "error": result["error"],
                        "yaku": result["yaku"],
                        "han": result["han"],
                        "han_with_dora": result.get("han_with_dora", 0),
                        "fu": result["fu"],
                        "yakuman": result["yakuman"],
                    },
                }
            )
    return out


def main() -> None:
    rng = random.Random(SEED)
    complete, complete_stats = complete_records(rng)
    tenpai, tenpai_stats = tenpai_records(rng)
    wins: list[dict] = []
    for game in GAMES:
        wins += replay_wins(game)
    errors = [w for w in wins if w["oracle"]["error"] not in (None, "no_yaku")]
    print("complete", len(complete), complete_stats)
    print("tenpai", len(tenpai), tenpai_stats)
    print("wins", len(wins), "errors", len(errors))
    document = {
        "description": "役の判定の正解表（Python の mahjong ライブラリの HandCalculator で作成）。complete は和了形、tenpai は聴牌の手の待ちごとの役、wins は実戦の和了。",
        "generator": "generate_yaku.py",
        "library": "mahjong " + version("mahjong"),
        "seed": SEED,
        "rules": "喰いタン有り。ドラ・赤ドラは数えない（wins の han_with_dora はドラ・裏ドラ込み）。立直・自摸だけを渡す（一発・嶺上開花・槍槓・海底・河底・ダブル立直は渡さない）。",
        "yaku_names": "ライブラリの役の名前（Tanyao・Yakuhai (haku) など）。TypeScript の役の識別子との対応はテスト側で持つ。",
        "complete": complete,
        "tenpai": tenpai,
        "wins": wins,
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library", "seed", "rules", "yaku_names"):
            f.write(f"  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n")
        for key in ("complete", "tenpai", "wins"):
            f.write(f'  "{key}": [\n')
            rows = document[key]
            for i, row in enumerate(rows):
                f.write("    " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) + ("," if i < len(rows) - 1 else "") + "\n")
            f.write("  ]" + ("," if key != "wins" else "") + "\n")
        f.write("}\n")


if __name__ == "__main__":
    main()
