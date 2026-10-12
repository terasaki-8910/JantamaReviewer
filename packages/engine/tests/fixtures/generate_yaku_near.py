"""近い役の正解表を作る（役の表示の調査。analysis/yaku/README.md）。

手（閉じた手牌 3n+1 枚か 3n+2 枚と副露）から、あと何枚引けばその役の付く和了形になるか（引く枚数 r）を、力ずくで数える。
独立した実装として、和了形かどうかは `mahjong` ライブラリの Agari、役は HandCalculator（generate_yaku.py と同じ設定。自摸和了）に任せる。
TypeScript 側の実装（packages/engine/src/yaku-near.ts。面子を選んで探す方法）とは、探し方が違う。

  3n+1 枚の手: r 枚引いて、r - 1 枚切る（r = 1 が聴牌）。W = 手牌 + 引いた牌 - 切った牌。
  3n+2 枚の手（鳴いた直後など）: r 枚引いて、r 枚切る（r = 0 は和了形そのもの）。
  W が和了形（Agari）なら、和了牌（引いた牌の種類のどれか）ごとに役を数え、役ごとに最小の r を持つ。

r は 3 までを数える（最短の和了が 3 枚先の手は 4 まで。それより遠い役は、力ずくでは数えきれない）。手は、実戦の判断（FX-1・FX-4・FX-5 の 7 半荘の、打牌のあとの手と
鳴いたあとの手）と、乱数で作った手（和了形から何枚かを入れ替えたもの。珍しい役が出てくるように、偏りを付けて作る）。

実行（このフォルダで。CPU を使うので、数分かかる）:

    uv run --offline --with mahjong python generate_yaku_near.py

出力: yaku-near.json（乱数の種を固定してあるので、同じライブラリのバージョンなら同じ内容になる）。
"""

import json
import random
from collections import Counter
from importlib.metadata import version
from itertools import combinations_with_replacement
from multiprocessing import Pool
from pathlib import Path

from mahjong.agari import Agari

from generate_yaku import GAMES, REPORTS, WINDS, random_complete
from yaku_oracle_lib import KIND_COUNT, estimate, kind_of_mjai, meld_counts, notation

HERE = Path(__file__).parent
OUT = HERE / "yaku-near.json"
SEED = 20261013
RMAX = 3
REAL_DISCARD_EVERY = 5
REAL_CALL_EVERY = 3
SYNTHETIC_13 = 140
SYNTHETIC_14 = 36

IGNORED = {"Menzen Tsumo", "Riichi"}


def brute(counts: list[int], melds: list[tuple], seat: str, round_wind: str, rmax: int = RMAX) -> dict:
    """力ずくで、役ごとの最小の r と、最短の和了（役を問わない）の r を求める。"""
    meld_total = meld_counts(melds)
    cap = [4 - meld_total[k] for k in range(KIND_COUNT)]
    sets = 4 - len(melds)
    full = 3 * sets + 2
    total = sum(counts)
    assert total in (full - 1, full), (total, full)
    after_call = total == full
    best: dict[str, int] = {}
    min_r: int | None = None
    hand_kinds = [k for k in range(KIND_COUNT) if counts[k] > 0]
    for r in range(0 if after_call else 1, rmax + 1):
        discards = r if after_call else r - 1
        for x in combinations_with_replacement(hand_kinds, discards):
            base = list(counts)
            ok = True
            for k in x:
                base[k] -= 1
                if base[k] < 0:
                    ok = False
                    break
            if not ok:
                continue
            for d in combinations_with_replacement(range(KIND_COUNT), r):
                w = base[:]
                fits = True
                for k in d:
                    w[k] += 1
                    if w[k] > cap[k]:
                        fits = False
                        break
                if not fits or not Agari.is_agari(w):
                    continue
                if min_r is None:
                    min_r = r
                if r == 0:
                    continue
                for win in sorted(set(d)):
                    result = estimate(w, melds, win, True, False, seat, round_wind)
                    if result["error"] == "hand_not_winning" or result["yakuman"]:
                        continue
                    for name in result["yaku"]:
                        if name not in IGNORED and name not in best:
                            best[name] = r
    return {"min_r": min_r, "by_yaku": best}


def work(sample: dict) -> dict:
    from yaku_oracle_lib import parse_notation

    counts = parse_notation(sample["closed"])
    melds = [(t, f, o) for t, f, o in sample["melds"]]
    result = brute(counts, melds, sample["seat"], sample["round"])
    rmax = RMAX
    if result["min_r"] == RMAX:
        # 最短の和了が 3 枚先の手（2 向聴）は、遠回り 1 枚までを調べるのに、4 枚先まで数える
        rmax = RMAX + 1
        result = brute(counts, melds, sample["seat"], sample["round"], rmax)
    return {**sample, **result, "rmax_used": rmax}


def real_samples() -> list[dict]:
    """実戦の判断から、打牌のあとの手と鳴いたあとの手を取る。"""
    samples: list[dict] = []
    for game in GAMES:
        data = json.loads((REPORTS / f"{game}.json").read_text(encoding="utf-8"))
        player = data["player_id"]
        starts = [e for e in data["mjai_log"] if e["type"] == "start_kyoku"]
        discard_index = 0
        call_index = 0
        for kyoku_position, kyoku in enumerate(data["review"]["kyokus"]):
            start = starts[kyoku_position]
            seat = WINDS[(player - start["oya"]) % 4]
            round_wind = start["bakaze"]
            for entry_index, entry in enumerate(kyoku["entries"]):
                state = entry["state"]
                tehai = [kind_of_mjai(t) for t in state["tehai"]]
                melds = []
                for m in state["fuuros"]:
                    kinds = sorted(kind_of_mjai(x) for x in ([m["pai"]] if m["type"] != "ankan" else []) + m["consumed"])
                    if m["type"] == "chi":
                        melds.append(("seq", kinds[0], True))
                    elif m["type"] == "pon":
                        melds.append(("tri", kinds[0], True))
                    elif m["type"] == "ankan":
                        melds.append(("kan", kinds[0], False))
                    elif m["type"] == "kakan":
                        melds.append(("kan", kinds[0], True))
                    else:
                        melds.append(("kan", kinds[0], True))
                counts = [0] * KIND_COUNT
                for k in tehai:
                    counts[k] += 1
                base = {"game": game, "kyoku": kyoku_position, "entry": entry_index, "seat": seat, "round": round_wind}
                full = 3 * (4 - len(melds)) + 2
                top = entry["details"][0]["action"] if entry["details"] else None
                if len(tehai) == full and top is not None and top["type"] == "dahai" and entry["shanten"] <= 2:
                    discard_index += 1
                    if discard_index % REAL_DISCARD_EVERY != 0:
                        continue
                    w = list(counts)
                    w[kind_of_mjai(top["pai"])] -= 1
                    samples.append({**base, "source": f"real-discard {top['pai']}", "closed": notation(w), "melds": [list(m) for m in melds]})
                elif len(tehai) == full - 1 and entry["last_actor"] != player and not entry["at_self_chi_pon"] and entry["shanten"] <= 2:
                    call_index += 1
                    if call_index % REAL_CALL_EVERY != 0:
                        continue
                    actions = [d["action"] for d in entry["details"]]
                    pass_sample = {**base, "source": "real-pass", "closed": notation(counts), "melds": [list(m) for m in melds]}
                    samples.append(pass_sample)
                    for action in actions:
                        if action["type"] in ("chi", "pon"):
                            kinds = sorted(kind_of_mjai(x) for x in [action["pai"], *action["consumed"]])
                            meld = ("seq", kinds[0], True) if action["type"] == "chi" else ("tri", kinds[0], True)
                            w2 = list(counts)
                            for tile in action["consumed"]:
                                w2[kind_of_mjai(tile)] -= 1
                            samples.append({**base, "source": f"real-{action['type']}", "closed": notation(w2), "melds": [list(m) for m in [*melds, meld]]})
                            break
    return samples


def synthetic_samples(rng: random.Random) -> list[dict]:
    """和了形から、何枚かを別の牌に入れ替えた手（珍しい役が出てくるように偏りを付けた和了形から作る）。"""
    samples: list[dict] = []
    want_13, want_14 = SYNTHETIC_13, SYNTHETIC_14
    while want_13 > 0 or want_14 > 0:
        hand = random_complete(rng)
        if hand is None:
            continue
        counts = list(hand["counts"])
        meld_total = meld_counts(hand["melds"])
        swaps = rng.choice([0, 1, 1, 2])
        after_call = want_14 > 0 and (want_13 == 0 or rng.random() < 0.2)
        if not after_call:
            removable = [k for k in range(KIND_COUNT) if counts[k] > 0]
            counts[rng.choice(removable)] -= 1
        for _ in range(swaps):
            removable = [k for k in range(KIND_COUNT) if counts[k] > 0]
            counts[rng.choice(removable)] -= 1
            for _try in range(30):
                k = rng.randrange(KIND_COUNT)
                if counts[k] + meld_total[k] < 4:
                    counts[k] += 1
                    break
            else:
                counts[rng.choice([k for k in range(KIND_COUNT) if counts[k] + meld_total[k] < 4])] += 1
        if after_call:
            if swaps == 0:
                continue  # 和了形そのものは除く
            want_14 -= 1
        else:
            want_13 -= 1
        samples.append(
            {
                "game": "synthetic",
                "kyoku": 0,
                "entry": len(samples),
                "seat": hand["seat"],
                "round": hand["round"],
                "source": f"synthetic-{'14' if after_call else '13'} {hand['theme']}",
                "closed": notation(counts),
                "melds": [[t, f, bool(o)] for t, f, o in hand["melds"]],
            }
        )
    return samples


def main() -> None:
    rng = random.Random(SEED)
    samples = real_samples() + synthetic_samples(rng)
    print("samples", len(samples), Counter(s["source"].split(" ")[0] for s in samples))
    with Pool(max(1, min(30, len(samples)))) as pool:
        results = pool.map(work, samples, chunksize=1)
    far = sum(1 for r in results if r["min_r"] is None)
    print("done; min_r over RMAX:", far)
    document = {
        "description": "近い役の正解表: 手ごとに、役ごとの最小の「引く枚数 r」を力ずくで数えた値（Python の mahjong ライブラリ。r は 3 まで。最短の和了が 3 枚先の手は 4 まで。数えた上限は rmax_used）",
        "generator": "generate_yaku_near.py",
        "library": "mahjong " + version("mahjong"),
        "seed": SEED,
        "rmax": RMAX,
        "rules": "喰いタン有り。自摸和了として数える（門前清自摸和・立直は数えない）。和了牌は、引いた牌の種類のどれか。役満の和了形は数えない。",
        "samples": results,
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        for key in ("description", "generator", "library", "seed", "rmax", "rules"):
            f.write(f"  {json.dumps(key)}: {json.dumps(document[key], ensure_ascii=False)},\n")
        f.write('  "samples": [\n')
        for i, row in enumerate(results):
            f.write("    " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) + ("," if i < len(results) - 1 else "") + "\n")
        f.write("  ]\n}\n")


if __name__ == "__main__":
    main()
