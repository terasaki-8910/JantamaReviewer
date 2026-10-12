import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import type { Decision } from '../src/decision';
import { type ImportedGame, importReportText } from '../src/import';
import { type QuizChoice, actualChoice, answerOptions, choiceText, discardCandidates, sameChoice, topChoice } from '../src/quiz-choice';
import { shantenOfCounts } from '../src/shanten';
import { type Tile, kindToTile, sortTiles } from '../src/tiles';
import { type YakuPart, describeYakuView, yakuShapeOfChoice, yakuViewOf } from '../src/yaku-view';
import { FX4_ID, FX5_ID, FX1_IDS, loadReportText } from './helpers/fixtures';

// 決定シートに出す、プロトタイプの計算結果の例（役の表示の調査）。ふだんの `pnpm test` では動かさない（環境変数 YAKU_SAMPLES=出力先のフォルダ のときだけ）。
//   YAKU_SAMPLES=<フォルダ> pnpm exec vitest run tests/yaku-samples.test.ts
// 出力: <フォルダ>/yaku-samples.json と data/yaku-samples.js（file:// で読める包み）。

interface SampleSpec {
  id: string;
  game: string;
  gameLabel: string;
  kyokuLabel: string;
  entryIndex: number;
  /** この例で見てほしいこと。 */
  point: string;
}

const SAMPLES: SampleSpec[] = [
  { id: 's1', game: FX4_ID, gameLabel: 'FX-4（10月9日・あなたの半荘）', kyokuLabel: '東2局1本場', entryIndex: 9, point: '打牌の比べ方。実戦（打4p）と AI（打7p）は同じ近い役、打東だと、東が1枚に減り、役牌の見込みが落ちる。断幺九は、東を切っても、東東が残っても、あと1枚の遠回り' },
  { id: 's2', game: FX4_ID, gameLabel: 'FX-4（10月9日・あなたの半荘）', kyokuLabel: '東2局1本場', entryIndex: 10, point: '鳴きの比べ方。東をポンすると、役牌 東（場風）が確定して聴牌。スルーなら門前のまま' },
  { id: 's3', game: FX4_ID, gameLabel: 'FX-4（10月9日・あなたの半荘）', kyokuLabel: '東3局1本場', entryIndex: 15, point: '役無しの警告。チー（5s 7s）で聴牌になるが、待ちはどれも役が付かない。スルーなら門前のまま（立直・自摸が使える）' },
  { id: 's4', game: FX5_ID, gameLabel: 'FX-5（10月11日・あなたの半荘）', kyokuLabel: '南2局', entryIndex: 8, point: '役無しの警告。チー（2m 3m）で聴牌になるが、切り方によらず役無し' },
  { id: 's5', game: FX5_ID, gameLabel: 'FX-5（10月11日・あなたの半荘）', kyokuLabel: '南4局', entryIndex: 2, point: '南場・南家のダブ南。スルーなら 役牌 南（2枚）が近い役。チーすると、役牌を捨てる流れになり、役無し聴牌にしかならない' },
  { id: 's6', game: FX5_ID, gameLabel: 'FX-5（10月11日・あなたの半荘）', kyokuLabel: '東1局', entryIndex: 8, point: '近い役: 一気通貫。足りない牌を指定して出す（あと 8s 9s）' },
  { id: 's7', game: FX5_ID, gameLabel: 'FX-5（10月11日・あなたの半荘）', kyokuLabel: '南4局', entryIndex: 11, point: '聴牌の手の確定している役: 混一色・一盃口・一気通貫（待ちが複数でも、どの待ちでも付く役）' },
  { id: 's8', game: FX5_ID, gameLabel: 'FX-5（10月11日・あなたの半荘）', kyokuLabel: '南2局', entryIndex: 15, point: '聴牌の手の確定している役: 断幺九（役牌なしの副露なし手でも、聴牌なら役が見える）' },
  { id: 's9', game: FX1_IDS[0], gameLabel: 'FX-1（f9da87cb。参考）', kyokuLabel: '東1局', entryIndex: 5, point: '一部の待ちだけ役が付く（副露した手）。付く待ちと付かない待ちが分かれる' },
  { id: 's10', game: FX1_IDS[1], gameLabel: 'FX-1（f7388969。参考）', kyokuLabel: '東3局2本場', entryIndex: 7, point: '門前の聴牌で、ダマだと役が無く、ロンできない待ち（立直か自摸が要る）' },
];

const WIND_NAMES: Record<string, string> = { E: '東', S: '南', W: '西', N: '北' };

function partsOut(parts: YakuPart[]): ({ text: string } | { tiles: Tile[] })[] {
  return parts.map((p) => ('text' in p ? { text: p.text } : { tiles: p.tiles }));
}

function comparedChoices(d: Decision): QuizChoice[] {
  const out: QuizChoice[] = [];
  const add = (c: QuizChoice | null) => {
    if (c !== null && !out.some((x) => sameChoice(x, c))) out.push(c);
  };
  if (d.kind === 'discard') {
    add(actualChoice(d));
    add(topChoice(d));
    for (const c of discardCandidates(d.entry)) {
      if (out.length >= 3) break;
      add({ type: 'dahai', tile: c.tile });
    }
    return out.slice(0, 3);
  }
  add(actualChoice(d));
  add(topChoice(d));
  for (const o of answerOptions(d)) add({ type: 'option', id: o.id });
  return out.slice(0, 4);
}

describe.skipIf(!process.env.YAKU_SAMPLES)('役の表示の見本（プロトタイプの計算結果）', () => {
  it('yaku-samples.json を作る', () => {
    const outDir = process.env.YAKU_SAMPLES as string;
    mkdirSync(path.join(outDir, 'data'), { recursive: true });
    const games = new Map<string, ImportedGame>();
    const load = (id: string): ImportedGame => {
      let g = games.get(id);
      if (g === undefined) {
        const r = importReportText(loadReportText(id));
        if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
        g = r.value;
        games.set(id, g);
      }
      return g;
    };
    const samples: unknown[] = [];
    for (const spec of SAMPLES) {
      const game = load(spec.game);
      const d = game.decisions.find((x) => x.kyokuLabel === spec.kyokuLabel && x.entryIndex === spec.entryIndex);
      if (d === undefined) throw new Error(`場面が見つかりません: ${spec.id} ${spec.game} ${spec.kyokuLabel} e${spec.entryIndex}`);
      const board = d.board;
      const actual = actualChoice(d);
      const top = topChoice(d);
      const choices = comparedChoices(d).flatMap((choice) => {
        const made = yakuShapeOfChoice(d, choice);
        if (made === null) return [];
        const view = yakuViewOf(made.shape, { riichi: made.riichi });
        const wasClosed = (board.melds[board.playerId] ?? []).every((m) => m.type === 'ankan');
        const text = describeYakuView(view, made.shape, wasClosed && !view.closed);
        const tags: string[] = [];
        if (sameChoice(choice, actual)) tags.push('実戦');
        if (top !== null && sameChoice(choice, top)) tags.push('AI');
        const total = made.shape.counts.reduce((a, b) => a + b, 0);
        const concealed: Tile[] = [];
        made.shape.counts.forEach((c, kind) => {
          for (let i = 0; i < c; i++) concealed.push(kindToTile(kind));
        });
        return [
          {
            kind: choice.type === 'dahai' ? 'dahai' : (answerOptions(d).find((o) => o.id === choice.id)?.kind ?? 'option'),
            label: choiceText(d, choice),
            tile: choice.type === 'dahai' ? choice.tile : null,
            tags,
            afterHand: sortTiles(concealed),
            afterMelds: made.shape.melds.map((m) => ({ type: m.type, first: m.first, open: m.open })),
            discardFirst: total % 3 === 2,
            shanten: shantenOfCounts(made.shape.counts),
            tenpai: view.tenpai,
            waits: view.settled.waits.map((w) => ({ tile: w.tile, dead: view.settled.deadWaits.includes(w.kind) })),
            closed: view.closed,
            riichi: made.riichi,
            state: view.state,
            dama: view.dama,
            settled: text.settled.map((l) => ({ id: l.id, name: l.name, han: l.han })),
            partial: text.partial.map((l) => ({ id: l.id, name: l.name, parts: partsOut(l.parts) })),
            near: text.near.map((l) => ({ id: l.id, name: l.name, han: l.han, draws: l.draws, extra: l.extra, parts: partsOut(l.parts) })),
            warning: text.warning === null ? null : { level: text.warning.level, parts: partsOut(text.warning.parts) },
            closedNote: text.closedNote,
            openNote: text.openNote,
            afterDiscard: view.afterDiscard.map((a) => ({ tile: kindToTile(a.kind), waits: a.waits.map((w) => ({ tile: kindToTile(w), dead: a.dead.includes(w) })), settled: a.settled.map((h) => h.id) })),
          },
        ];
      });
      samples.push({
        id: spec.id,
        point: spec.point,
        game: spec.gameLabel,
        gameId: spec.game,
        kyokuLabel: d.kyokuLabel,
        junme: d.junme,
        kind: d.kind,
        round: WIND_NAMES[board.roundWind],
        seat: WIND_NAMES[board.seatWinds[board.playerId] as string],
        dora: board.doraMarkers,
        hand: board.hand,
        drawn: board.drawn,
        melds: (board.melds[board.playerId] ?? []).map((m) => ({ type: m.type, tiles: m.type === 'kakan' ? [m.previous_pon_pai, ...m.consumed, m.pai] : m.type === 'ankan' ? m.consumed : [m.pai, ...m.consumed] })),
        called: d.kind === 'call' ? d.entry.tile : null,
        choices,
      });
    }
    const document = {
      note: '役の表示の調査の試作（packages/engine/src/yaku*.ts）が、実戦の判断から計算した値。画面には未実装。',
      generator: 'packages/engine/tests/yaku-samples.test.ts',
      samples,
    };
    writeFileSync(path.join(outDir, 'yaku-samples.json'), JSON.stringify(document, null, 1), 'utf-8');
    writeFileSync(path.join(outDir, 'data', 'yaku-samples.js'), `/* 役の表示の見本の内容。プロトタイプ（yaku*.ts）の計算結果。yaku-samples.test.ts の出力 */\nwindow.YAKU_SAMPLES = ${JSON.stringify(document)};\n`, 'utf-8');
    void WIND_NAMES;
  });
});
