import { describe, expect, it } from 'vitest';

import {
  actionLabel,
  decisionKey,
  decisionKindLabel,
  decisionRefAt,
  findDecisionRef,
  listDecisionRefs,
  parseDecisionKey,
  tileLabel,
} from '../src/decision-ref';
import { parseReportText } from '../src/report';
import type { ActionEvent, MortalReport } from '../src/report-types';
import { FX1_IDS, FX4_ID, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('F9 判断の呼び名', () => {
  it('牌の呼び名: 数牌はそのまま、字牌は漢字、赤五は 赤5p', () => {
    expect(['1m', '5p', '9s', '5m'].map(tileLabel)).toEqual(['1m', '5p', '9s', '5m']);
    expect(['E', 'S', 'W', 'N', 'P', 'F', 'C'].map(tileLabel)).toEqual(['東', '南', '西', '北', '白', '發', '中']);
    expect(['5mr', '5pr', '5sr'].map(tileLabel)).toEqual(['赤5m', '赤5p', '赤5s']);
  });

  it('判断の種類の呼び名（見出し）', () => {
    expect(decisionKindLabel('discard')).toBe('打牌の迷い');
    expect(decisionKindLabel('call')).toBe('鳴きの迷い');
    expect(decisionKindLabel('riichi')).toBe('リーチの迷い');
    expect(decisionKindLabel('win')).toBe('和了の迷い');
    expect(decisionKindLabel('kan')).toBe('カンの迷い');
  });

  it('実戦の行動の呼び名: 打5p・東をポン・鳴かない判断・和了', () => {
    const dahai = (pai: string): ActionEvent => ({ type: 'dahai', actor: 0, pai, tsumogiri: false });
    expect(actionLabel(dahai('5p'), 'discard')).toBe('打5p');
    expect(actionLabel(dahai('S'), 'discard')).toBe('打南');
    expect(actionLabel(dahai('5pr'), 'discard')).toBe('打赤5p');
    expect(actionLabel({ type: 'pon', actor: 0, target: 3, pai: 'E', consumed: ['E', 'E'] }, 'call')).toBe('東をポン');
    expect(actionLabel({ type: 'none' }, 'call')).toBe('鳴かない判断');
    expect(actionLabel({ type: 'hora', actor: 0, target: 2 }, 'win')).toBe('和了');
    expect(actionLabel({ type: 'hora', actor: 0, target: 0 }, 'win')).toBe('和了');
  });

  it('実戦の行動の呼び名: チー・カン・リーチ・九種九牌・和了しない判断', () => {
    expect(actionLabel({ type: 'chi', actor: 0, target: 3, pai: '1p', consumed: ['2p', '3p'] }, 'call')).toBe('1pをチー（2p 3p）');
    expect(actionLabel({ type: 'daiminkan', actor: 0, target: 1, pai: 'P', consumed: ['P', 'P', 'P'] }, 'call')).toBe('白を大明槓');
    expect(actionLabel({ type: 'ankan', actor: 0, consumed: ['5mr', '5m', '5m', '5m'] }, 'kan')).toBe('5mを暗槓');
    expect(actionLabel({ type: 'kakan', actor: 0, pai: '3s', consumed: ['3s', '3s', '3s'] }, 'kan')).toBe('3sを加槓');
    expect(actionLabel({ type: 'reach', actor: 0 }, 'riichi')).toBe('リーチ');
    expect(actionLabel({ type: 'ryukyoku' }, 'discard')).toBe('九種九牌');
    expect(actionLabel({ type: 'none' }, 'win')).toBe('和了しない判断');
  });
});

describe('F9 判断の鍵', () => {
  it('鍵は 局の通し番号・本場・局の中の判断の番号 から作り、元に戻せる', () => {
    expect(decisionKey(1, 1, 7)).toBe('k1h1e7');
    expect(decisionKey(0, 0, 0)).toBe('k0h0e0');
    expect(decisionKey(11, 12, 30)).toBe('k11h12e30');
    expect(parseDecisionKey('k1h1e7')).toEqual({ kyoku: 1, honba: 1, entryIndex: 7 });
    expect(parseDecisionKey(decisionKey(11, 12, 30))).toEqual({ kyoku: 11, honba: 12, entryIndex: 30 });
  });

  it('鍵の形でない文字列は null', () => {
    for (const bad of ['', 'k1h1', 'k1h1e', 'K1h1e1', 'k-1h1e1', 'k1h1e7x', ' k1h1e7', 'k1.1.7', '1-1-7']) {
      expect(parseDecisionKey(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('F9 判断の一覧と、鍵から判断への当て直し（FX-4）', () => {
  const report = load(FX4_ID);
  const refs = listDecisionRefs(report);

  it('全判断（70）が半荘の順に並び、鍵はすべて違う', () => {
    expect(refs).toHaveLength(70);
    expect(new Set(refs.map((r) => r.key)).size).toBe(70);
    expect(refs[0]?.key).toBe('k0h0e0');
    expect(refs[69]?.key).toBe('k2h1e16');
    refs.forEach((r, i) => {
      if (i === 0) return;
      const prev = refs[i - 1];
      expect(prev && (r.kyokuPosition > prev.kyokuPosition || r.entryIndex === prev.entryIndex + 1)).toBe(true);
    });
  });

  it('呼び名は「東2局1本場 6巡目 · 打牌の迷い」の形で、実戦の行動は打南', () => {
    const ref = refs.find((r) => r.key === 'k1h1e7');
    expect(ref).toMatchObject({
      kyokuPosition: 2,
      entryIndex: 7,
      kyoku: 1,
      honba: 1,
      kyokuLabel: '東2局1本場',
      junme: 6,
      tilesLeft: 46,
      kind: 'discard',
      kindLabel: '打牌の迷い',
      label: '東2局1本場 6巡目 · 打牌の迷い',
      actionLabel: '打南',
    });
  });

  it('鍵から判断に当て直すと、同じ判断の呼び名に戻る（保存した選択を当て直せる）', () => {
    for (const ref of refs) expect(findDecisionRef(report, ref.key), ref.key).toEqual(ref);
    expect(decisionRefAt(report, 2, 7)).toEqual(refs.find((r) => r.key === 'k1h1e7'));
  });

  it('鍵は結果 JSON の中身だけで決まる（読み直しても、別の複製でも同じ）', () => {
    expect(listDecisionRefs(load(FX4_ID)).map((r) => r.key)).toEqual(refs.map((r) => r.key));
    expect(listDecisionRefs(structuredClone(report)).map((r) => r.key)).toEqual(refs.map((r) => r.key));
  });

  it('この結果に無い判断（局・本場・判断の番号が合わない）や鍵でない文字列は null', () => {
    expect(findDecisionRef(report, 'k1h1e13')).toBeNull();
    expect(findDecisionRef(report, 'k1h1e999')).toBeNull();
    expect(findDecisionRef(report, 'k9h0e0')).toBeNull();
    expect(findDecisionRef(report, 'k1h5e0')).toBeNull();
    expect(findDecisionRef(report, 'k1h1')).toBeNull();
    expect(decisionRefAt(report, 9, 0)).toBeNull();
    expect(decisionRefAt(report, 0, 18)).toBeNull();
    expect(decisionRefAt(report, -1, 0)).toBeNull();
  });
});

describe('F9 FX-1 の5半荘でも、鍵は半荘の中で重ならず、当て直せる', () => {
  for (const id of FX1_IDS) {
    it(`${id}: 判断の数だけ鍵があり、すべて当て直せる`, () => {
      const report = load(id);
      const refs = listDecisionRefs(report);
      expect(refs).toHaveLength(report.review.total_reviewed);
      expect(new Set(refs.map((r) => r.key)).size).toBe(refs.length);
      for (const ref of refs) expect(findDecisionRef(report, ref.key)).toEqual(ref);
    });
  }

  it('判断の種類の呼び名がすべて付く（打牌・鳴き・リーチ・和了。FX-1 にカンの判断は無くてもよい）', () => {
    const kinds = new Set(FX1_IDS.flatMap((id) => listDecisionRefs(load(id)).map((r) => r.kind)));
    for (const kind of ['discard', 'call', 'riichi', 'win'] as const) expect(kinds.has(kind), kind).toBe(true);
    for (const id of FX1_IDS) {
      for (const ref of listDecisionRefs(load(id))) {
        expect(ref.kindLabel).toBe(decisionKindLabel(ref.kind));
        expect(ref.label).toBe(`${ref.kyokuLabel} ${ref.junme}巡目 · ${ref.kindLabel}`);
        expect(ref.actionLabel.length).toBeGreaterThan(0);
      }
    }
  });
});
