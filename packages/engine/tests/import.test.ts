import { describe, expect, it } from 'vitest';

import { type ImportedGame, importReport, importReportText } from '../src/import';
import { replayFrames, splitKyokus } from '../src/replay';
import { sortTiles } from '../src/tiles';
import {
  FX1_DECISION_COUNTS,
  FX1_IDS,
  type LooseJson,
  loadMutableReport,
  loadReportText,
} from './helpers/fixtures';

type Fx1Id = (typeof FX1_IDS)[number];

const cache = new Map<Fx1Id, ImportedGame>();

/** FX-1 の半荘を取り込む（失敗したらテストを落とす）。同じ半荘は 1 回だけ取り込む。 */
function importFx1(id: Fx1Id): ImportedGame {
  const cached = cache.get(id);
  if (cached) return cached;
  const result = importReportText(loadReportText(id));
  if (!result.ok) throw new Error(`${id}: ${result.error.message}`);
  cache.set(id, result.value);
  return result.value;
}

describe('E-2 牌譜の再生（FX-1 の5半荘）', () => {
  for (const id of FX1_IDS) {
    it(`E-2 ${id}: 取り込みに成功し、判断が ${FX1_DECISION_COUNTS[id]} 件できる`, () => {
      const game = importFx1(id);
      expect(game.decisions).toHaveLength(FX1_DECISION_COUNTS[id]);
      expect(game.kyokus.reduce((n, k) => n + k.decisions.length, 0)).toBe(FX1_DECISION_COUNTS[id]);
      expect(game.decisions.map((d) => d.index)).toEqual(game.decisions.map((_, i) => i));
    });
  }

  it('E-2 全964判断で、再生して組み立てた手牌（ツモを含む）と副露が記録の state と完全に一致する（一致率100%）', () => {
    let total = 0;
    let matched = 0;
    for (const id of FX1_IDS) {
      const game = importFx1(id);
      for (const d of game.decisions) {
        total++;
        const replayedHand = sortTiles(d.board.drawn === null ? [...d.board.hand] : [...d.board.hand, d.board.drawn]);
        const recordedHand = sortTiles(d.entry.state.tehai);
        const handOk = JSON.stringify(replayedHand) === JSON.stringify(recordedHand);
        const meldsOk = JSON.stringify(d.board.melds[game.playerId]) === JSON.stringify(d.entry.state.fuuros);
        if (handOk && meldsOk) matched++;
      }
    }
    expect(total).toBe(964);
    expect(matched / total).toBe(1);
  });

  it('E-2 ツモの判断では、記録の tile がツモ牌として盤面の drawn に入り、鳴いた後や他家の打牌への判断では drawn が無い', () => {
    for (const id of FX1_IDS) {
      for (const d of importFx1(id).decisions) {
        const atOwnDraw = d.entry.last_actor === d.board.playerId && !d.entry.at_self_chi_pon;
        if (atOwnDraw) {
          expect(d.board.drawn, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBe(d.entry.tile);
        } else {
          expect(d.board.drawn, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBeNull();
        }
      }
    }
  });

  it('E-2 再生で数えた巡目（自分のツモとチー・ポンで増える）が、全判断で記録の junme と一致する', () => {
    for (const id of FX1_IDS) {
      for (const d of importFx1(id).decisions) {
        expect(d.board.junme, `${id} ${d.kyokuLabel}`).toBe(d.entry.junme);
        expect(d.board.tilesLeft).toBe(d.entry.tiles_left);
      }
    }
  });

  it('E-2 判断は牌譜の中の位置（eventIndex）と、その局の中の順序で並んでいる', () => {
    for (const id of FX1_IDS) {
      const game = importFx1(id);
      for (const k of game.kyokus) {
        const indices = k.decisions.map((d) => d.eventIndex);
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
        expect(new Set(indices).size).toBe(indices.length);
        for (const i of indices) {
          expect(i).toBeGreaterThan(k.startIndex);
          expect(i).toBeLessThanOrEqual(k.endIndex);
        }
      }
    }
  });
});

describe('E-2 盤面の組み立て', () => {
  it('E-2 f9da87cbcd7af5e9 の最初の判断: 東1局の2番手の席の第1ツモ（9p）。河は親の打牌だけ', () => {
    const game = importFx1('f9da87cbcd7af5e9');
    const d = game.decisions[0];
    expect(d).toBeDefined();
    if (!d) return;
    const b = d.board;
    expect(game.playerId).toBe(1);
    expect(d.kyokuLabel).toBe('東1局');
    expect(d.junme).toBe(1);
    expect(b.roundWind).toBe('E');
    expect(b.oya).toBe(0);
    expect(b.seatWinds).toEqual(['E', 'S', 'W', 'N']);
    expect(b.scores).toEqual([25000, 25000, 25000, 25000]);
    expect(b.kyotaku).toBe(0);
    expect(b.honba).toBe(0);
    expect(b.doraMarkers).toEqual(['4p']);
    expect(b.tilesLeft).toBe(68);
    expect(b.drawn).toBe('9p');
    expect(b.hand).toEqual(['2m', '5m', '5p', '6p', '9p', '2s', '2s', '5sr', '6s', '6s', 'N', 'N', 'P']);
    expect(b.handCounts).toEqual([13, 14, 13, 13]);
    expect(b.rivers.map((r) => r.map((t) => t.tile))).toEqual([['S'], [], [], []]);
    expect(b.rivers[0]?.[0]).toEqual({ tile: 'S', tsumogiri: false, riichi: false, calledBy: null });
    expect(b.melds.every((m) => m.length === 0)).toBe(true);
    expect(b.riichi).toEqual(['none', 'none', 'none', 'none']);
  });

  it('E-2 親でない局では、自風が親からの順になる（東2局は席1が親）', () => {
    const game = importFx1('f9da87cbcd7af5e9');
    const d = game.decisions.find((x) => x.kyoku === 1);
    expect(d?.board.oya).toBe(1);
    expect(d?.board.seatWinds).toEqual(['N', 'E', 'S', 'W']);
    expect(d?.board.kyoku).toBe(2);
  });

  it('E-2 4つの河・ツモ切り・リーチ宣言牌・鳴かれた牌・リーチ状態・供託・点数・ドラ表示牌が、牌譜の event と矛盾しない', () => {
    let riichiSeen = 0;
    let calledSeen = 0;
    let doraSeen = 0;
    for (const id of FX1_IDS) {
      const game = importFx1(id);
      for (const d of game.decisions) {
        const log = game.report.mjai_log;
        const startIndex = game.kyokus[d.kyokuPosition]?.startIndex ?? -1;
        const start = log[startIndex];
        if (!start || start.type !== 'start_kyoku') throw new Error('start_kyoku がありません');

        const rivers: { tile: string; tsumogiri: boolean; riichi: boolean; calledBy: number | null }[][] = [[], [], [], []];
        const accepted = [false, false, false, false];
        const declared = [false, false, false, false];
        let pending: number | null = null;
        let doraCount = 1;
        for (let i = startIndex + 1; i <= d.eventIndex; i++) {
          const e = log[i];
          if (!e) continue;
          if (e.type === 'reach') {
            declared[e.actor] = true;
            pending = e.actor;
          } else if (e.type === 'reach_accepted') {
            accepted[e.actor] = true;
          } else if (e.type === 'dahai') {
            rivers[e.actor]?.push({ tile: e.pai, tsumogiri: e.tsumogiri, riichi: pending === e.actor, calledBy: null });
            if (pending === e.actor) pending = null;
          } else if (e.type === 'chi' || e.type === 'pon' || e.type === 'daiminkan') {
            const river = rivers[e.target];
            const last = river?.[river.length - 1];
            if (last) last.calledBy = e.actor;
          } else if (e.type === 'dora') {
            doraCount++;
          }
        }

        expect(d.board.rivers.map((r) => r.map((t) => ({ ...t })))).toEqual(rivers);
        expect(d.board.riichi).toEqual(
          [0, 1, 2, 3].map((s) => (accepted[s] ? 'accepted' : declared[s] ? 'declared' : 'none')),
        );
        const acceptedCount = accepted.filter(Boolean).length;
        expect(d.board.kyotaku).toBe(start.kyotaku + acceptedCount);
        expect(d.board.scores).toEqual(start.scores.map((s, seat) => s - (accepted[seat] ? 1000 : 0)));
        expect(d.board.doraMarkers).toHaveLength(doraCount);
        expect(d.board.doraMarkers[0]).toBe(start.dora_marker);

        riichiSeen += rivers.flat().filter((t) => t.riichi).length;
        calledSeen += rivers.flat().filter((t) => t.calledBy !== null).length;
        if (doraCount > 1) doraSeen++;
      }
    }
    // 検査の対象になる場面が実際にデータにある（空振りの検査にならない）
    expect(riichiSeen).toBeGreaterThan(50);
    expect(calledSeen).toBeGreaterThan(50);
    expect(doraSeen).toBeGreaterThan(5);
  });

  it('E-2 replayFrames: event ごとの盤面が作れ、判断の盤面と同じ盤面が含まれる', () => {
    const game = importFx1('f9da87cbcd7af5e9');
    const kyoku = game.kyokus[1];
    const log = splitKyokus(game.report.mjai_log)[1];
    expect(kyoku && log).toBeTruthy();
    if (!kyoku || !log) return;
    const frames = replayFrames(log, game.playerId);
    expect(frames).toHaveLength(log.events.length);
    expect(frames[0]?.eventIndex).toBe(log.startIndex);
    expect(frames[0]?.board.tilesLeft).toBe(70);
    expect(frames[0]?.board.hand).toHaveLength(13);
    for (const d of kyoku.decisions) {
      const frame = frames[d.eventIndex - log.startIndex];
      expect(frame?.eventIndex).toBe(d.eventIndex);
      expect(frame?.board).toEqual(d.board);
    }
    // 巡目は単調に増える
    const junmes = frames.map((f) => f.board.junme);
    expect(junmes).toEqual([...junmes].sort((a, b) => a - b));
  });
});

describe('E-2 一致しないときは取り込みを失敗にして、局と巡目を示す', () => {
  /** 東2局1本場（review.kyokus の 2 番目）の 4 番目の判断を書き換える。 */
  function target(json: LooseJson) {
    const kyoku = json.review.kyokus[2];
    const entry = kyoku.entries[3];
    return { kyoku, entry, junme: entry.junme as number };
  }

  it('E-2 手牌が1枚違う判断で失敗し、局・巡目・記録と再生の手牌を示す', () => {
    const json = loadMutableReport();
    const { entry, junme } = target(json);
    const original = entry.state.tehai[0];
    entry.state.tehai[0] = original === '1m' ? '2m' : '1m';
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('hand-mismatch');
    expect(result.error.kyokuLabel).toBe('東2局1本場');
    expect(result.error.junme).toBe(junme);
    expect(result.error.message).toContain(`東2局1本場 ${junme}巡目`);
    expect(result.error.message).toContain('手牌');
    expect(result.error.message).toContain('記録:');
    expect(result.error.message).toContain('再生:');
  });

  it('E-2 ツモ牌が抜けた手牌（13枚）でも失敗する', () => {
    const json = loadMutableReport();
    const { entry } = target(json);
    entry.state.tehai.pop();
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hand-mismatch');
  });

  it('E-2 副露が違う判断で失敗する', () => {
    const json = loadMutableReport();
    // 東3局（review.kyokus の 3 番目）の、副露がある判断の副露を書き換える
    const kyoku = json.review.kyokus[3];
    const entry = kyoku.entries.find((e: LooseJson) => e.state.fuuros.length > 0);
    expect(entry).toBeDefined();
    entry.state.fuuros[0].pai = entry.state.fuuros[0].pai === 'N' ? 'W' : 'N';
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('meld-mismatch');
    expect(result.error.message).toContain(`東3局 ${entry.junme}巡目`);
  });

  it('E-2 実戦の行動が牌譜と違う判断で失敗する', () => {
    const json = loadMutableReport();
    const { entry, junme } = target(json);
    expect(entry.actual.type).toBe('dahai');
    entry.actual.pai = entry.actual.pai === '1m' ? '2m' : '1m';
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('action-mismatch');
    expect(result.error.message).toContain(`東2局1本場 ${junme}巡目`);
  });

  it('E-2 残り枚数が牌譜と合わない判断は、対応する局面が見つからず失敗する', () => {
    const json = loadMutableReport();
    const { entry, junme } = target(json);
    entry.tiles_left += 1;
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('no-position');
    expect(result.error.message).toContain(`東2局1本場 ${junme}巡目`);
  });

  it('E-2 牌譜が矛盾している（手牌に無い牌を切る）と失敗する', () => {
    const json = loadMutableReport();
    // 東1局の最初の打牌を、手牌に無い牌にする
    const firstDahai = json.mjai_log.find((e: LooseJson) => e.type === 'dahai');
    firstDahai.pai = 'C';
    firstDahai.tsumogiri = false;
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('log');
    expect(result.error.kyokuLabel).toBe('東1局');
  });

  it('E-2 局の数が review と牌譜で違うと失敗する', () => {
    const json = loadMutableReport();
    json.review.kyokus.pop();
    json.review.total_reviewed = json.review.kyokus.reduce((n: number, k: LooseJson) => n + k.entries.length, 0);
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('kyoku-count');
  });

  it('E-2 局の名前（東1局・本場）が review と牌譜で違うと失敗する', () => {
    const json = loadMutableReport();
    json.review.kyokus[1].honba = 3;
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('kyoku-header');
  });

  it('E-2 結果 JSON として読めないものは code が parse で、悪い項目の一覧が付く', () => {
    const json = loadMutableReport();
    delete json.review;
    const result = importReport(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('parse');
    expect(result.error.issues?.[0]?.path).toBe('$.review');
  });
});
