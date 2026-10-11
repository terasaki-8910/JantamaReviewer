import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CenterText, firstReadable, parseCenterText } from '../src/center-text';
import { FIXTURES_DIR } from './helpers/fixtures';

// E-32: FX-6（画面の中央だけを残した迷いマーク19枚。FX-5 の13枚と FX-4 の6枚）を、Windows の日本語の文字認識で読んだ結果の写し
// （fixtures/fx6-ocr.json。作り方は generate_fx6_ocr.py）に、E-16 の関数（parseCenterText）と E-20 の選び方（firstReadable）を当てる。
// 文字認識そのもの（Rust の ocr クレートの試験 tests/ocr_fixtures.rs）は Windows だけで動く。ここは、写しの行が、どの OS でも
// 局・残り枚数・自分の点数に取り出せること（と、読み違えたものを別の値として取らないこと）を確かめる。

interface Fx6Reading {
  variant: string;
  lines: string[];
}

interface Fx6Image {
  file: string;
  width: number;
  height: number;
  expected: { wind: 'E' | 'S' | 'W'; number: 1 | 2 | 3 | 4; tilesLeft: number; score: number };
  /** 水色の文字の位置から決めた切り出し [左, 上, 幅, 高さ]。 */
  located: [number, number, number, number] | null;
  /** 水色の文字の位置から切り出して読んだ結果（1 回目 plain、読み直し contrast1.8・upscale1.5）。 */
  tight: Fx6Reading[];
  /** 画面の大きさに対する割合の箱で読んだ結果（E-32 より前の読み方）。 */
  box: Fx6Reading[];
}

const images = (
  JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'fx6-ocr.json'), 'utf8')) as { images: Fx6Image[] }
).images;

const expectedOf = (image: Fx6Image): CenterText => ({
  wind: image.expected.wind,
  number: image.expected.number,
  tilesLeft: image.expected.tilesLeft,
  score: image.expected.score,
});

/** 1 回目の読み取りが、正解どおりに読めた枚数。 */
const firstReadingHits = (pick: (image: Fx6Image) => Fx6Reading[]): number =>
  images.filter((image) => {
    const first = pick(image)[0];
    return first !== undefined && JSON.stringify(parseCenterText(first.lines)) === JSON.stringify(expectedOf(image));
  }).length;

describe('E-32 FX-6 の19枚の文字認識の写し', () => {
  it('19枚: FX-5 の13枚（1368×800）と FX-4 の6枚（1447×935）。どれも水色の文字の位置が見つかっている', () => {
    expect(images).toHaveLength(19);
    expect(images.filter((i) => i.width === 1368 && i.height === 800)).toHaveLength(13);
    expect(images.filter((i) => i.width === 1447 && i.height === 935)).toHaveLength(6);
    for (const image of images) {
      expect(image.located, image.file).not.toBeNull();
      expect(image.tight.map((r) => r.variant), image.file).toEqual(['plain', 'contrast1.8', 'upscale1.5']);
    }
  });

  it('E-32 水色の文字の位置から切り出すと、1 回目と読み直しのうち最初に読めたもの（E-20）が、19枚とも正解の局・残り枚数・点数', () => {
    for (const image of images) {
      const [first, ...retries] = image.tight;
      expect(first, image.file).toBeDefined();
      const read = firstReadable(
        first?.lines ?? [],
        retries.map((r) => r.lines),
      );
      expect(read, image.file).toEqual(expectedOf(image));
    }
  });

  it('E-32 1 回目の読み取りだけでも、割合の箱（13枚中1枚・6枚中5枚）より多く、正解のとおりに読める', () => {
    const boxHits = firstReadingHits((i) => i.box);
    const tightHits = firstReadingHits((i) => i.tight);
    // 前の読み方: FX-5 の 13 枚は 1 枚（2026-10-11 の調べ）、FX-4 の 6 枚は 5 枚（E-16・E-20）。
    expect(boxHits).toBe(6);
    expect(
      images.filter((i) => i.width === 1368).filter((i) => {
        const first = i.box[0];
        return first !== undefined && parseCenterText(first.lines) !== null;
      }),
    ).toHaveLength(1);
    expect(tightHits).toBeGreaterThanOrEqual(14);
    expect(tightHits).toBeGreaterThan(boxHits);
  });

  it('水色の文字の位置から切り出した読み取りは、読めたときは必ず正解の値になる（読み違えを、別の局・残り枚数・点数として取らない）', () => {
    for (const image of images) {
      for (const reading of image.tight) {
        const read = parseCenterText(reading.lines);
        if (read !== null) {
          expect(read, `${image.file} ${reading.variant}`).toEqual(expectedOf(image));
        }
      }
    }
  });

  it('前の読み方（割合の箱）では、左右の点数が行に混ざり、読み違えた点数を取った読み取りが 1 つあった（FX-4 の迷い2 を 1.5 倍に広げた画像: 左の人の 37000）', () => {
    const wrong: string[] = [];
    for (const image of images) {
      for (const reading of image.box) {
        const read = parseCenterText(reading.lines);
        if (read !== null && JSON.stringify(read) !== JSON.stringify(expectedOf(image))) {
          wrong.push(`${image.file} ${reading.variant} ${read.score}`);
        }
      }
    }
    expect(wrong).toEqual(['fx6-fx4-mark2.png upscale1.5 37000']);
  });
});
