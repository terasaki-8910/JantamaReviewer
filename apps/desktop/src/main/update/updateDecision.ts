/**
 * アプリ内の更新（F21、E-50）の判断。純粋な関数だけ（通信も画面も持たない）。
 *
 * - 版の比べ方は semver（0.10.0 は 0.9.0 より新しい。前置きの v は無視。「-beta.1」のような前置きの印が付いた版は、付かない版より古い。
 *   「+」から後ろ（ビルドの情報）は比べない）
 * - 帯に出すか（`shouldOfferUpdate`）: 見つけた版が今の版より新しく、飛ばした版でなければ出す。飛ばした版と同じなら出さず、
 *   飛ばした版より新しければ出す。今の版と同じか古ければ出さない
 * - 確かめの失敗は、設定の欄では「確かめられませんでした」になり、起動のときの確かめでは何も出さない（`viewOfCheck`）
 */
import type { UpdateCheck } from '../../api/update';

/** 読んだ版。`pre` は「-」の後ろの印（数なら数、そうでなければ文字）。無ければ空（印の無い版）。 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: ReadonlyArray<string | number>;
}

const SEMVER =
  /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 版の文字（semver。前置きの v は無視）を読む。読めなければ null。 */
export function parseVersion(text: string): ParsedVersion | null {
  const match = SEMVER.exec(text.trim());
  if (match === null) return null;
  const numbers = [match[1], match[2], match[3]].map((part) => Number(part));
  if (!numbers.every((n) => Number.isSafeInteger(n))) return null;
  const [major, minor, patch] = numbers as [number, number, number];
  const pre = (match[4] ?? '')
    .split('.')
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { major, minor, patch, pre };
}

function compareNumbers(a: number, b: number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 前置きの印を比べる（semver の決まり）: 数どうしは数で、文字どうしは文字の並びで、数は文字より小さい。揃うところまで同じなら、長いほうが新しい。 */
function comparePre(a: ParsedVersion['pre'], b: ParsedVersion['pre']): -1 | 0 | 1 {
  // 印の無い版は、印のある版より新しい
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    if (typeof x === 'number' && typeof y === 'number') {
      const result = compareNumbers(x, y);
      if (result !== 0) return result;
    } else if (typeof x === 'number') {
      return -1;
    } else if (typeof y === 'number') {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return compareNumbers(a.length, b.length);
}

/** 2 つの版を比べる（a が新しければ 1、古ければ -1、同じなら 0）。どちらかが読めなければ null。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  return (
    compareNumbers(left.major, right.major) ||
    compareNumbers(left.minor, right.minor) ||
    compareNumbers(left.patch, right.patch) ||
    comparePre(left.pre, right.pre)
  );
}

/** 画面に出す版の文字（前置きの v を除く）。 */
export function displayVersion(text: string): string {
  return text.trim().replace(/^[vV](?=\d)/, '');
}

/** 同じ版か。読めない文字どうしは、前後の空白と前置きの v を除いた文字が同じなら同じ。 */
export function sameVersion(a: string, b: string): boolean {
  const compared = compareVersions(a, b);
  return compared === null ? displayVersion(a) === displayVersion(b) : compared === 0;
}

/**
 * 更新の知らせを出すか（E-50）。
 * - 見つけた版が今の版より新しくなければ、出さない（同じ・古い・読めない）
 * - 飛ばした版があり、見つけた版がそれと同じか古ければ、出さない。飛ばした版より新しければ、出す
 */
export function shouldOfferUpdate(current: string, found: string, skipped: string | null | undefined): boolean {
  const newer = compareVersions(found, current);
  if (newer === null || newer <= 0) return false;
  if (skipped === null || skipped === undefined || skipped.trim() === '') return true;
  const againstSkipped = compareVersions(found, skipped);
  if (againstSkipped === null) return !sameVersion(found, skipped);
  return againstSkipped > 0;
}

/** 確かめた結果を、設定の「更新」の欄に出す形にしたもの。 */
export type CheckView =
  /** まだ確かめていない（起動のときの確かめが、失敗したときも）。 */
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'not_configured' }
  | { kind: 'up_to_date' }
  | { kind: 'available'; version: string }
  | { kind: 'failed'; message: string };

/** 確かめた場面。起動のとき（黙って確かめる）と、設定の「更新を確かめる」を押したとき。 */
export type CheckSource = 'launch' | 'manual';

/**
 * 確かめた結果を、設定の欄に出す形にする。
 * - 失敗は、設定から確かめたときだけ出す（起動のときは、何も出さない: `none`）
 * - 「新しい版がある」と告げられても、今の版より新しくなければ（同じ・古い・読めない）、最新として扱う
 */
export function viewOfCheck(check: UpdateCheck, source: CheckSource): CheckView {
  switch (check.kind) {
    case 'not_configured':
      return { kind: 'not_configured' };
    case 'up_to_date':
      return { kind: 'up_to_date' };
    case 'failed':
      return source === 'manual' ? { kind: 'failed', message: check.message } : { kind: 'none' };
    case 'available': {
      const newer = compareVersions(check.version, check.current_version);
      return newer !== null && newer > 0
        ? { kind: 'available', version: displayVersion(check.version) }
        : { kind: 'up_to_date' };
    }
  }
}
