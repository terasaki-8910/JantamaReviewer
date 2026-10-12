"""FX-3（受け入れ枚数の正解表）を作る。

独立した実装として Python の `mahjong` ライブラリ（MahjongRepository/mahjong）の向聴計算を使い、
手牌ごとの向聴数と、受け入れ枚数（自分の手牌だけを数える、天鳳牌理と同じ数え方）の正解表を書き出す。
TypeScript 側の実装（packages/engine/src/shanten.ts）には依存しない。

実行（このフォルダで）:

    uv run --with mahjong python generate_fx3.py

出力: fx3-shanten-ukeire.json（乱数の種を固定してあるので、同じライブラリのバージョンなら同じ内容になる）。

受け入れ枚数の定め方:
- 3n+1 枚の手牌（13枚など）: ある牌を1枚加えて、手牌全体（3n+2 枚）の向聴数が下がるなら受け入れ。
  残り枚数は 4 - （その牌の手牌の中の枚数）。他家の捨て牌やドラ表示牌は数えない。
- 3n+2 枚の手牌（14枚など）: 牌の種類ごとに1枚切った後の 3n+1 枚で、上と同じ数え方をする。
  切った牌の種類も、手牌から1枚減った状態で数える（切った牌は残り枚数に戻る）。
"""

import json
import random
from importlib.metadata import version
from pathlib import Path

from mahjong.shanten import Shanten

SEED = 20261009
OUT = Path(__file__).with_name("fx3-shanten-ukeire.json")

SUITS = "mps"
KIND_COUNT = 34
ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]


def kind_to_tile(kind: int) -> str:
    """0..33 を mjai の牌（赤なし）にする。0-8 が萬子、9-17 が筒子、18-26 が索子、27-33 が E S W N P F C。"""
    if kind < 27:
        return f"{kind % 9 + 1}{SUITS[kind // 9]}"
    return "ESWNPFC"[kind - 27]


def to_notation(counts: list[int]) -> str:
    """天鳳の牌理の表記（56m46688p1145888s、字牌は 1z-7z）にする。"""
    out = []
    for suit_index, suit in enumerate(SUITS):
        digits = "".join(str(i + 1) * counts[suit_index * 9 + i] for i in range(9))
        if digits:
            out.append(digits + suit)
    honors = "".join(str(i + 1) * counts[27 + i] for i in range(7))
    if honors:
        out.append(honors + "z")
    return "".join(out)


def parse_notation(text: str) -> list[int]:
    counts = [0] * KIND_COUNT
    digits = ""
    for ch in text:
        if ch.isdigit():
            digits += ch
        else:
            base = {"m": 0, "p": 9, "s": 18, "z": 27}[ch]
            for d in digits:
                counts[base + int(d) - 1] += 1
            digits = ""
    assert not digits
    return counts


def shanten(counts: list[int]) -> int:
    return Shanten.calculate_shanten(counts)


def ukeire(counts: list[int]) -> tuple[int, dict[str, int]]:
    """3n+1 枚の手牌の向聴数と、受け入れの牌（種類 -> 残り枚数）。"""
    base = shanten(counts)
    accepts: dict[str, int] = {}
    for kind in range(KIND_COUNT):
        if counts[kind] >= 4:
            continue
        counts[kind] += 1
        after = shanten(counts)
        counts[kind] -= 1
        if after < base:
            accepts[kind_to_tile(kind)] = 4 - counts[kind]
    return base, accepts


def discard_table(counts: list[int]) -> list[dict]:
    """3n+2 枚の手牌の、切る牌の種類ごとの向聴数と受け入れ枚数。"""
    rows = []
    for kind in range(KIND_COUNT):
        if counts[kind] == 0:
            continue
        counts[kind] -= 1
        s, accepts = ukeire(counts)
        counts[kind] += 1
        rows.append({"discard": kind_to_tile(kind), "shanten": s, "ukeire": sum(accepts.values()), "accepts": accepts})
    return rows


def record(style: str, counts: list[int]) -> dict:
    total = sum(counts)
    assert all(c <= 4 for c in counts) and total % 3 != 0 and 1 <= total <= 14, (style, counts)
    rec = {"style": style, "tiles": to_notation(counts), "count": total, "shanten": shanten(counts)}
    if total % 3 == 1:
        s, accepts = ukeire(counts)
        assert s == rec["shanten"]
        rec["ukeire"] = sum(accepts.values())
        rec["accepts"] = accepts
    else:
        rec["discards"] = discard_table(counts)
    return rec


# ---- 手牌の作り方（乱数は種を固定した random.Random だけを使う） ----


def deal_from_wall(rng: random.Random, total: int) -> list[int]:
    """136枚の壁から total 枚を配る（普通の配牌・ツモに近い分布。たいてい 3〜5 向聴）。"""
    wall = [k for k in range(KIND_COUNT) for _ in range(4)]
    rng.shuffle(wall)
    counts = [0] * KIND_COUNT
    for k in wall[:total]:
        counts[k] += 1
    return counts


def deal_weighted(rng: random.Random, total: int, weights: list[float]) -> list[int]:
    """牌の種類ごとの重みに従って、1種類4枚までで total 枚を選ぶ。"""
    counts = [0] * KIND_COUNT
    placed = 0
    while placed < total:
        kind = rng.choices(range(KIND_COUNT), weights=weights)[0]
        if counts[kind] < 4:
            counts[kind] += 1
            placed += 1
    return counts


def flush_weights(rng: random.Random) -> list[float]:
    main = rng.randrange(3)
    weights = [0.0] * KIND_COUNT
    for kind in range(KIND_COUNT):
        if kind < 27 and kind // 9 == main:
            weights[kind] = 6.0
        elif kind >= 27:
            weights[kind] = 1.5
        else:
            weights[kind] = 0.5
    return weights


def pairs_hand(rng: random.Random, total: int) -> list[int]:
    """七対子に近い手（対子を多く、残りは単騎）。"""
    pair_kinds = rng.sample(range(KIND_COUNT), rng.randint(4, 7))
    counts = [0] * KIND_COUNT
    for k in pair_kinds:
        counts[k] = 2
    while sum(counts) > total:
        k = rng.choice([k for k in range(KIND_COUNT) if counts[k] > 0])
        counts[k] -= 1
    while sum(counts) < total:
        k = rng.randrange(KIND_COUNT)
        if counts[k] < 4:
            counts[k] += 1
    return counts


def orphans_hand(rng: random.Random, total: int) -> list[int]:
    """国士無双に近い手（么九牌を多く）。"""
    weights = [8.0 if k in ORPHANS else 0.6 for k in range(KIND_COUNT)]
    return deal_weighted(rng, total, weights)


def complete_hand(rng: random.Random, sets: int) -> list[int]:
    """面子 sets 個と雀頭1つの完成形（2 + 3*sets 枚）を作る。"""
    for _ in range(1000):
        counts = [0] * KIND_COUNT
        ok = True
        for _ in range(sets):
            if rng.random() < 0.35:
                k = rng.randrange(KIND_COUNT)
                if counts[k] + 3 > 4:
                    ok = False
                    break
                counts[k] += 3
            else:
                suit = rng.randrange(3)
                start = rng.randrange(7)
                kinds = [suit * 9 + start + i for i in range(3)]
                if any(counts[k] + 1 > 4 for k in kinds):
                    ok = False
                    break
                for k in kinds:
                    counts[k] += 1
        if not ok:
            continue
        head = rng.randrange(KIND_COUNT)
        if counts[head] + 2 > 4:
            continue
        counts[head] += 2
        return counts
    raise RuntimeError("complete_hand failed")


def near_hand(rng: random.Random, sets: int, total: int) -> list[int]:
    """完成形から何枚か抜いて、別の牌に入れ替えた手（聴牌や1向聴が多い）。"""
    counts = complete_hand(rng, sets)
    drop = rng.randint(0, 3)
    for _ in range(drop):
        k = rng.choice([k for k in range(KIND_COUNT) if counts[k] > 0])
        counts[k] -= 1
    while sum(counts) > total:
        k = rng.choice([k for k in range(KIND_COUNT) if counts[k] > 0])
        counts[k] -= 1
    while sum(counts) < total:
        k = rng.randrange(KIND_COUNT)
        if counts[k] < 4:
            counts[k] += 1
    return counts


def main() -> None:
    rng = random.Random(SEED)
    hands: list[dict] = []

    # 受け入れ基準 FX-3 に書かれた例（打4p 38、打5m・6m・4s・5s 34、打6p・8p 28、打1s 24、打8s 15、いずれも2向聴）
    hands.append(record("fixed", parse_notation("56m46688p1145888s")))

    def add(style: str, make, totals: list[int], n: int) -> None:
        for i in range(n):
            total = totals[i % len(totals)]
            hands.append(record(style, make(total)))

    add("wall", lambda t: deal_from_wall(rng, t), [13, 14], 120)
    add("flush", lambda t: deal_weighted(rng, t, flush_weights(rng)), [13, 14], 60)
    add("pairs", lambda t: pairs_hand(rng, t), [13, 14], 40)
    add("orphans", lambda t: orphans_hand(rng, t), [13, 14], 30)
    add("near", lambda t: near_hand(rng, 4, t), [13, 14], 80)
    # 副露のある手（閉じた牌が 3n+1 / 3n+2 枚で少ない）。ライブラリは枚数から副露の数を推し量る
    melded_totals = [10, 11, 7, 8, 4, 5]
    add("melded", lambda t: near_hand(rng, (t - 2) // 3 if t % 3 == 2 else (t - 1) // 3, t), melded_totals, 60)

    document = {
        "description": "FX-3: 手牌ごとの向聴数と受け入れ枚数の正解表（Python の mahjong ライブラリで作成）",
        "generator": "generate_fx3.py",
        "library": "mahjong " + version("mahjong"),
        "seed": SEED,
        "hands": hands,
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library", "seed"):
            f.write(f'  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n')
        f.write('  "hands": [\n')
        for i, h in enumerate(hands):
            comma = "," if i < len(hands) - 1 else ""
            f.write("    " + json.dumps(h, ensure_ascii=False, separators=(",", ":")) + comma + "\n")
        f.write("  ]\n}\n")
    by_style: dict[str, int] = {}
    for h in hands:
        by_style[h["style"]] = by_style.get(h["style"], 0) + 1
    shanten_hist: dict[int, int] = {}
    for h in hands:
        shanten_hist[h["shanten"]] = shanten_hist.get(h["shanten"], 0) + 1
    print(len(hands), "hands", by_style, "shanten", dict(sorted(shanten_hist.items())))


if __name__ == "__main__":
    main()
