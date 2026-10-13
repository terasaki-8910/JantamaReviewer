/**
 * 待ちと打点の言い方（タブ「待ちと打点」・「他家の手牌」・局の結果の手が、同じ書き方で出す）。
 * 点は 3 桁ごとにカンマ（12,000）、飜は「4飜」、役満は「役満」「2倍役満」。
 */
import type { WaitLine } from '@jantama/engine';

/** 点数の書き方: 12,000。 */
export const num = (n: number): string => Math.round(n).toLocaleString('en-US');

/** 飜の言い方: 4飜・役満・2倍役満。 */
export function hanText(line: Pick<WaitLine, 'han' | 'yakuman'>): string {
  if (line.yakuman > 0) return line.yakuman >= 2 ? `${line.yakuman}倍役満` : '役満';
  return `${line.han}飜`;
}

/** ツモの言い方: 子のツモは「子・親」、親のツモは「オール」。支払いが無いとき（ロンの行）は空。 */
export function tsumoText(line: Pick<WaitLine, 'tsumoPay'>, dealer: boolean): string {
  if (line.tsumoPay === null) return '';
  return dealer ? `${num(line.tsumoPay.child)}オール` : `${num(line.tsumoPay.child)}・${num(line.tsumoPay.dealer)}`;
}
