import type { RatingLinkInput } from '../../src/rating-link';
import type { TimelineMarkInput } from '../../src/timeline-link';
import {
  loadFx4Ocr,
  loadFx4Widget,
  loadFx5Ocr,
  loadFx5Widget,
  type WidgetEventFixture,
} from './fixtures';

/** 時間の並びでの当てはめ（E-29・E-30）に渡す、迷いと評価。どちらも、半荘の中の通し番号（`id`）と押した時刻を持つ。 */
export interface FixtureMark extends TimelineMarkInput {
  id: number;
}

export interface FixtureRating extends RatingLinkInput {
  id: number;
  rating: 'good' | 'fair' | 'bad';
}

export interface FixtureTimeline {
  marks: FixtureMark[];
  ratings: FixtureRating[];
}

/** ローカル時刻の文字列（例: 2026-10-11T15:37:02.516）を、ミリ秒にする（試験の PC の時間帯によらない）。 */
export function timeOf(time: string): number {
  return new Date(time).getTime();
}

/** 「15:37:02」の形（ローカル時刻）にする。 */
export function clockOf(t_ms: number): string {
  const d = new Date(t_ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function ratingOf(event: WidgetEventFixture, shot?: { lines?: string[]; retries?: string[][] }): FixtureRating {
  if (event.rating === undefined) throw new Error(`評価の値が無い: id=${event.id}`);
  return {
    id: event.id,
    t_ms: timeOf(event.time),
    rating: event.rating,
    ...(shot?.lines === undefined ? {} : { lines: shot.lines }),
    ...(shot?.retries === undefined ? {} : { retries: shot.retries }),
  };
}

/**
 * FX-4（10月9日の半荘）の、迷い6と評価5。迷いの読み取りは fx4-ocr.json（迷い6は、1回目で読めず、読み直しで読める）。
 * 評価は、スクショを文字認識にかけていないので、読めない評価。ユーザーが選んだ結びつけは入れない（読み取りだけの当てはめ）。
 */
export function fx4Timeline(): FixtureTimeline {
  const ocrByMark = new Map(loadFx4Ocr().map((m) => [m.mark, m] as const));
  const events = loadFx4Widget();
  const marks: FixtureMark[] = [];
  const ratings: FixtureRating[] = [];
  for (const event of events) {
    if (event.type === 'rating') {
      ratings.push(ratingOf(event));
      continue;
    }
    const ocr = ocrByMark.get(event.mark ?? -1);
    if (ocr === undefined) throw new Error(`迷い${event.mark}の読み取りが無い`);
    marks.push({
      id: event.id,
      t_ms: timeOf(event.time),
      lines: ocr.lines,
      ...(ocr.retries === undefined ? {} : { retries: ocr.retries.map((r) => r.lines) }),
    });
  }
  return { marks, ratings };
}

/**
 * FX-5（10月11日の半荘）の、迷い13と評価9。読み取りは fx5-ocr.json（1回目と、読み直し2つの行）。
 * ユーザーが選んだ結びつけは入れない（読み取りだけの当てはめ）。
 */
export function fx5Timeline(): FixtureTimeline {
  const ocr = loadFx5Ocr();
  const marks: FixtureMark[] = [];
  const ratings: FixtureRating[] = [];
  for (const event of loadFx5Widget()) {
    const shot = event.screenshot === undefined ? undefined : ocr.entries[event.screenshot];
    const reading = shot === undefined ? undefined : { lines: shot.lines, retries: shot.retries?.map((r) => r.lines) };
    if (event.type === 'rating') {
      ratings.push(ratingOf(event, reading));
      continue;
    }
    marks.push({
      id: event.id,
      t_ms: timeOf(event.time),
      ...(reading?.lines === undefined ? {} : { lines: reading.lines }),
      ...(reading?.retries === undefined ? {} : { retries: reading.retries }),
    });
  }
  return { marks, ratings };
}

/**
 * ユーザーが、本物のアプリで選んだ、FX-5 の迷い7つの結びつけ（ACCEPTANCE の FX-5。迷いの id → 判断の鍵）。
 * 15:37:02 東2局5巡目の打6s、15:38:10 東2局8巡目の打9m、15:40:03 東3局1本場2巡目の打1m、15:42:37 東4局5巡目の打2s、
 * 15:42:52 東4局6巡目の打4p、15:50:36 南1局2本場3巡目の打1s、16:03:19 南4局6巡目のリーチ（打2p）。
 */
export const FX5_USER_CHOICES: Readonly<Record<number, string>> = {
  2: 'k1h0e5',
  4: 'k1h0e8',
  6: 'k2h1e1',
  8: 'k3h0e4',
  9: 'k3h0e6',
  13: 'k4h2e2',
  21: 'k7h0e6',
};

/**
 * ユーザーが、本物のアプリで選んだ、FX-4 の迷い6つの結びつけ（E-17。迷いの id → 判断の鍵）。迷い 1〜5 は ACCEPTANCE の E-17 の正解、
 * 迷い 6（id 9）は、東3局1本場 11巡目の打3m（残り29）に結びつけた（決定記録の 9回目のシートのあと）。
 */
export const FX4_USER_CHOICES: Readonly<Record<number, string>> = {
  1: 'k0h0e4',
  3: 'k1h0e12',
  5: 'k1h1e7',
  6: 'k1h1e10',
  8: 'k2h1e6',
  9: 'k2h1e14',
};

/** 迷いに、ユーザーが選んだ結びつけを付ける。 */
export function withChoices(marks: readonly FixtureMark[], choices: Readonly<Record<number, string>>): FixtureMark[] {
  return marks.map((mark) => (choices[mark.id] === undefined ? mark : { ...mark, chosen: choices[mark.id] }));
}
