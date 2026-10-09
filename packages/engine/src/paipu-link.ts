/**
 * 雀魂の牌譜リンクの読み取り（E-9、F1）と、クリップボードの文字列からの検出（E-15）。
 *
 * 雀魂からコピーしたリンクは「雀魂牌譜:https://game.mahjongsoul.com/?paipu=<ID>_a<数字>」の形になる。
 * この前に付いた文字や、前後の空白・改行を取り除いて、どちらの形（URL だけでも）でも同じ牌譜 ID を取り出す。
 * 検出（`detectPaipuLink`）は、前後に別の文があってもリンクの部分を見つけ、同じ牌譜 ID は一度しか知らせない。
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

/**
 * クリップボードの文字列から、雀魂の牌譜リンクを見つける（E-15、F1）。
 *
 * 「雀魂牌譜:URL」の形・URL だけ・前後に別の文がある形のどれでも、最初に見つかったリンクの
 * 送る URL と牌譜 ID を返す（読み取りは `parsePaipuLink` と同じ）。
 * 牌譜でない URL・リンクの無い文字列・空の文字列では null。理由は要らないので、失敗は null にする。
 *
 * 個人情報の扱い: 返り値の `url` には、元のリンクにあればアカウントの番号（`_a<数字>`）が残る。
 * 記録に残すのは `paipuId` だけにする（`parsePaipuLink` の注意と同じ）。
 */
export function detectPaipuLink(text: string): PaipuLink | null {
  const parsed = parsePaipuLink(text);
  return parsed.ok ? parsed.value : null;
}

/**
 * 通知済みの牌譜 ID（announced）に無い牌譜リンクだけを返す。同じ牌譜 ID は一度しか知らせない（E-15）。
 *
 * 純粋な関数で、announced は書き換えない。知らせたら、呼ぶ側が返り値の `paipuId` を announced に足す
 * （入れ物が欲しいときは `PaipuLinkAnnouncer`）。比べるのは牌譜 ID なので、アカウントの番号（視点）が
 * 違うだけの同じ牌譜も、通知済みとして扱う。
 */
export function detectNewPaipuLink(text: string, announced: ReadonlySet<string>): PaipuLink | null {
  const link = detectPaipuLink(text);
  return link === null || announced.has(link.paipuId) ? null : link;
}

/**
 * 通知済みの牌譜 ID を覚えて、同じ牌譜 ID を一度しか知らせない入れ物（E-15）。
 * 検討画面が前面に来るたびにクリップボードを読んで `announce` に渡す。取り込み済みの牌譜 ID は、
 * 最初に `new PaipuLinkAnnouncer(ids)` で渡しておけば、知らせない。
 */
export class PaipuLinkAnnouncer {
  private readonly announced: Set<string>;

  constructor(announced: Iterable<string> = []) {
    this.announced = new Set(announced);
  }

  /** まだ知らせていない牌譜リンクなら返して、通知済みにする。リンクでない・通知済みなら null。 */
  announce(text: string): PaipuLink | null {
    const link = detectNewPaipuLink(text, this.announced);
    if (link !== null) this.announced.add(link.paipuId);
    return link;
  }

  /** この牌譜 ID を通知済みにする（取り込んだときなど）。 */
  markAnnounced(paipuId: string): void {
    this.announced.add(paipuId);
  }

  has(paipuId: string): boolean {
    return this.announced.has(paipuId);
  }

  /** 通知済みの牌譜 ID（保存して、次の起動で `new PaipuLinkAnnouncer(ids)` に渡せる）。 */
  ids(): string[] {
    return [...this.announced];
  }
}
