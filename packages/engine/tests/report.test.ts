import { describe, expect, it } from 'vitest';

import { parseReport, parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX1_DECISION_COUNTS, FX1_IDS, loadMutableReport, loadReportText } from './helpers/fixtures';

function parseFx1(id: (typeof FX1_IDS)[number]): MortalReport {
  const result = parseReportText(loadReportText(id));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('E-1 取り込み（結果 JSON の読み取り）', () => {
  for (const id of FX1_IDS) {
    it(`E-1 ${id}: 判断の数が review.total_reviewed（${FX1_DECISION_COUNTS[id]}）と同じ`, () => {
      const report = parseFx1(id);
      const decisions = report.review.kyokus.flatMap((k) => k.entries);
      expect(decisions).toHaveLength(FX1_DECISION_COUNTS[id]);
      expect(decisions).toHaveLength(report.review.total_reviewed);
    });
  }

  it('E-1 5半荘の判断は合わせて964', () => {
    const total = FX1_IDS.reduce((n, id) => n + parseFx1(id).review.kyokus.reduce((m, k) => m + k.entries.length, 0), 0);
    expect(total).toBe(964);
  });

  it('E-1 レビューした本人の席・局の数・牌譜の長さが読める', () => {
    const report = parseFx1('f9da87cbcd7af5e9');
    expect(report.player_id).toBe(1);
    expect(report.review.kyokus).toHaveLength(12);
    expect(report.engine).toBe('Mortal');
    expect(report.game_length).toBe('Hanchan');
    expect(report.mjai_log.filter((e) => e.type === 'start_kyoku')).toHaveLength(12);
  });

  it('E-1 判断の数が total_reviewed と合わないとき、両方の数を示して失敗する', () => {
    const json = loadMutableReport();
    json.review.kyokus[0].entries.pop();
    const result = parseReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues[0]?.path).toBe('$.review.total_reviewed');
    expect(result.error.message).toContain('177');
    expect(result.error.message).toContain('178');
  });

  it('E-1 項目の型が違うとき、どの項目かをパスで示して失敗する', () => {
    const json = loadMutableReport();
    json.review.kyokus[3].entries[2].details[1].prob = 'abc';
    const result = parseReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toBe('$.review.kyokus[3].entries[2].details[1].prob');
    expect(result.error.issues[0]?.message).toContain('数値');
    expect(result.error.message).toContain('details[1].prob');
  });

  it('E-1 必須の項目が無いとき、どの項目が無いかを示して失敗する', () => {
    const json = loadMutableReport();
    delete json.review.kyokus[0].entries[0].state.tehai;
    delete json.player_id;
    const result = parseReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.error.issues.map((i) => i.path);
    expect(paths).toContain('$.review.kyokus[0].entries[0].state.tehai');
    expect(paths).toContain('$.player_id');
  });

  it('E-1 牌の表記・席の番号・行動の種類が正しくないとき、失敗する', () => {
    const json = loadMutableReport();
    json.mjai_log[1].tehais[0][0] = '0m';
    json.mjai_log[3].actor = 4;
    json.review.kyokus[0].entries[0].expected.type = 'jump';
    const result = parseReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byPath = Object.fromEntries(result.error.issues.map((i) => [i.path, i.message]));
    expect(byPath['$.mjai_log[1].tehais[0][0]']).toContain('牌の表記');
    expect(byPath['$.mjai_log[3].actor']).toContain('席の番号');
    expect(byPath['$.review.kyokus[0].entries[0].expected.type']).toContain('知らない種類');
  });

  it('E-1 実戦の行動の番号（actual_index）が候補の範囲を出ているとき、失敗する', () => {
    const json = loadMutableReport();
    json.review.kyokus[0].entries[0].actual_index = 99;
    const result = parseReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues[0]?.path).toBe('$.review.kyokus[0].entries[0].actual_index');
  });

  it('E-1 Mortal 以外の結果・JSON でないもの・オブジェクトでないものは、理由を返して失敗する', () => {
    const json = loadMutableReport();
    json.engine = 'Akochan';
    const akochan = parseReport(json);
    expect(akochan.ok).toBe(false);
    if (!akochan.ok) expect(akochan.error.issues[0]?.path).toBe('$.engine');

    const broken = parseReportText('{"engine": ');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.message).toContain('JSON として正しくありません');

    for (const value of [null, 42, 'text', []]) {
      const r = parseReport(value);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.issues[0]?.path).toBe('$');
    }
  });

  it('E-1 問題が多いときも、集める件数に上限がある（巨大なエラー一覧にならない）', () => {
    const json = loadMutableReport();
    for (const k of json.review.kyokus) for (const e of k.entries) e.junme = 'x';
    const result = parseReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.length).toBeLessThanOrEqual(30);
    expect(result.error.message).toContain('ほか');
  });
});
