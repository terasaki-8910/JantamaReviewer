"""MAKA の評価の当てはめ（E-13）の正解表を作る。

scikit-learn の IsotonicRegression(out_of_bounds='clip') を独立した実装として使い、次を書き出す。
- analysis/maka-fit/dataset.csv の67局について、半荘を1つずつ外す検証（LOGO）の予測値
- dataset.csv 全体で当てはめたときのしきい値と、いくつかの点での予測値
- 手で作った小さなデータ（同じ点数が重なる・重みがある・単調に増える・減るなど）での、しきい値と予測値

TypeScript 側（packages/engine/src/isotonic.ts）の実装は、これと 1e-9 以内で一致することをテストする。

実行（このフォルダで）:

    uv run --with numpy --with scipy --with scikit-learn python generate_maka_fit.py

出力: maka-fit-logo.json
"""

import csv
import json
import random
from importlib.metadata import version
from pathlib import Path

import numpy as np
from sklearn.isotonic import IsotonicRegression

HERE = Path(__file__).resolve().parent
DATASET = HERE.parents[3] / "analysis" / "maka-fit" / "dataset.csv"
OUT = HERE / "maka-fit-logo.json"
SEED = 20261009
GRADES = ["E", "D", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S-", "S", "S+"]


def to_grade_index(pred: float) -> int:
    """四捨五入（.5 は切り上げ）して 0..13 に収める。analysis/maka-fit/fit.py の summary と同じ。"""
    return int(np.clip(np.floor(pred + 0.5), 0, 13))


def fit_model(x, y, weights=None) -> IsotonicRegression:
    return IsotonicRegression(out_of_bounds="clip").fit(np.asarray(x, dtype=float), np.asarray(y, dtype=float), sample_weight=weights)


def case(name: str, x, y, weights, probes) -> dict:
    model = fit_model(x, y, weights)
    expected = [float(v) for v in model.predict(np.asarray(probes, dtype=float))]
    return {
        "name": name,
        "x": list(map(float, x)),
        "y": list(map(float, y)),
        "weights": None if weights is None else list(map(float, weights)),
        "xThresholds": [float(v) for v in model.X_thresholds_],
        "yThresholds": [float(v) for v in model.y_thresholds_],
        "probes": list(map(float, probes)),
        "expected": expected,
    }


def probes_for(x, rng: random.Random) -> list[float]:
    xs = sorted(set(float(v) for v in x))
    lo, hi = xs[0], xs[-1]
    out = [lo - 10.0, lo - 1e-9, lo, hi, hi + 1e-9, hi + 10.0]
    for a, b in zip(xs, xs[1:]):
        out += [a, (a + b) / 2, a + (b - a) / 3, b - (b - a) / 7, b]
    out += [rng.uniform(lo - 1, hi + 1) for _ in range(8)]
    return out


def synthetic_cases(rng: random.Random) -> list[dict]:
    cases = []
    # 決まった形
    cases.append(case("single-point", [50.0], [7], None, [0.0, 50.0, 100.0]))
    cases.append(case("all-x-equal", [10.0, 10.0, 10.0, 10.0], [3, 5, 4, 12], None, [0.0, 10.0, 20.0]))
    cases.append(case("increasing", [1.0, 2.0, 3.0, 4.0], [0, 3, 7, 13], None, probes_for([1.0, 2.0, 3.0, 4.0], rng)))
    cases.append(case("decreasing", [1.0, 2.0, 3.0, 4.0], [13, 7, 3, 0], None, probes_for([1.0, 2.0, 3.0, 4.0], rng)))
    cases.append(case("plateau", [1.0, 2.0, 3.0, 4.0, 5.0], [2, 5, 5, 5, 9], None, probes_for([1, 2, 3, 4, 5], rng)))
    cases.append(case("ties-and-violations", [3.0, 1.0, 2.0, 2.0, 5.0, 4.0, 4.0, 4.0], [9, 1, 8, 2, 12, 3, 11, 7], None, probes_for([1, 2, 3, 4, 5], rng)))
    cases.append(case("weights", [1.0, 2.0, 3.0, 4.0, 5.0], [4, 2, 9, 3, 11], [1.0, 3.0, 0.5, 2.0, 1.0], probes_for([1, 2, 3, 4, 5], rng)))
    cases.append(case("zero-weights-are-ignored", [1.0, 2.0, 3.0, 4.0], [10, 0, 5, 13], [1.0, 0.0, 2.0, 1.0], probes_for([1, 2, 3, 4], rng)))
    # 乱数（点数が重なるもの・重ならないもの・重みつき）
    for i in range(24):
        n = rng.choice([2, 3, 5, 8, 13, 21, 40])
        if i % 3 == 0:
            xs = [float(rng.randint(0, 6)) / 2 for _ in range(n)]
        else:
            xs = [round(rng.uniform(0, 100), 3) for _ in range(n)]
        ys = [rng.randint(0, 13) for _ in range(n)]
        w = [round(rng.uniform(0.25, 3.0), 3) for _ in range(n)] if i % 4 == 3 else None
        cases.append(case(f"random-{i}", xs, ys, w, probes_for(xs, rng)))
    return cases


def main() -> None:
    with DATASET.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    games = [r["game"] for r in rows]
    y = np.array([float(r["y"]) for r in rows])
    x = np.array([float(r["rating"]) * 100 for r in rows])

    logo = np.zeros_like(y)
    for g in sorted(set(games), key=games.index):
        test = np.array([gg == g for gg in games])
        model = fit_model(x[~test], y[~test])
        logo[test] = model.predict(x[test])

    grade_idx = np.array([to_grade_index(p) for p in logo])
    err = np.abs(grade_idx - y)
    summary = {
        "exact": round(float(np.mean(err == 0)), 3),
        "withinOne": round(float(np.mean(err <= 1)), 3),
        "withinTwo": round(float(np.mean(err <= 2)), 3),
        "mae": round(float(np.mean(err)), 2),
    }

    hands = [
        {
            "game": r["game"],
            "idx": int(r["idx"]),
            "label": r["label"],
            "grade": r["grade"],
            "y": int(float(r["y"])),
            "score": float(r["rating"]) * 100,
            "logo": float(logo[i]),
            "logoGrade": int(grade_idx[i]),
        }
        for i, r in enumerate(rows)
    ]

    full = fit_model(x, y)
    grid = [float(v) for v in np.arange(-5.0, 106.0, 0.5)]
    full_fit = {
        "xThresholds": [float(v) for v in full.X_thresholds_],
        "yThresholds": [float(v) for v in full.y_thresholds_],
        "probes": grid + [float(v) for v in x],
        "expected": [float(v) for v in full.predict(np.array(grid + [float(v) for v in x]))],
    }

    rng = random.Random(SEED)
    document = {
        "description": "E-13: 点数から段階への当てはめ（単調な当てはめ）の正解表。scikit-learn の IsotonicRegression(out_of_bounds='clip') で作成",
        "generator": "generate_maka_fit.py",
        "library": f"scikit-learn {version('scikit-learn')} / scipy {version('scipy')} / numpy {version('numpy')}",
        "seed": SEED,
        "grades": GRADES,
        "summary": summary,
        "hands": hands,
        "fullFit": full_fit,
        "cases": synthetic_cases(rng),
    }
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(document, f, ensure_ascii=False, indent=None, separators=(",", ":"))
        f.write("\n")
    print("summary", summary, "hands", len(hands), "cases", len(document["cases"]), "thresholds", len(full_fit["xThresholds"]))


if __name__ == "__main__":
    main()
