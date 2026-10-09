/** 判断の行動（打牌・リーチ・鳴き・和了など）の扱い。 */
import type { ActionEvent, MjaiEvent, Seat } from './report-types';
import { type Tile, sortTiles } from './tiles';

function sameTileSet(a: readonly Tile[], b: readonly Tile[]): boolean {
  if (a.length !== b.length) return false;
  const x = sortTiles(a);
  const y = sortTiles(b);
  return x.every((t, i) => t === y[i]);
}

/**
 * 二つの行動が同じか。牌の並びは順不同で比べる。
 * 和了は誰が誰からかだけを比べる（点数の増減や裏ドラは行動の違いではない）。
 */
export function sameAction(a: ActionEvent, b: ActionEvent): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'dahai': {
      const o = b as typeof a;
      return a.pai === o.pai && a.tsumogiri === o.tsumogiri && a.actor === o.actor;
    }
    case 'reach': {
      const o = b as typeof a;
      return a.actor === o.actor;
    }
    case 'chi':
    case 'pon':
    case 'daiminkan': {
      const o = b as typeof a;
      return a.actor === o.actor && a.target === o.target && a.pai === o.pai && sameTileSet(a.consumed, o.consumed);
    }
    case 'ankan': {
      const o = b as typeof a;
      return a.actor === o.actor && sameTileSet(a.consumed, o.consumed);
    }
    case 'kakan': {
      const o = b as typeof a;
      return a.actor === o.actor && a.pai === o.pai && sameTileSet(a.consumed, o.consumed);
    }
    case 'hora': {
      const o = b as typeof a;
      return a.actor === o.actor && a.target === o.target;
    }
    default:
      return true;
  }
}

/** 行動を短い日本語にする（エラーの文言や一覧の表示用）。例: 打3m、ポン 7s、スルー。 */
export function describeAction(action: ActionEvent): string {
  switch (action.type) {
    case 'dahai':
      return `打${action.pai}`;
    case 'reach':
      return 'リーチ';
    case 'chi':
      return `チー ${action.pai}（${action.consumed.join(' ')}）`;
    case 'pon':
      return `ポン ${action.pai}`;
    case 'daiminkan':
      return `大明槓 ${action.pai}`;
    case 'ankan':
      return `暗槓 ${action.consumed[0] ?? ''}`;
    case 'kakan':
      return `加槓 ${action.pai}`;
    case 'hora':
      return action.actor === action.target ? 'ツモ和了' : 'ロン';
    case 'ryukyoku':
      return '九種九牌';
    case 'none':
      return 'スルー';
  }
}

/**
 * 判断のあとに、本人が実際にした行動を、牌譜から求める。
 * mjai-reviewer の next_action と同じ考え方:
 * - dora・reach_accepted は飛ばす
 * - 次が誰かのツモなら「何もしなかった」（none）
 * - 次が和了なら、続く 3 件の中の本人の和了。無ければ none（ロンしなかった）
 * - 次が他家の行動（他家のチー・ポン・ロンなど）なら none
 * - それ以外の本人の行動はそのもの
 * 判断の行われた位置（index）のあとの event を見る。求められなければ null。
 */
export function deriveActualAction(events: readonly MjaiEvent[], index: number, playerId: Seat): ActionEvent | null {
  for (let i = index + 1; i < events.length; i++) {
    const ev = events[i] as MjaiEvent;
    switch (ev.type) {
      case 'dora':
      case 'reach_accepted':
        continue;
      case 'tsumo':
        return { type: 'none' };
      case 'hora': {
        for (const e of events.slice(i, i + 3)) {
          if (e.type === 'hora' && e.actor === playerId) return e;
        }
        return { type: 'none' };
      }
      case 'ryukyoku':
        return ev;
      case 'end_kyoku':
      case 'end_game':
      case 'start_game':
      case 'start_kyoku':
        return null;
      default:
        return ev.actor !== playerId ? { type: 'none' } : ev;
    }
  }
  return null;
}
