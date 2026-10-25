import { describe, expect, it } from 'vitest';

import type { UpdateCheck } from '../../api/update';
import {
  compareVersions,
  displayVersion,
  parseVersion,
  sameVersion,
  shouldOfferUpdate,
  viewOfCheck,
} from './updateDecision';

describe('更新の判断: 版の比べ方（E-50。semver）', () => {
  it('数として比べる（0.10.0 は 0.9.0 より新しい。文字として比べない）', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1);
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
  });

  it('前置きの v は無視する（大文字の V も）', () => {
    expect(compareVersions('v0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('V0.2.1', 'v0.2.1')).toBe(0);
    expect(compareVersions('v0.3.0', '0.2.9')).toBe(1);
    expect(displayVersion('v0.2.1')).toBe('0.2.1');
    expect(displayVersion(' 0.2.1 ')).toBe('0.2.1');
    expect(sameVersion('v0.2.1', '0.2.1')).toBe(true);
  });

  it('前置きの印（-beta.1 など）が付いた版は、付かない版より古い。印どうしは semver の決まりで比べる', () => {
    expect(compareVersions('0.2.1-beta.1', '0.2.1')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2.1-rc.1')).toBe(1);
    // semver の仕様書の並び: alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < (印なし)
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(compareVersions(ordered[i] as string, ordered[i + 1] as string)).toBe(-1);
      expect(compareVersions(ordered[i + 1] as string, ordered[i] as string)).toBe(1);
    }
    // 「+」から後ろ（ビルドの情報）は比べない
    expect(compareVersions('0.2.1+build.5', '0.2.1')).toBe(0);
  });

  it('読めない版は比べられない（null）', () => {
    for (const bad of ['', 'latest', '1', '1.2', '1.2.x', '1.2.3.4', 'one.two.three', '1.2.3-']) {
      expect(parseVersion(bad)).toBeNull();
      expect(compareVersions(bad, '0.2.0')).toBeNull();
      expect(compareVersions('0.2.0', bad)).toBeNull();
    }
    expect(parseVersion('0.2.1-beta.1+x')).toEqual({ major: 0, minor: 2, patch: 1, pre: ['beta', 1] });
  });
});

describe('更新の判断: 知らせを出すか（E-50）', () => {
  it('見つけた版が今の版より新しく、飛ばした版でなければ出す', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.1', null)).toBe(true);
    expect(shouldOfferUpdate('0.2.0', '0.10.0', null)).toBe(true);
    expect(shouldOfferUpdate('0.9.0', '0.10.0', null)).toBe(true);
    expect(shouldOfferUpdate('0.2.0', 'v0.3.0', undefined)).toBe(true);
    // 飛ばした版が、今の版より古いだけ（前の飛ばしの名残）なら、関係しない
    expect(shouldOfferUpdate('0.2.0', '0.2.1', '0.1.5')).toBe(true);
  });

  it('飛ばした版と同じなら出さない', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.1', '0.2.1')).toBe(false);
    expect(shouldOfferUpdate('0.2.0', 'v0.2.1', '0.2.1')).toBe(false);
  });

  it('飛ばした版より新しければ、また出す', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.2', '0.2.1')).toBe(true);
    expect(shouldOfferUpdate('0.2.0', '0.10.0', '0.9.0')).toBe(true);
  });

  it('飛ばした版より古い版は、出さない（巻き戻された配布先の情報では、知らせない）', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.1', '0.3.0')).toBe(false);
  });

  it('今の版と同じか古ければ出さない', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.0', null)).toBe(false);
    expect(shouldOfferUpdate('0.2.0', 'v0.2.0', null)).toBe(false);
    expect(shouldOfferUpdate('0.2.0', '0.1.9', null)).toBe(false);
    expect(shouldOfferUpdate('0.10.0', '0.9.0', null)).toBe(false);
    // 前置きの印が付いた版は、付かない版より古い（今が 0.2.1 なら、0.2.1-beta は新しくない）
    expect(shouldOfferUpdate('0.2.1', '0.2.1-beta.1', null)).toBe(false);
    expect(shouldOfferUpdate('0.2.1-beta.1', '0.2.1', null)).toBe(true);
  });

  it('読めない版は出さない。飛ばした版が読めなければ、文字として同じ版だけを飛ばす', () => {
    expect(shouldOfferUpdate('0.2.0', 'latest', null)).toBe(false);
    expect(shouldOfferUpdate('dev', '0.2.1', null)).toBe(false);
    expect(shouldOfferUpdate('0.2.0', '0.2.1', 'さっきの版')).toBe(true);
    expect(shouldOfferUpdate('0.2.0', '0.2.1', '   ')).toBe(true);
  });
});

describe('更新の判断: 確かめた結果の出し方（E-50）', () => {
  const check = (outcome: Omit<UpdateCheck, 'current_version'>, current = '0.2.0'): UpdateCheck =>
    ({ current_version: current, ...outcome }) as UpdateCheck;

  it('確かめの失敗は、設定から確かめたときは「確かめられませんでした」（理由つき）になり、起動のときは何も出さない', () => {
    const failed = check({ kind: 'failed', message: '通信できませんでした' });
    expect(viewOfCheck(failed, 'manual')).toEqual({ kind: 'failed', message: '通信できませんでした' });
    expect(viewOfCheck(failed, 'launch')).toEqual({ kind: 'none' });
  });

  it('最新・まだ設定されていないは、どちらの場面でも出す', () => {
    for (const source of ['launch', 'manual'] as const) {
      expect(viewOfCheck(check({ kind: 'up_to_date' }), source)).toEqual({ kind: 'up_to_date' });
      expect(viewOfCheck(check({ kind: 'not_configured' }), source)).toEqual({ kind: 'not_configured' });
    }
  });

  it('新しい版があると告げられたら、版を出す（前置きの v は除く）。今の版より新しくなければ、最新として扱う', () => {
    const found = (version: string, current = '0.2.0') =>
      check({ kind: 'available', version, notes: null, date: null }, current);
    expect(viewOfCheck(found('0.2.1'), 'launch')).toEqual({ kind: 'available', version: '0.2.1' });
    expect(viewOfCheck(found('v0.2.1'), 'manual')).toEqual({ kind: 'available', version: '0.2.1' });
    expect(viewOfCheck(found('0.2.0'), 'manual')).toEqual({ kind: 'up_to_date' });
    expect(viewOfCheck(found('0.1.0'), 'manual')).toEqual({ kind: 'up_to_date' });
    expect(viewOfCheck(found('nightly'), 'manual')).toEqual({ kind: 'up_to_date' });
  });
});
