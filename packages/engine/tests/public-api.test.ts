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

  it('パッケージ名の定数がある', () => {
    expect(engine.ENGINE_PACKAGE).toBe('@jantama/engine');
  });
});
