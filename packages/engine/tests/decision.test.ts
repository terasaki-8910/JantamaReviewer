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
import { sceneShanten } from '../src/scene-shanten';
import { parseTenhouNotation } from '../src/tiles';
import { FX1_IDS, loadFixtureJson, loadReportText } from './helpers/fixtures';

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

/** 既定の手牌は 13 枚の 2 シャンテン（2 面子 + 搭子 3 つ）。シャンテン数のタグは、盤面の手牌で決まる（E-21）。 */
const TWO_SHANTEN_13 = '123456m1357p139s';

function board(riichi: RiichiState[], playerId: 0 | 1 | 2 | 3 = 0, hand: string = TWO_SHANTEN_13, drawn: string | null = null) {
  return {
    playerId,
    riichi,
    hand: parseTenhouNotation(hand),
    drawn: drawn === null ? null : (parseTenhouNotation(drawn)[0] as string),
  };
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

describe('E-8 タグ: シャンテン数（その場面の手で数える。E-21）', () => {
  const none4: RiichiState[] = ['none', 'none', 'none', 'none'];

  it('E-8 手牌が 2 シャンテンなら 2シャンテン（13枚は、そのまま数える）', () => {
    expect(shantenTag(2)).toBe('2シャンテン');
    expect(classifyTags({ junme: 10 }, 'call', board(none4))).toEqual(['2シャンテン', TAG_CALL]);
    expect(classifyTags({ junme: 10 }, 'discard', board(none4, 0, '123456m1357p139s', null))).toEqual(['2シャンテン']);
  });

  it('E-8 14枚の手牌（ツモ牌つき）は、切る牌ごとのシャンテン数の最小。ツモで進めば、ツモる前より 1 小さい', () => {
    // ツモる前は 2 シャンテン。2p を引くと 123p ができて、9s を切れば 1 シャンテン
    expect(classifyTags({ junme: 10 }, 'discard', board(none4, 0, '123456m1357p139s', '2p'))).toEqual(['1シャンテン']);
    // 進まないツモ（東を引いて、東を切れば 2 シャンテンのまま）
    expect(classifyTags({ junme: 10 }, 'discard', board(none4, 0, '123456m1357p139s', '1z'))).toEqual(['2シャンテン']);
    // 13 枚と 14 枚で、同じ手牌の数え方の違いが、そのまま sceneShanten に出る
    expect(sceneShanten(board(none4, 0, '123456m1357p139s', '2p'))).toBe(1);
    expect(sceneShanten(board(none4, 0, '123456m1357p139s', null))).toBe(2);
  });

  it('E-8 1 シャンテンは 1シャンテン、0 以下はテンパイ', () => {
    expect(shantenTag(1)).toBe('1シャンテン');
    expect(shantenTag(0)).toBe('テンパイ');
    expect(shantenTag(-1)).toBe('テンパイ');
    expect(shantenTag(6)).toBe('6シャンテン');
    expect(classifyTags({ junme: 9 }, 'call', board(none4, 0, '123456789m13p57s'))[0]).toBe('1シャンテン');
    expect(classifyTags({ junme: 9 }, 'call', board(none4, 0, '123456789m1155p'))[0]).toBe('テンパイ');
  });
});

describe('E-8 タグ: 鳴き', () => {
  const noRiichi = board(['none', 'none', 'none', 'none']);

  it('E-8 鳴きの判断（call）には 鳴き が付く', () => {
    expect(classifyTags({ junme: 9 }, 'call', noRiichi)).toContain(TAG_CALL);
  });

  it('E-8 鳴き以外の判断（打牌・リーチ・和了・カン）には 鳴き が付かない', () => {
    for (const kind of ['discard', 'riichi', 'win', 'kan'] as DecisionKind[]) {
      expect(classifyTags({ junme: 9 }, kind, noRiichi)).not.toContain(TAG_CALL);
    }
  });
});

describe('E-8 タグ: 押し引き（他家がリーチを宣言している）', () => {
  it('E-8 他家がリーチを宣言していれば（成立前でも）押し引き', () => {
    expect(classifyTags({ junme: 9 }, 'discard', board(['none', 'declared', 'none', 'none']))).toContain(TAG_PUSH_PULL);
    expect(classifyTags({ junme: 9 }, 'discard', board(['none', 'none', 'none', 'accepted']))).toContain(TAG_PUSH_PULL);
    expect(opponentHasRiichi(board(['none', 'accepted', 'accepted', 'none']))).toBe(true);
  });

  it('E-8 リーチした人がいない、または本人だけがリーチしているときは押し引きではない', () => {
    expect(classifyTags({ junme: 9 }, 'discard', board(['none', 'none', 'none', 'none']))).not.toContain(TAG_PUSH_PULL);
    expect(classifyTags({ junme: 9 }, 'discard', board(['accepted', 'none', 'none', 'none'], 0))).not.toContain(TAG_PUSH_PULL);
    expect(opponentHasRiichi(board(['none', 'declared', 'none', 'none'], 1))).toBe(false);
  });
});

describe('E-8 タグ: 序盤（6巡目まで）', () => {
  const noRiichi = board(['none', 'none', 'none', 'none']);

  it('E-8 junme が 6 以下なら序盤', () => {
    expect(classifyTags({ junme: 1 }, 'discard', noRiichi)).toContain(TAG_EARLY);
    expect(classifyTags({ junme: 6 }, 'discard', noRiichi)).toContain(TAG_EARLY);
  });

  it('E-8 junme が 7 以上なら序盤ではない', () => {
    expect(classifyTags({ junme: 7 }, 'discard', noRiichi)).not.toContain(TAG_EARLY);
    expect(classifyTags({ junme: 17 }, 'discard', noRiichi)).not.toContain(TAG_EARLY);
  });

  it('E-8 タグの並びは、シャンテン数・鳴き・押し引き・序盤の順', () => {
    expect(classifyTags({ junme: 4 }, 'call', board(['none', 'none', 'accepted', 'none']))).toEqual([
      '2シャンテン',
      TAG_CALL,
      TAG_PUSH_PULL,
      TAG_EARLY,
    ]);
  });
});

/**
 * 種類・タグの件数は、analysis/maka-fit/features.py の kind() と同じ規則を Python で独立に数えた値。
 * シャンテン数のタグは、場面の手で数える（E-21）ので、Python の mahjong ライブラリで数えた表
 * （fixtures/scene-shanten.json。generate_scene_shanten.py）と比べる。
 */
const EXPECTED: Record<
  (typeof FX1_IDS)[number],
  { kinds: Record<DecisionKind, number>; call: number; early: number; pushPull: number }
> = {
  f9da87cbcd7af5e9: {
    kinds: { discard: 142, call: 31, riichi: 1, win: 2, kan: 2 },
    call: 31,
    early: 85,
    pushPull: 25,
  },
  f738896995c33fed: {
    kinds: { discard: 138, call: 43, riichi: 13, win: 3, kan: 0 },
    call: 43,
    early: 99,
    pushPull: 28,
  },
  be0a2a523fdd7758: {
    kinds: { discard: 117, call: 35, riichi: 2, win: 2, kan: 0 },
    call: 35,
    early: 82,
    pushPull: 29,
  },
  '002ca97adccc486d': {
    kinds: { discard: 165, call: 48, riichi: 16, win: 2, kan: 0 },
    call: 48,
    early: 127,
    pushPull: 37,
  },
  '3a36dac7c7fc18ce': {
    kinds: { discard: 151, call: 41, riichi: 6, win: 4, kan: 0 },
    call: 41,
    early: 113,
    pushPull: 41,
  },
};

interface SceneShantenFixture {
  reports: Record<string, { decisions: number; scene: number[]; histogram: Record<string, number> }>;
}

describe('E-8 FX-1 の各判断に種類とタグが付く', () => {
  const sceneTable = loadFixtureJson<SceneShantenFixture>('scene-shanten.json');
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
      const scene = sceneTable.reports[id];
      expect(game).toBeDefined();
      expect(scene).toBeDefined();
      if (!game || !scene) return;
      expect(game.decisions.length).toBe(scene.decisions);

      const kinds: Record<DecisionKind, number> = { discard: 0, call: 0, riichi: 0, win: 0, kan: 0 };
      const shanten: Record<string, number> = {};
      let call = 0;
      let early = 0;
      let pushPull = 0;
      for (const [index, d] of game.decisions.entries()) {
        kinds[d.kind]++;
        // シャンテン数のタグ（と d.shanten）は、場面の手で数えた正解表と、全判断で一致する
        expect(d.shanten, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBe(scene.scene[index]);
        expect(d.tags[0]).toBe(shantenTag(scene.scene[index] as number));
        shanten[String(d.shanten)] = (shanten[String(d.shanten)] ?? 0) + 1;
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
      expect(shanten).toEqual(scene.histogram);
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
