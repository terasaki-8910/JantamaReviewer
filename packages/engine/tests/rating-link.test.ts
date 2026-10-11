import { describe, expect, it } from 'vitest';

import type { CenterText } from '../src/center-text';
import { kyokuFactsOf } from '../src/kyoku-locate';
import { alignRatings } from '../src/rating-alignment';
import { HAND_START_TILES_LEFT, type RatingLinkInput, linkRatings } from '../src/rating-link';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX4_ID, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

type Mark = 'good' | 'fair' | 'bad';
type Rated = RatingLinkInput & { id: number; rating: Mark };

const MARKS: Mark[] = ['good', 'fair', 'bad'];

/** 局の位置・残りの牌の数から、その局の始めの点数で読んだ画面の中央の読み取りを作る。 */
function readingOf(report: MortalReport, position: number, tilesLeft: number, score?: number): CenterText {
  const f = kyokuFactsOf(report)[position];
  if (!f) throw new Error(`${position}局目が無い`);
  return {
    wind: (['E', 'S', 'W'] as const)[Math.floor(f.kyoku / 4)] as CenterText['wind'],
    number: ((f.kyoku % 4) + 1) as CenterText['number'],
    tilesLeft,
    score: score ?? f.startScore,
  };
}

/** 評価 1 件。center が null なら読めない評価。押した時刻は番号の順に 1 分おき。 */
function rated(id: number, center: CenterText | null): Rated {
  return { id, t_ms: 1_000_000 + id * 60_000, rating: MARKS[id % 3] as Mark, center };
}

/** 局ごとの評価の番号（付いていない局は null）。 */
function ids(assigned: readonly (Rated | null)[]): (number | null)[] {
  return assigned.map((a) => a?.id ?? null);
}

// E-18 を置き換えた E-29（迷いと評価の時間の並びでの当てはめ）の、評価だけの入口 linkRatings の試験。
// 決まりが E-18 から変わった所は、E-29 と書いてある（迷いを入れた通しの試験は、timeline-link.test.ts・timeline-rules.test.ts）。
describe('E-18 評価の結びつけ（FX-4 の5局。作った評価の記録で確かめる）', () => {
  const report = load(FX4_ID);
  const mid = (position: number) => readingOf(report, position, 30);
  const start = (position: number) => readingOf(report, position, 68);

  it('E-18 全部が局の途中に読めた評価は、読んだ局へ入る', () => {
    const ratings = [0, 1, 2, 3, 4].map((p) => rated(p, mid(p)));
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, 2, 3, 4]);
    expect(result.status).toBe('exact');
    expect(result.extra).toEqual([]);
    expect(result.missingHands).toEqual([]);
    expect(result.placements.map((p) => p.how)).toEqual(['ocr', 'ocr', 'ocr', 'ocr', 'ocr']);
    expect(result.message).toBe('評価5件を5局に割り当てました');
  });

  it('E-18 局の始め（66枚以上）に読めた評価は、読んだ局の前の局の評価になる（次の局が始まったところで押した）', () => {
    // 評価0〜3: 次の局が始まったところの画面（東2局〜東3局1本場の始め）。評価4: 最後の局の途中
    const ratings = [rated(0, start(1)), rated(1, start(2)), rated(2, start(3)), rated(3, start(4)), rated(4, mid(4))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, 2, 3, 4]);
    expect(result.placements.map((p) => [p.position, p.how])).toEqual([
      [0, 'ocr-start'],
      [1, 'ocr-start'],
      [2, 'ocr-start'],
      [3, 'ocr-start'],
      [4, 'ocr'],
    ]);
  });

  it(`E-18 局の始めの境目は残り ${HAND_START_TILES_LEFT} 枚: 66 枚は前の局、65 枚は読んだ局`, () => {
    expect(HAND_START_TILES_LEFT).toBe(66);
    const at66 = linkRatings(report, [rated(0, readingOf(report, 2, 66))]);
    expect(at66.placements[0]).toMatchObject({ position: 1, how: 'ocr-start' });
    const at65 = linkRatings(report, [rated(0, readingOf(report, 2, 65))]);
    expect(at65.placements[0]).toMatchObject({ position: 2, how: 'ocr' });
    const at70 = linkRatings(report, [rated(0, readingOf(report, 3, 70))]);
    expect(at70.placements[0]).toMatchObject({ position: 2, how: 'ocr-start' });
    const at0 = linkRatings(report, [rated(0, readingOf(report, 2, 0))]);
    expect(at0.placements[0]).toMatchObject({ position: 2, how: 'ocr' });
  });

  it('E-18 読めない評価は、読めた評価の間の空いた局へ、押した順に入る', () => {
    const ratings = [rated(0, start(1)), rated(1, null), rated(2, start(3)), rated(3, null), rated(4, mid(4))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, 2, 3, 4]);
    expect(result.placements.map((p) => [p.position, p.how])).toEqual([
      [0, 'ocr-start'],
      [1, 'order'],
      [2, 'ocr-start'],
      [3, 'order'],
      [4, 'ocr'],
    ]);
    expect(result.status).toBe('exact');
  });

  it('E-18 先頭・末尾の読めない評価は、最初の局から・基準の評価のあとから入る', () => {
    const ratings = [rated(0, null), rated(1, mid(1)), rated(2, mid(2)), rated(3, null), rated(4, null)];
    expect(ids(linkRatings(report, ratings).assigned)).toEqual([0, 1, 2, 3, 4]);
  });

  it('E-18 押し忘れた局は空欄のまま。評価が足りない旨（tooFew）と、空欄の局を返す', () => {
    // 局 2（東2局1本場）の評価を押し忘れた
    const ratings = [rated(0, start(1)), rated(1, start(2)), rated(2, start(4)), rated(3, mid(4))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, null, 2, 3]);
    expect(result.status).toBe('tooFew');
    expect(result.missingHands).toEqual([2]);
    expect(result.extra).toEqual([]);
    expect(result.ratingCount).toBe(4);
    expect(result.handCount).toBe(5);
    expect(result.message).toBe('評価が1件足りません（評価4件、局5局）');
  });

  it('E-18 読めない評価と押し忘れが重なるときは、読めた評価の間の最初の空きに入り、残りは空欄', () => {
    // 局 2 を押し忘れたうえ、局 1 の評価（評価 1）が読めない。基準は局 0 と局 3 → 間の空き 1・2 の先頭（局 1）に入る
    const ratings = [rated(0, mid(0)), rated(1, null), rated(2, mid(3)), rated(3, mid(4))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, null, 2, 3]);
    expect(result.missingHands).toEqual([2]);
  });

  it('E-18 読めた評価が1つも無く、評価が局より多くなければ、E-7 の押した順の割り当て（alignRatings）と同じ', () => {
    for (const count of [0, 3, 5]) {
      const ratings = Array.from({ length: count }, (_, i) => rated(i, null));
      const result = linkRatings(report, ratings);
      const aligned = alignRatings(ratings, 5);
      expect(result.assigned, `${count}件`).toEqual(aligned.assigned);
      expect(result.extra, `${count}件`).toEqual(aligned.extra);
      expect(result.missingHands, `${count}件`).toEqual(aligned.missingHands);
      expect(result.status, `${count}件`).toBe(aligned.status);
      expect(result.handCount).toBe(aligned.handCount);
      expect(result.ratingCount).toBe(aligned.ratingCount);
    }
  });

  it('E-18 評価が局より多いときは、その旨（tooMany）と、当てはめられなかった評価（no-room）を返す', () => {
    const ratings = [...[0, 1, 2, 3, 4].map((p) => rated(p, mid(p))), rated(5, null)];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, 2, 3, 4]);
    expect(result.status).toBe('tooMany');
    expect(result.extra.map((r) => r.id)).toEqual([5]);
    expect(result.placements[5]).toMatchObject({ position: null, how: null, unplaced: 'no-room' });
    expect(result.message).toBe('評価が1件多いです（評価6件、局5局）。うち1件は、当てはめられませんでした');
  });

  it('E-18 局が最初の局の始めに読めた評価は、前の局が無いので当てはめず（before-first）、ほかの評価の邪魔をしない', () => {
    const ratings = [rated(0, start(0)), rated(1, mid(0)), rated(2, mid(1))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([1, 2, null, null, null]);
    expect(result.extra.map((r) => r.id)).toEqual([0]);
    expect(result.placements[0]).toMatchObject({ position: null, unplaced: 'before-first' });
  });

  it('E-18 同じ局に読めた評価が2つあるときは、あとに押したほうを残す（押し直し）', () => {
    const ratings = [rated(0, mid(0)), rated(1, mid(0)), rated(2, mid(1))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([1, 2, null, null, null]);
    expect(result.extra.map((r) => r.id)).toEqual([0]);
    expect(result.placements[0]).toMatchObject({ unplaced: 'duplicate' });
  });

  it('E-18 局の途中の評価と、次の局の始めの評価が同じ局を指すときも、あとのものを残す', () => {
    const ratings = [rated(0, mid(0)), rated(1, start(1))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([1, null, null, null, null]);
    expect(result.extra.map((r) => r.id)).toEqual([0]);
  });

  it('E-29 評価が局より多く、手がかりが無いときは、あとに押した評価を残し、先に押した評価から当てはめない（E-7 の押した順の割り当ては、最後を捨てる）', () => {
    const ratings = Array.from({ length: 7 }, (_, i) => rated(i, null));
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([2, 3, 4, 5, 6]);
    expect(result.extra.map((r) => r.id)).toEqual([0, 1]);
    expect(result.status).toBe('tooMany');
    expect(result.placements.map((p) => [p.position, p.unplaced])).toEqual([
      [null, 'duplicate'],
      [null, 'duplicate'],
      [0, null],
      [1, null],
      [2, null],
      [3, null],
      [4, null],
    ]);
  });

  it('E-29 局の順が押した順と食い違う評価（局3と読めた評価のあとに、局2と読めた評価）は、あとに押したほうを残し、先に押したほうは当てはめない', () => {
    // 読んだ局は 0・3・2・4。3 と読めた評価（評価1）と、2 と読めた評価（評価2）は両立しない。
    // 食い違う局に当てはめるより、当てはめないほうが安いので、先に押した評価1を当てはめない
    const ratings = [rated(0, mid(0)), rated(1, mid(3)), rated(2, mid(2)), rated(3, mid(4))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, null, 2, null, 3]);
    expect(result.placements.map((p) => [p.position, p.how])).toEqual([
      [0, 'ocr'],
      [null, null],
      [2, 'ocr'],
      [4, 'ocr'],
    ]);
    expect(result.placements[1]?.unplaced).toBe('no-room');
  });

  it('E-29 ひとつだけ読み間違えた評価（離れた局に読めた）は、食い違う局に当てはめず、当てはめない（前後の評価はそのまま）', () => {
    const big = load('f9da87cbcd7af5e9'); // 12局
    const ratings = [rated(0, readingOf(big, 0, 30)), rated(1, readingOf(big, 1, 20)), rated(2, readingOf(big, 2, 30)), rated(3, readingOf(big, 11, 30)), rated(4, readingOf(big, 4, 30))];
    const result = linkRatings(big, ratings);
    expect(ids(result.assigned).slice(0, 6)).toEqual([0, 1, 2, null, 4, null]);
    expect(result.placements[3]).toMatchObject({ position: null, how: null, unplaced: 'no-room' });
  });

  it('E-29 局が1つに決まらない評価（本場違いで点数が同じ）は、合う局のうち早い局から当てはめる。この半荘に合う局が無い評価は、読めない評価と同じに扱う', () => {
    const big = load('f738896995c33fed'); // 13局。東3局2本場と3本場は同じ 20700 点始まり
    const ambiguous = readingOf(big, 4, 40); // 東3局・20700 点: 局 4 と 5 の両方に当たる
    const ratings = [
      rated(0, readingOf(big, 0, 30)),
      rated(1, readingOf(big, 1, 30)),
      rated(2, readingOf(big, 2, 30)),
      rated(3, readingOf(big, 3, 30)),
      rated(4, ambiguous),
      rated(5, ambiguous),
      rated(6, readingOf(big, 6, 30)),
      rated(7, { wind: 'W', number: 4, tilesLeft: 30, score: 25000 }), // この半荘に無い局
      rated(8, readingOf(big, 8, 30)),
    ];
    const result = linkRatings(big, ratings);
    expect(ids(result.assigned).slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // 本場違いで点数が同じ評価（4・5）は、合う局（局4・局5）の早いほうから。合う局が無い評価（7）は、読めないのと同じ（order）
    expect(result.placements.map((p) => p.how)).toEqual(['ocr', 'ocr', 'ocr', 'ocr', 'ocr', 'ocr', 'ocr', 'order', 'ocr']);
  });

  it('E-18 自分のリーチ棒を引いた点数で読めた評価も、局が決まる（点数の照合は E-17 と同じ）', () => {
    const big = load('f9da87cbcd7af5e9'); // 東2局（局 1）は 25000 始まりで、残り33枚でリーチが成立
    const ratings = [rated(0, readingOf(big, 0, 30)), rated(1, readingOf(big, 1, 20, 24000)), rated(2, readingOf(big, 2, 30))];
    const result = linkRatings(big, ratings);
    expect(ids(result.assigned).slice(0, 3)).toEqual([0, 1, 2]);
    expect(result.placements.map((p) => p.how)).toEqual(['ocr', 'ocr', 'ocr']);
  });

  it('E-18 評価は押した時刻（t_ms）の順に扱う。渡す順がばらばらでも、押した順で当てはめる。同じ時刻は渡した順', () => {
    const ratings = [rated(2, mid(2)), rated(0, mid(0)), rated(1, null), rated(3, null)];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([0, 1, 2, 3, null]);
    expect(result.placements.map((p) => (p.rating as Rated).id)).toEqual([0, 1, 2, 3]);
    expect(result.placements.map((p) => p.order)).toEqual([0, 1, 2, 3]);

    const sameTime = [{ ...rated(7, null), t_ms: 5 }, { ...rated(8, null), t_ms: 5 }, { ...rated(9, null), t_ms: 5 }];
    expect(ids(linkRatings(report, sameTime).assigned)).toEqual([7, 8, 9, null, null]);
  });

  it('E-18 評価の記録そのもの（番号・評価・押した時刻など）が、そのまま返る', () => {
    const ratings = [rated(0, mid(0)), rated(1, mid(1))];
    const result = linkRatings(report, ratings);
    expect(result.assigned[0]).toBe(ratings[0]);
    expect(result.assigned[1]).toBe(ratings[1]);
    expect(result.placements[0]?.rating).toBe(ratings[0]);
    expect(result.placements[0]?.center).toEqual(mid(0));
  });

  it('E-18 文字認識の行（lines）のまま渡しても読める。入力の並びは書き換えない', () => {
    const lines = ['00', '東 2 局', '余 30', '19000'];
    const ratings: RatingLinkInput[] = [{ t_ms: 2, lines }, { t_ms: 1, lines: ['東 1 局', '余 30', '25000'] }];
    const copy = [...ratings];
    const result = linkRatings(report, ratings);
    expect(result.assigned[0]).toBe(copy[1]);
    expect(result.assigned[1]).toBe(copy[0]);
    expect(ratings).toEqual(copy);
  });

  it('E-18 評価が1つも無ければ、すべての局が空欄', () => {
    const result = linkRatings(report, []);
    expect(result.assigned).toEqual([null, null, null, null, null]);
    expect(result.status).toBe('tooFew');
    expect(result.missingHands).toEqual([0, 1, 2, 3, 4]);
    expect(result.placements).toEqual([]);
  });

  it('E-18 評価と局の数が同じでも、当てはめられない評価と空欄の局があれば、その旨を返す', () => {
    const ratings = [rated(0, mid(0)), rated(1, mid(0)), rated(2, mid(2)), rated(3, mid(3)), rated(4, mid(4))];
    const result = linkRatings(report, ratings);
    expect(ids(result.assigned)).toEqual([1, null, 2, 3, 4]);
    expect(result.status).toBe('exact');
    expect(result.extra.map((r) => r.id)).toEqual([0]);
    expect(result.missingHands).toEqual([1]);
    expect(result.message).toBe('評価と局は同数です（評価5件、局5局）が、1件を当てはめられず、1局が空欄です');
  });
});

describe('E-18 長い半荘での通し（f9da87cbcd7af5e9 の12局）', () => {
  const big = load('f9da87cbcd7af5e9');

  it('E-18 毎局の次の局の始めに押し、5局目と9局目を押し忘れ、3件が読めないとき', () => {
    const start = (p: number) => readingOf(big, p, 69);
    const mid = (p: number) => readingOf(big, p, 25);
    // 局 0〜11。押した評価: 局0（次の局の始め）、局1（読めない）、局2（始め）、局3（読めない）、局4は押し忘れ、
    // 局5（始め）、局6（読めない）、局7（始め）、局8は押し忘れ、局9（始め）、局10（始め）、局11（最後の局の途中）
    const ratings = [
      rated(0, start(1)),
      rated(1, null),
      rated(2, start(3)),
      rated(3, null),
      rated(5, start(6)),
      rated(6, null),
      rated(7, start(8)),
      rated(9, start(10)),
      rated(10, start(11)),
      rated(11, mid(11)),
    ];
    const result = linkRatings(big, ratings);
    // 評価1は、局0と局2の間の空き（局1）。評価3は局2と局5の間の空き（局3・4）の先頭の局3
    // 評価6は局5と局7の間の空き（局6）。局4・局8は空欄
    expect(ids(result.assigned)).toEqual([0, 1, 2, 3, null, 5, 6, 7, null, 9, 10, 11]);
    expect(result.missingHands).toEqual([4, 8]);
    expect(result.status).toBe('tooFew');
  });
});
