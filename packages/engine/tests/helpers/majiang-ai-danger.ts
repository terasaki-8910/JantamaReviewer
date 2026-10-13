import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportedGame } from '../../src/import';
import { coreKindTile, coreTile } from '../../src/majiang-adapter';
import type { Fuuro, Seat, StartKyokuEvent } from '../../src/report-types';
import { type Tile, countTiles, tileKind } from '../../src/tiles';

// 守備の目安（danger.ts。E-39）が、majiang-ai（kobalab。MIT。Copyright (c) 2021 Satoshi Kobayashi）の危険度の数値の順と大きく食い違わないかを見る、試験だけの部品。
// majiang-ai は devDependencies（配らない）。suanpai.js は、パッケージの入口（lib/index.js）と同じ場所の中にあるファイルを、道筋で読む
// （package.json の exports には出ていないので、`require('@kobalab/majiang-ai/lib/suanpai')` とは書けない）。
// 牌譜（mjai_log）を、本人の視点で 1 手ずつ SuanPai に渡し、判断の直前までの危険度を、牌の種類ごとに返す。

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRequire = createRequire(path.resolve(here, '../../package.json'));
const aiLib = path.dirname(engineRequire.resolve('@kobalab/majiang-ai'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 型定義の無い CommonJS
const SuanPai: any = createRequire(path.join(aiLib, 'index.js'))('./suanpai');

/** 鳴いた席から見た相手の方向（+ 下家・= 対面・- 上家）。 */
function direction(actor: Seat, target: Seat): string {
  return ['', '+', '=', '-'][(target - actor + 4) % 4] as string;
}

/** 副露 1 つを majiang-core の面子の文字列にする。actor は鳴いた席。 */
function coreMeld(meld: Fuuro, actor: Seat): string {
  const digits = (tiles: readonly Tile[]) => tiles.map((t) => coreTile(t).charAt(1)).join('');
  const suit = (t: Tile) => coreTile(t).charAt(0);
  switch (meld.type) {
    case 'chi':
      return `${suit(meld.pai)}${coreTile(meld.pai).charAt(1)}-${digits(meld.consumed)}`;
    case 'pon':
    case 'daiminkan':
      return `${suit(meld.pai)}${digits(meld.consumed)}${coreTile(meld.pai).charAt(1)}${direction(actor, meld.target)}`;
    case 'kakan':
      return `${suit(meld.pai)}${digits(meld.consumed)}${coreTile(meld.previous_pon_pai).charAt(1)}${direction(actor, meld.previous_pon_target)}${coreTile(meld.pai).charAt(1)}`;
    case 'ankan':
      return `${suit(meld.consumed[0] as Tile)}${digits(meld.consumed)}`;
  }
}

/** 配牌を、majiang-core の手牌の文字列にする（m123p0456z11）。 */
function closedText(tiles: readonly Tile[]): string {
  const groups: Record<string, number[]> = { m: [], p: [], s: [], z: [] };
  for (const tile of tiles) {
    const c = coreTile(tile);
    (groups[c.charAt(0)] as number[]).push(Number(c.charAt(1)));
  }
  return ['m', 'p', 's', 'z'].map((suit) => ((groups[suit] as number[]).length > 0 ? suit + (groups[suit] as number[]).join('') : '')).join('');
}

/**
 * 判断の直前までの、majiang-ai の危険度（リーチした人すべてに対する最大）。キーは牌の種類。リーチした他家がいなければ null。
 * `hand` は、判断のときの閉じた手牌（ツモ牌を含む）。危険度は、リーチした人ごとに、全部の牌の危険度の和が 100 になるように直した値（親は 1.5 倍）。
 */
export function majiangAiDanger(game: ImportedGame, startIndex: number, eventIndex: number, hand: readonly Tile[]): Map<number, number> | null {
  const log = game.report.mjai_log;
  const start = log[startIndex] as StartKyokuEvent;
  const me = game.playerId;
  const rel = (seat: number) => (seat - start.oya + 4) % 4;
  const sp = new SuanPai({ m: 1, p: 1, s: 1 });
  sp.qipai(
    {
      zhuangfeng: 'ESWN'.indexOf(start.bakaze),
      baopai: coreTile(start.dora_marker),
      shoupai: [0, 1, 2, 3].map((seat) => (seat === me ? closedText(start.tehais[seat] as Tile[]) : '')),
    },
    rel(me),
  );
  let pendingReach: Seat | null = null;
  const pons: Fuuro[][] = [[], [], [], []];
  for (let i = startIndex + 1; i <= eventIndex; i++) {
    const ev = log[i];
    if (ev === undefined) break;
    switch (ev.type) {
      case 'reach':
        pendingReach = ev.actor;
        break;
      case 'tsumo':
        sp.zimo({ l: rel(ev.actor), p: coreTile(ev.pai) });
        break;
      case 'dahai': {
        const declaring = pendingReach === ev.actor;
        if (declaring) pendingReach = null;
        sp.dapai({ l: rel(ev.actor), p: coreTile(ev.pai) + (ev.tsumogiri ? '_' : '') + (declaring ? '*' : '') });
        break;
      }
      case 'chi':
      case 'pon':
      case 'daiminkan': {
        const meld: Fuuro = { type: ev.type, target: ev.target, pai: ev.pai, consumed: [...ev.consumed] };
        if (ev.type === 'pon') (pons[ev.actor] as Fuuro[]).push(meld);
        sp.fulou({ l: rel(ev.actor), m: coreMeld(meld, ev.actor) });
        break;
      }
      case 'ankan':
        sp.gang({ l: rel(ev.actor), m: coreMeld({ type: 'ankan', consumed: [...ev.consumed] }, ev.actor) });
        break;
      case 'kakan': {
        const pon = (pons[ev.actor] as Fuuro[]).find((m) => m.type === 'pon' && tileKind(m.pai) === tileKind(ev.pai));
        if (pon !== undefined && pon.type === 'pon') {
          sp.gang({
            l: rel(ev.actor),
            m: coreMeld({ type: 'kakan', pai: ev.pai, previous_pon_target: pon.target, previous_pon_pai: pon.pai, consumed: [...pon.consumed] }, ev.actor),
          });
        }
        break;
      }
      case 'dora':
        sp.kaigang({ baopai: coreTile(ev.dora_marker) });
        break;
      default:
        break;
    }
  }
  // 自分の手牌の枚数（赤は [0] と [5] の両方）。危険度の計算が見るのは、持っているかどうかだけ
  const counts = countTiles(hand);
  const bingpai: Record<string, number[]> = { m: new Array<number>(10).fill(0), p: new Array<number>(10).fill(0), s: new Array<number>(10).fill(0), z: new Array<number>(8).fill(0) };
  for (let kind = 0; kind < 34; kind++) {
    const c = coreKindTile(kind);
    (bingpai[c.charAt(0)] as number[])[Number(c.charAt(1))] = counts[kind] as number;
  }
  const fn = sp.suan_weixian_all(bingpai);
  if (fn === undefined) return null;
  const out = new Map<number, number>();
  for (let kind = 0; kind < 34; kind++) out.set(kind, fn(coreKindTile(kind)));
  return out;
}
