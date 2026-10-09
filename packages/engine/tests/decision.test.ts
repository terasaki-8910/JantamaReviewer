import { describe, expect, it } from 'vitest';

import {
  type DecisionKind,
  TAG_CALL,
  TAG_EARLY,
  TAG_PUSH_PULL,
  classifyDecisionKind,
  classifyTags,
  opponentHasRiichi,
  shantenTag,
} from '../src/decision';
import { type ImportedGame, importReportText } from '../src/import';
import type { ActionEvent, ReportDetail } from '../src/report-types';
import type { RiichiState } from '../src/replay';
import { FX1_IDS, loadReportText } from './helpers/fixtures';

/** 種類だけが意味を持つ最小の候補（q_value と prob は使わない）。 */
function detailsOf(...actions: ActionEvent[]): ReportDetail[] {
  return actions.map((action) => ({ action, q_value: 0, prob: 0 }));
}

const dahai = (pai: string): ActionEvent => ({ type: 'dahai', actor: 0, pai, tsumogiri: false });
const pon: ActionEvent = { type: 'pon', actor: 0, target: 1, pai: 'E', consumed: ['E', 'E'] };
const chi: ActionEvent = { type: 'chi', actor: 0, target: 3, pai: '4s', consumed: ['3s', '5s'] };
const none: ActionEvent = { type: 'none' };
const reach: ActionEvent = { type: 'reach', actor: 0 };
const hora: ActionEvent = { type: 'hora', actor: 0, target: 0 };
const ankan: ActionEvent = { type: 'ankan', actor: 0, consumed: ['7s', '7s', '7s', '7s'] };

function board(riichi: RiichiState[], playerId: 0 | 1 | 2 | 3 = 0) {
  return { playerId, riichi };
}

describe('E-8 判断の種類（候補の行動から決める）', () => {
  it('E-8 打牌だけの候補は discard', () => {
    expect(classifyDecisionKind(detailsOf(dahai('1m'), dahai('2m')))).toBe('discard');
  });

  it('E-8 九種九牌（ryukyoku）が候補に入っていても、打牌の判断は discard', () => {
    expect(classifyDecisionKind(detailsOf(dahai('1m'), { type: 'ryukyoku' }))).toBe('discard');
  });

  it('E-8 チー・ポン・大明槓・スルー（none）が候補にあれば call（スルーだけの組み合わせでも call）', () => {
    expect(classifyDecisionKind(detailsOf(pon, none))).toBe('call');
    expect(classifyDecisionKind(detailsOf(chi, none))).toBe('call');
    expect(classifyDecisionKind(detailsOf(none, ankan, pon))).toBe('call');
    expect(classifyDecisionKind(detailsOf({ type: 'daiminkan', actor: 0, target: 1, pai: 'E', consumed: ['E', 'E', 'E'] }, none))).toBe(
      'call',
    );
  });

  it('E-8 リーチが候補にあれば riichi', () => {
    expect(classifyDecisionKind(detailsOf(reach, dahai('7p'), dahai('6p')))).toBe('riichi');
  });

  it('E-8 和了が候補にあれば win（ツモ・ロンとも）。リーチやスルーより優先する', () => {
    expect(classifyDecisionKind(detailsOf(hora, dahai('2p')))).toBe('win');
    expect(classifyDecisionKind(detailsOf(hora, none))).toBe('win');
    expect(classifyDecisionKind(detailsOf(hora, reach, dahai('2p')))).toBe('win');
  });

  it('E-8 暗槓・加槓が候補にあり、リーチ・和了・鳴きが無ければ kan', () => {
    expect(classifyDecisionKind(detailsOf(ankan, dahai('7s')))).toBe('kan');
    expect(classifyDecisionKind(detailsOf({ type: 'kakan', actor: 0, pai: 'P', consumed: ['P', 'P', 'P'] }, dahai('9m')))).toBe('kan');
  });

  it('E-8 リーチと暗槓の両方が候補にあれば riichi（リーチを優先する）', () => {
    expect(classifyDecisionKind(detailsOf(reach, ankan, dahai('7s')))).toBe('riichi');
  });
});

describe('E-8 タグ: シャンテン数（記録のまま）', () => {
  it('E-8 shanten が 2 なら 2シャンテン', () => {
    expect(shantenTag(2)).toBe('2シャンテン');
    expect(classifyTags({ shanten: 2, junme: 10 }, 'discard', board(['none', 'none', 'none', 'none']))).toEqual(['2シャンテン']);
  });

  it('E-8 shanten が 1 なら 1シャンテン、0 以下ならテンパイ', () => {
    expect(shantenTag(1)).toBe('1シャンテン');
    expect(shantenTag(0)).toBe('テンパイ');
    expect(shantenTag(-1)).toBe('テンパイ');
    expect(shantenTag(6)).toBe('6シャンテン');
  });
});

describe('E-8 タグ: 鳴き', () => {
  const noRiichi = board(['none', 'none', 'none', 'none']);

  it('E-8 鳴きの判断（call）には 鳴き が付く', () => {
    expect(classifyTags({ shanten: 3, junme: 9 }, 'call', noRiichi)).toContain(TAG_CALL);
  });

  it('E-8 鳴き以外の判断（打牌・リーチ・和了・カン）には 鳴き が付かない', () => {
    for (const kind of ['discard', 'riichi', 'win', 'kan'] as DecisionKind[]) {
      expect(classifyTags({ shanten: 3, junme: 9 }, kind, noRiichi)).not.toContain(TAG_CALL);
    }
  });
});

describe('E-8 タグ: 押し引き（他家がリーチを宣言している）', () => {
  it('E-8 他家がリーチを宣言していれば（成立前でも）押し引き', () => {
    expect(classifyTags({ shanten: 1, junme: 9 }, 'discard', board(['none', 'declared', 'none', 'none']))).toContain(TAG_PUSH_PULL);
    expect(classifyTags({ shanten: 1, junme: 9 }, 'discard', board(['none', 'none', 'none', 'accepted']))).toContain(TAG_PUSH_PULL);
    expect(opponentHasRiichi(board(['none', 'accepted', 'accepted', 'none']))).toBe(true);
  });

  it('E-8 リーチした人がいない、または本人だけがリーチしているときは押し引きではない', () => {
    expect(classifyTags({ shanten: 1, junme: 9 }, 'discard', board(['none', 'none', 'none', 'none']))).not.toContain(TAG_PUSH_PULL);
    expect(classifyTags({ shanten: 0, junme: 9 }, 'discard', board(['accepted', 'none', 'none', 'none'], 0))).not.toContain(TAG_PUSH_PULL);
    expect(opponentHasRiichi(board(['none', 'declared', 'none', 'none'], 1))).toBe(false);
  });
});

describe('E-8 タグ: 序盤（6巡目まで）', () => {
  const noRiichi = board(['none', 'none', 'none', 'none']);

  it('E-8 junme が 6 以下なら序盤', () => {
    expect(classifyTags({ shanten: 3, junme: 1 }, 'discard', noRiichi)).toContain(TAG_EARLY);
    expect(classifyTags({ shanten: 3, junme: 6 }, 'discard', noRiichi)).toContain(TAG_EARLY);
  });

  it('E-8 junme が 7 以上なら序盤ではない', () => {
    expect(classifyTags({ shanten: 3, junme: 7 }, 'discard', noRiichi)).not.toContain(TAG_EARLY);
    expect(classifyTags({ shanten: 3, junme: 17 }, 'discard', noRiichi)).not.toContain(TAG_EARLY);
  });

  it('E-8 タグの並びは、シャンテン数・鳴き・押し引き・序盤の順', () => {
    expect(classifyTags({ shanten: 2, junme: 4 }, 'call', board(['none', 'none', 'accepted', 'none']))).toEqual([
      '2シャンテン',
      TAG_CALL,
      TAG_PUSH_PULL,
      TAG_EARLY,
    ]);
  });
});

/** 種類・タグの件数は、analysis/maka-fit/features.py の kind() と同じ規則を Python で独立に数えた値。 */
const EXPECTED: Record<
  (typeof FX1_IDS)[number],
  { kinds: Record<DecisionKind, number>; call: number; early: number; pushPull: number; shanten: Record<number, number> }
> = {
  f9da87cbcd7af5e9: {
    kinds: { discard: 142, call: 31, riichi: 1, win: 2, kan: 2 },
    call: 31,
    early: 85,
    pushPull: 25,
    shanten: { 0: 27, 1: 45, 2: 43, 3: 38, 4: 20, 5: 4, 6: 1 },
  },
  f738896995c33fed: {
    kinds: { discard: 138, call: 43, riichi: 13, win: 3, kan: 0 },
    call: 43,
    early: 99,
    pushPull: 28,
    shanten: { 0: 18, 1: 103, 2: 43, 3: 20, 4: 11, 5: 2 },
  },
  be0a2a523fdd7758: {
    kinds: { discard: 117, call: 35, riichi: 2, win: 2, kan: 0 },
    call: 35,
    early: 82,
    pushPull: 29,
    shanten: { 0: 3, 1: 37, 2: 66, 3: 35, 4: 12, 5: 3 },
  },
  '002ca97adccc486d': {
    kinds: { discard: 165, call: 48, riichi: 16, win: 2, kan: 0 },
    call: 48,
    early: 127,
    pushPull: 37,
    shanten: { 0: 31, 1: 64, 2: 58, 3: 48, 4: 22, 5: 8 },
  },
  '3a36dac7c7fc18ce': {
    kinds: { discard: 151, call: 41, riichi: 6, win: 4, kan: 0 },
    call: 41,
    early: 113,
    pushPull: 41,
    shanten: { 0: 8, 1: 73, 2: 65, 3: 42, 4: 14 },
  },
};

describe('E-8 FX-1 の各判断に種類とタグが付く', () => {
  const games = new Map<string, ImportedGame>();
  for (const id of FX1_IDS) {
    const r = importReportText(loadReportText(id));
    if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
    games.set(id, r.value);
  }

  for (const id of FX1_IDS) {
    it(`E-8 ${id}: 種類の件数とタグの件数が、独立に数えた値と一致する`, () => {
      const game = games.get(id);
      const expected = EXPECTED[id];
      expect(game).toBeDefined();
      if (!game) return;

      const kinds: Record<DecisionKind, number> = { discard: 0, call: 0, riichi: 0, win: 0, kan: 0 };
      const shanten: Record<number, number> = {};
      let call = 0;
      let early = 0;
      let pushPull = 0;
      for (const d of game.decisions) {
        kinds[d.kind]++;
        const shantenLabel = d.tags[0];
        expect(shantenLabel).toBe(shantenTag(d.entry.shanten));
        shanten[d.entry.shanten] = (shanten[d.entry.shanten] ?? 0) + 1;
        if (d.tags.includes(TAG_CALL)) call++;
        if (d.tags.includes(TAG_EARLY)) early++;
        if (d.tags.includes(TAG_PUSH_PULL)) pushPull++;
        // タグは種類と盤面から決まる規則どおり
        expect(d.tags.includes(TAG_CALL)).toBe(d.kind === 'call');
        expect(d.tags.includes(TAG_EARLY)).toBe(d.entry.junme <= 6);
        expect(d.tags.includes(TAG_PUSH_PULL)).toBe(opponentHasRiichi(d.board));
      }
      expect(kinds).toEqual(expected.kinds);
      expect(call).toBe(expected.call);
      expect(early).toBe(expected.early);
      expect(pushPull).toBe(expected.pushPull);
      expect(shanten).toEqual(expected.shanten);
    });
  }

  it('E-8 全964判断のすべてに種類が付き、シャンテン数のタグが先頭にある', () => {
    let total = 0;
    for (const game of games.values()) {
      for (const d of game.decisions) {
        total++;
        expect(['discard', 'call', 'riichi', 'win', 'kan']).toContain(d.kind);
        expect(d.tags.length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(total).toBe(964);
  });
});
