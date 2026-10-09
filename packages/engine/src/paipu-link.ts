/**
 * 雀魂の牌譜リンクの読み取り（E-9、F1）。
 *
 * 雀魂からコピーしたリンクは「雀魂牌譜:https://game.mahjongsoul.com/?paipu=<ID>_a<数字>」の形になる。
 * この前に付いた文字や、前後の空白・改行を取り除いて、どちらの形（URL だけでも）でも同じ牌譜 ID を取り出す。
 */
import { type Result, err, ok } from './result';

export interface PaipuLink {
  /**
   * mjai.ekyu.moe に送る URL（正規の形。`https://game.mahjongsoul.com/?paipu=<ID>_a<数字>`）。
   * 末尾の `_a<数字>` は、だれの視点で検討するかを決めるアカウントの番号なので、元のリンクにあればそのまま残す。
   */
  url: string;
  /** 牌譜の ID（`_a<数字>` を含まない）。同じ牌譜かどうかの判定に使える。 */
  paipuId: string;
}

export type PaipuLinkErrorCode = 'empty' | 'no-link';

export interface PaipuLinkError {
  code: PaipuLinkErrorCode;
  /** 利用者に見せてよい理由。入力の文字列は含めない。 */
  message: string;
}

/** ID は数字・英数字・ハイフン。末尾の `_a<数字>` は ID に含めない（`_` は ID に使われない）。 */
const LINK_PATTERN = /https?:\/\/game\.mahjongsoul\.com\/\?paipu=([0-9A-Za-z-]+)(?:_a(\d+))?/;

/**
 * 牌譜リンクの文字列から、送る URL と牌譜 ID を取り出す。
 *
 * 個人情報の扱い（重要）: `_a<数字>` はアカウントを特定できる番号なので、
 * ログに出さない・データの保存先（設定の data_dir）の外に書かない。
 * URL をクリップボードや mjai.ekyu.moe の入力欄に渡すのは構わないが、記録に残すのは `paipuId`（番号を含まない）にする。
 * このため、失敗の理由にも入力の文字列を含めない。
 */
export function parsePaipuLink(input: string): Result<PaipuLink, PaipuLinkError> {
  if (input.trim().length === 0) {
    return err({ code: 'empty', message: '牌譜リンクが空です' });
  }
  const m = LINK_PATTERN.exec(input);
  const paipuId = m?.[1];
  if (!m || paipuId === undefined) {
    return err({
      code: 'no-link',
      message: '雀魂の牌譜リンク（https://game.mahjongsoul.com/?paipu=...）が見つかりません',
    });
  }
  const account = m[2];
  const url = `https://game.mahjongsoul.com/?paipu=${paipuId}${account === undefined ? '' : `_a${account}`}`;
  return ok({ url, paipuId });
}
