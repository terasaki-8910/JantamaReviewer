/**
 * 検索で当たった文字に、下線（印）を付けるための区切り（U-22）。画面に依存しない、純粋な関数だけ。
 *
 * 当たりの決め方は、検索と同じ（`sessionFilter.ts` の `normalize`・`isTermHit`）: 全角・半角と大文字・小文字は区別せず、
 * 数字で始まる語は別の数字の途中には当てない。表示する文字を 1 文字ずつ正規化して、正規化したあとの位置を、
 * もとの文字の位置に戻す（「１０月」を「10月」で探しても、「１０」のところに印が付く）。
 */
import { isTermHit, normalize } from '../sessionFilter';

export interface Segment {
  text: string;
  /** 検索の語に当たった部分か。 */
  hit: boolean;
}

/** 表示する文字を正規化した文字列と、その各文字がもとの文字列のどこ（始まりと終わり）に当たるか。 */
function normalized(text: string): { text: string; spans: Array<readonly [number, number]> } {
  let out = '';
  const spans: Array<readonly [number, number]> = [];
  let at = 0;
  for (const ch of text) {
    const next = normalize(ch);
    for (let i = 0; i < next.length; i += 1) spans.push([at, at + ch.length]);
    out += next;
    at += ch.length;
  }
  return { text: out, spans };
}

/**
 * `text` の中で、検索の語（`queryTerms` が返す、正規化した語）に当たる範囲。重なる・隣り合う範囲は 1 つにまとめる。
 * 範囲は、もとの文字列の位置（始まりを含み、終わりを含まない）。
 */
export function hitRanges(text: string, terms: readonly string[]): Array<readonly [number, number]> {
  if (terms.length === 0 || text === '') return [];
  const base = normalized(text);
  const found: Array<[number, number]> = [];
  for (const term of terms) {
    if (term === '') continue;
    for (let at = base.text.indexOf(term); at >= 0; at = base.text.indexOf(term, at + 1)) {
      if (!isTermHit(base.text, term, at)) continue;
      const first = base.spans[at];
      const last = base.spans[at + term.length - 1];
      if (first !== undefined && last !== undefined) found.push([first[0], last[1]]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const previous = merged.at(-1);
    if (previous !== undefined && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** `text` を、当たった部分とそれ以外に区切る（つなぐと、もとの文字列になる）。当たりが無ければ 1 つだけ。 */
export function splitHits(text: string, terms: readonly string[]): Segment[] {
  const ranges = hitRanges(text, terms);
  if (ranges.length === 0) return [{ text, hit: false }];
  const segments: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) segments.push({ text: text.slice(at, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), hit: false });
  return segments;
}
