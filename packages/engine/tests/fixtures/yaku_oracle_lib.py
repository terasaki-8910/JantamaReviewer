"""役の正解表を作る生成スクリプト（generate_yaku*.py）が共有する部品。

独立した実装として Python の `mahjong` ライブラリ（MahjongRepository/mahjong 2.0.0）の `HandCalculator` を使う。
TypeScript 側の実装（packages/engine/src/yaku*.ts）には依存しない。

雀魂の規則に合わせた設定: 喰いタン有り（has_open_tanyao）、ドラ・裏ドラ・赤ドラは数えない（役の判定だけを見る）。
和了の状況は、立直・自摸だけを渡す（一発・嶺上開花・槍槓・海底・河底・ダブル立直は渡さない）。

牌の種類は 0..33（0-8 萬子、9-17 筒子、18-26 索子、27-33 東南西北白發中）。副露は (type, first, open):
  type  seq（順子。first は先頭の牌の種類）| tri（刻子）| kan（槓子）
  open  暗槓だけ false
"""

from mahjong.constants import EAST, NORTH, SOUTH, WEST
from mahjong.hand_calculating.hand import HandCalculator
from mahjong.hand_calculating.hand_config import HandConfig, OptionalRules
from mahjong.meld import Meld

KIND_COUNT = 34
WIND_KINDS = {"E": EAST, "S": SOUTH, "W": WEST, "N": NORTH}
HONOR_LETTERS = "ESWNPFC"


def kind_of_mjai(tile: str) -> int:
    """mjai の牌（5mr は赤五）の種類（0..33）。"""
    if tile in HONOR_LETTERS:
        return 27 + HONOR_LETTERS.index(tile)
    return "mps".index(tile[1]) * 9 + int(tile[0]) - 1


def notation(counts: list[int]) -> str:
    """種類ごとの枚数を、天鳳の牌理の表記（56m46688p1145888s、字牌は 1z-7z）にする。"""
    out = ""
    for suit_index, suit in enumerate("mps"):
        digits = "".join(str(i + 1) * counts[suit_index * 9 + i] for i in range(9))
        if digits:
            out += digits + suit
    honors = "".join(str(i + 1) * counts[27 + i] for i in range(7))
    if honors:
        out += honors + "z"
    return out


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


def meld_counts(melds: list[tuple]) -> list[int]:
    counts = [0] * KIND_COUNT
    for typ, first, _open in melds:
        if typ == "seq":
            for i in range(3):
                counts[first + i] += 1
        else:
            counts[first] += 4 if typ == "kan" else 3
    return counts


def estimate(
    concealed: list[int],
    melds: list[tuple],
    win_kind: int,
    tsumo: bool,
    riichi: bool,
    seat: str,
    round_wind: str,
    dora_indicators: list[int] | None = None,
    ura_indicators: list[int] | None = None,
) -> dict:
    """和了形（閉じた手牌 3n+2 枚と副露）の役を HandCalculator で数える。

    戻り値: error（None か hand_not_winning / no_yaku など）、yaku（ライブラリの役の名前）、han、yakuman。
    dora_indicators を渡したときは、ドラ・裏ドラも数えた飜数 han_with_dora も返す（実戦の和了の確認用）。
    """
    used = [0] * KIND_COUNT

    def take(kind: int) -> int:
        index = kind * 4 + used[kind]
        used[kind] += 1
        assert used[kind] <= 4, f"同じ牌が5枚: {kind}"
        return index

    all_ids: list[int] = []
    meld_objs: list[Meld] = []
    for typ, first, is_open in melds:
        if typ == "seq":
            ids = [take(first), take(first + 1), take(first + 2)]
            meld_objs.append(Meld(meld_type=Meld.CHI, tiles=ids, opened=True))
        elif typ == "tri":
            ids = [take(first) for _ in range(3)]
            meld_objs.append(Meld(meld_type=Meld.PON, tiles=ids, opened=True))
        else:
            ids = [take(first) for _ in range(4)]
            meld_objs.append(Meld(meld_type=Meld.KAN, tiles=ids, opened=is_open))
        all_ids += ids
    concealed_ids: dict[int, list[int]] = {}
    for kind in range(KIND_COUNT):
        for _ in range(concealed[kind]):
            index = take(kind)
            all_ids.append(index)
            concealed_ids.setdefault(kind, []).append(index)
    win_tile = concealed_ids[win_kind][-1]

    config = HandConfig(
        is_tsumo=tsumo,
        is_riichi=riichi,
        player_wind=WIND_KINDS[seat],
        round_wind=WIND_KINDS[round_wind],
        options=OptionalRules(has_open_tanyao=True, has_aka_dora=False),
    )
    dora = [kind * 4 for kind in (dora_indicators or [])]
    ura = [kind * 4 + 1 for kind in (ura_indicators or [])]
    # 表示牌の牌の番号は、手牌と同じ牌を指してもライブラリは種類だけを見る
    result = HandCalculator.estimate_hand_value(
        all_ids, win_tile, melds=meld_objs, dora_indicators=dora, config=config, ura_dora_indicators=ura
    )
    if result.error is not None:
        return {"error": result.error, "yaku": [], "han": 0, "fu": 0, "yakuman": False}
    names = [str(y) for y in result.yaku]
    yakuman = any(y.is_yakuman for y in result.yaku)
    is_dora = lambda y: str(y).startswith(("Dora", "Ura Dora", "Aka Dora"))  # noqa: E731  ライブラリは「Dora 2」のように個数を付ける
    dora_han = sum(y.han_open if any(m.opened for m in meld_objs) else y.han_closed for y in result.yaku if is_dora(y))
    pure = [str(y) for y in result.yaku if not is_dora(y)]
    return {
        "error": None,
        "yaku": pure,
        "han": result.han - dora_han if not yakuman else result.han,
        "han_with_dora": result.han,
        "fu": result.fu,
        "yakuman": yakuman,
        "all": names,
    }
