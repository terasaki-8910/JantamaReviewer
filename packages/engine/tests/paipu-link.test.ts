import { describe, expect, it } from 'vitest';

import { parsePaipuLink } from '../src/paipu-link';

// 試験用の作り物の ID とアカウントの番号（実在しない）。
const ID = '230101-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ACCOUNT = '12345678';
const URL_WITH_ACCOUNT = `https://game.mahjongsoul.com/?paipu=${ID}_a${ACCOUNT}`;

function parsed(input: string) {
  const result = parsePaipuLink(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('E-9 牌譜リンクの読み取り', () => {
  it('E-9 「雀魂牌譜:URL」の形から、牌譜 ID と送る URL を取り出す', () => {
    expect(parsed(`雀魂牌譜:${URL_WITH_ACCOUNT}`)).toEqual({ paipuId: ID, url: URL_WITH_ACCOUNT });
  });

  it('E-9 URL だけでも、同じ牌譜 ID と URL を取り出す', () => {
    expect(parsed(URL_WITH_ACCOUNT)).toEqual({ paipuId: ID, url: URL_WITH_ACCOUNT });
    expect(parsed(`雀魂牌譜:${URL_WITH_ACCOUNT}`)).toEqual(parsed(URL_WITH_ACCOUNT));
  });

  it('E-9 前後の空白・タブ・改行（CRLF・全角の空白を含む）は無視する', () => {
    const expected = { paipuId: ID, url: URL_WITH_ACCOUNT };
    expect(parsed(`  ${URL_WITH_ACCOUNT}  `)).toEqual(expected);
    expect(parsed(`\n${URL_WITH_ACCOUNT}\n`)).toEqual(expected);
    expect(parsed(`\r\n\t雀魂牌譜:${URL_WITH_ACCOUNT}\r\n`)).toEqual(expected);
    expect(parsed(`\u3000雀魂牌譜:${URL_WITH_ACCOUNT}\u3000\n\n`)).toEqual(expected);
    expect(parsed(`雀魂牌譜:\n${URL_WITH_ACCOUNT}`)).toEqual(expected);
  });

  it('E-9 コロンが全角でも、前に別の文字が付いていても、リンクの部分を取り出す', () => {
    const expected = { paipuId: ID, url: URL_WITH_ACCOUNT };
    expect(parsed(`雀魂牌譜：${URL_WITH_ACCOUNT}`)).toEqual(expected);
    expect(parsed(`牌譜を共有します ${URL_WITH_ACCOUNT}`)).toEqual(expected);
  });

  it('E-9 アカウントの番号（_a の後ろ）が無い共有リンクも読める。送る URL にも付けない', () => {
    const bare = `https://game.mahjongsoul.com/?paipu=${ID}`;
    expect(parsed(bare)).toEqual({ paipuId: ID, url: bare });
    expect(parsed(`雀魂牌譜:${bare}`)).toEqual({ paipuId: ID, url: bare });
  });

  it('E-9 牌譜 ID にはアカウントの番号を含めない（同じ牌譜は、視点が違っても同じ ID になる）', () => {
    const a = parsed(`https://game.mahjongsoul.com/?paipu=${ID}_a11111111`);
    const b = parsed(`https://game.mahjongsoul.com/?paipu=${ID}_a22222222`);
    expect(a.paipuId).toBe(ID);
    expect(b.paipuId).toBe(ID);
    expect(a.paipuId).not.toContain('_a');
    expect(a.url).not.toBe(b.url);
  });

  it('E-9 http で始まるものも、送る URL は https にそろえる', () => {
    expect(parsed(`http://game.mahjongsoul.com/?paipu=${ID}_a${ACCOUNT}`).url).toBe(URL_WITH_ACCOUNT);
  });

  it('E-9 空・雀魂のリンクでないものは、理由を返して失敗する', () => {
    const empty = parsePaipuLink('   \n ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('empty');

    for (const bad of [
      'hello',
      'https://example.com/?paipu=abc',
      'https://game.mahjongsoul.com/',
      'https://game.mahjongsoul.com/?paipu=',
      'https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json',
    ]) {
      const r = parsePaipuLink(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code, bad).toBe('no-link');
    }
  });

  it('E-9 失敗の理由には、入力の文字列（ID・アカウントの番号）を含めない', () => {
    const r = parsePaipuLink(`https://example.com/?paipu=${ID}_a${ACCOUNT}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(ID);
    expect(r.error.message).not.toContain(ACCOUNT);
  });
});
