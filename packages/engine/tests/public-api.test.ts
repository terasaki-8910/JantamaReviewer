import { describe, expect, it } from 'vitest';

import * as engine from '../src/index';

// 各受け入れ項目の入口が、パッケージの入口（src/index.ts）から使えることを確かめる。
describe('公開 API（src/index.ts）', () => {
  it('E-1 E-2 取り込み・E-3 受け入れ枚数・E-4 不一致・E-8 種類とタグ の入口が使える', () => {
    for (const name of [
      'parseReport',
      'parseReportText',
      'importReport',
      'importReportText',
      'importParsedReport',
      'replayFrames',
      'splitKyokus',
      'shanten',
      'ukeire',
      'discardOptions',
      'bestDiscardOptions',
      'tenhouPairiUrl',
      'listDisagreements',
      'classifyDecisionKind',
      'classifyTags',
    ] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
  });

  it('E-5 E-6 E-7 E-9 E-12 E-13 E-14 の入口が使える', () => {
    for (const name of [
      'scheduleReview',
      'nextIntervalDays',
      'isCorrectAnswer',
      'summarizeKyokus',
      'classifyHandOutcome',
      'provisionalMark',
      'alignRatings',
      'parsePaipuLink',
      'gameRating',
      'handRatings',
      'fitGradeModel',
      'predictGrade',
      'evaluateLeaveOneGameOut',
      'fitIsotonic',
      'recordMakaMove',
      'countMakaMoves',
    ] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
  });

  it('E-15 クリップボードの牌譜リンクの入口が使える', () => {
    for (const name of ['detectPaipuLink', 'detectNewPaipuLink', 'PaipuLinkAnnouncer'] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
  });

  it('E-16 画面中央の文字認識の読み取りの入口が使える', () => {
    for (const name of ['parseCenterText', 'firstReadable', 'readingOf'] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
  });

  it('E-17 迷いマークの結びつけと、判断の呼び名・鍵の入口が使える', () => {
    for (const name of [
      'linkMarks',
      'markScore',
      'kyokuFactsOf',
      'kyokuFits',
      'locateKyokus',
      'listDecisionRefs',
      'findDecisionRef',
      'decisionRefAt',
      'decisionKey',
      'parseDecisionKey',
      'decisionKindLabel',
      'tileLabel',
      'actionLabel',
    ] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
  });

  it('E-27 選んだ判断が、スクショの値から離れているかの入口が使える', () => {
    expect(typeof engine.isFarFromReading).toBe('function');
  });

  it('E-18 評価の結びつけの入口が使える', () => {
    expect(typeof engine.linkRatings).toBe('function');
    expect(engine.HAND_START_TILES_LEFT).toBe(66);
  });

  it('E-19 結びつける半荘の入口が使える', () => {
    expect(typeof engine.matchSessionForReport).toBe('function');
    expect(typeof engine.checkShotsAgainstReport).toBe('function');
  });

  it('半荘のまとめ（F9・F10）と、既定の段階の当てはめの入口が使える', () => {
    for (const name of ['summarizeHanchan', 'roomLabel', 'roomLabelOf', 'roomDispOf'] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
    expect(engine.DEFAULT_GRADE_MODEL.recordCount).toBe(67);
  });

  it('F10 局の自己評価と AI 基準の食い違い（印）の入口が使える', () => {
    for (const name of ['disagreesWithGrade', 'gradeBand', 'markBand'] as const) {
      expect(typeof engine[name], name).toBe('function');
    }
    expect(engine.FLAG_BAND_GAP).toBe(2);
  });

  it('パッケージ名の定数がある', () => {
    expect(engine.ENGINE_PACKAGE).toBe('@jantama/engine');
  });
});
