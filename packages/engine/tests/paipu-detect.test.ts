import { describe, expect, it } from 'vitest';

import { PaipuLinkAnnouncer, detectNewPaipuLink, detectPaipuLink, parsePaipuLink } from '../src/paipu-link';

// 試験用の作り物の ID とアカウントの番号（実在しない）。
const ID = '230101-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ID = '230102-ffffffff-0000-1111-2222-333333333333';
const ACCOUNT = '12345678';
const URL_WITH_ACCOUNT = `https://game.mahjongsoul.com/?paipu=${ID}_a${ACCOUNT}`;
const EXPECTED = { paipuId: ID, url: URL_WITH_ACCOUNT };
/** 全角の空白（U+3000）。ソースに目に見えない文字を直接書かないよう、コードから作る。 */
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

describe('E-15 牌譜リンクの検出（クリップボードの文字列から）', () => {
  it('E-15 「雀魂牌譜:URL」の形から、牌譜 ID と URL を返す', () => {
    expect(detectPaipuLink(`雀魂牌譜:${URL_WITH_ACCOUNT}`)).toEqual(EXPECTED);
  });

  it('E-15 URL だけの形でも、同じ牌譜 ID を返す', () => {
    expect(detectPaipuLink(URL_WITH_ACCOUNT)).toEqual(EXPECTED);
    expect(detectPaipuLink(`雀魂牌譜:${URL_WITH_ACCOUNT}`)).toEqual(detectPaipuLink(URL_WITH_ACCOUNT));
  });

  it('E-15 前後に別の文がある形（改行をまたぐ・リンクのあとに文が続く）でも、リンクの部分を見つける', () => {
    expect(detectPaipuLink(`この半荘を検討したい\n雀魂牌譜:${URL_WITH_ACCOUNT}\nよろしく`)).toEqual(EXPECTED);
    expect(detectPaipuLink(`見て ${URL_WITH_ACCOUNT} です`)).toEqual(EXPECTED);
    expect(detectPaipuLink(`メモ: 検討待ち\r\n\r\n${URL_WITH_ACCOUNT}\r\n`)).toEqual(EXPECTED);
    expect(detectPaipuLink(`${IDEOGRAPHIC_SPACE}雀魂牌譜：${URL_WITH_ACCOUNT}${IDEOGRAPHIC_SPACE}`)).toEqual(EXPECTED);
  });

  it('E-15 アカウントの番号が無いリンクも見つける。牌譜 ID には番号を含めない', () => {
    const bare = `https://game.mahjongsoul.com/?paipu=${ID}`;
    expect(detectPaipuLink(bare)).toEqual({ paipuId: ID, url: bare });
    expect(detectPaipuLink(URL_WITH_ACCOUNT)?.paipuId).toBe(ID);
    expect(detectPaipuLink(URL_WITH_ACCOUNT)?.paipuId).not.toContain('_a');
  });

  it('E-15 リンクが複数あるときは、最初のものを返す', () => {
    const other = `https://game.mahjongsoul.com/?paipu=${OTHER_ID}_a1`;
    expect(detectPaipuLink(`${URL_WITH_ACCOUNT}\n${other}`)?.paipuId).toBe(ID);
    expect(detectPaipuLink(`${other}\n${URL_WITH_ACCOUNT}`)?.paipuId).toBe(OTHER_ID);
  });

  it('E-15 parsePaipuLink（E-9）と同じ読み取りをする。読めないときだけ null', () => {
    for (const input of [URL_WITH_ACCOUNT, `雀魂牌譜:${URL_WITH_ACCOUNT}`, `前 ${URL_WITH_ACCOUNT} 後`]) {
      const parsed = parsePaipuLink(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(detectPaipuLink(input)).toEqual(parsed.value);
    }
  });

  it('E-15 牌譜でない URL・リンクの無い文字列・空の文字列では、何も返さない', () => {
    for (const text of [
      '',
      '   ',
      `\r\n\t${IDEOGRAPHIC_SPACE}`,
      'こんにちは',
      'https://example.com/',
      `https://example.com/?paipu=${ID}_a${ACCOUNT}`,
      'https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json',
      'https://game.mahjongsoul.com/',
      'https://game.mahjongsoul.com/?paipu=',
      'https://game.mahjongsoul.com/?other=1',
      `game.mahjongsoul.com/?paipu=${ID}`,
      `https://game.mahjongsoul.com.example.com/?paipu=${ID}`,
      `https://evilgame.mahjongsoul.com/?paipu=${ID}`,
      'paipu=230101-aaaaaaaa',
    ]) {
      expect(detectPaipuLink(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('E-15 とても長い文字列でも、リンクの有無を返せる', () => {
    const filler = 'あ'.repeat(200_000);
    expect(detectPaipuLink(`${filler}${URL_WITH_ACCOUNT}${filler}`)).toEqual(EXPECTED);
    expect(detectPaipuLink(filler)).toBeNull();
  });
});

describe('E-15 同じ牌譜 ID は一度しか知らせない', () => {
  it('E-15 通知済みの集合に無ければ返し、あれば何も返さない（集合は書き換えない）', () => {
    const announced: ReadonlySet<string> = new Set<string>();
    expect(detectNewPaipuLink(URL_WITH_ACCOUNT, announced)).toEqual(EXPECTED);
    expect(announced.size).toBe(0);
    expect(detectNewPaipuLink(URL_WITH_ACCOUNT, new Set([ID]))).toBeNull();
    expect(detectNewPaipuLink(URL_WITH_ACCOUNT, new Set([OTHER_ID]))).toEqual(EXPECTED);
  });

  it('E-15 牌譜でない文字列は、通知済みかどうかによらず何も返さない', () => {
    expect(detectNewPaipuLink('', new Set())).toBeNull();
    expect(detectNewPaipuLink('https://example.com/', new Set([ID]))).toBeNull();
  });

  it('E-15 入れ物（PaipuLinkAnnouncer）は、同じクリップボードを何度読んでも一度だけ知らせる', () => {
    const announcer = new PaipuLinkAnnouncer();
    expect(announcer.announce(`雀魂牌譜:${URL_WITH_ACCOUNT}`)).toEqual(EXPECTED);
    expect(announcer.announce(`雀魂牌譜:${URL_WITH_ACCOUNT}`)).toBeNull();
    expect(announcer.announce(URL_WITH_ACCOUNT)).toBeNull();
    expect(announcer.announce(`前 ${URL_WITH_ACCOUNT} 後`)).toBeNull();
  });

  it('E-15 視点（アカウントの番号）が違うだけの同じ牌譜も、一度しか知らせない', () => {
    const announcer = new PaipuLinkAnnouncer();
    expect(announcer.announce(`https://game.mahjongsoul.com/?paipu=${ID}_a11111111`)?.paipuId).toBe(ID);
    expect(announcer.announce(`https://game.mahjongsoul.com/?paipu=${ID}_a22222222`)).toBeNull();
    expect(announcer.announce(`https://game.mahjongsoul.com/?paipu=${ID}`)).toBeNull();
  });

  it('E-15 別の牌譜 ID は、それぞれ一度ずつ知らせる。リンクでない文字列は何も変えない', () => {
    const announcer = new PaipuLinkAnnouncer();
    const other = `https://game.mahjongsoul.com/?paipu=${OTHER_ID}`;
    expect(announcer.announce(URL_WITH_ACCOUNT)?.paipuId).toBe(ID);
    expect(announcer.announce('ただの文')).toBeNull();
    expect(announcer.announce(other)?.paipuId).toBe(OTHER_ID);
    expect(announcer.announce(other)).toBeNull();
    expect(announcer.announce(URL_WITH_ACCOUNT)).toBeNull();
    expect(announcer.ids()).toEqual([ID, OTHER_ID]);
  });

  it('E-15 取り込み済みの牌譜 ID を最初に渡しておくと、その牌譜は知らせない。あとから足すこともできる', () => {
    const announcer = new PaipuLinkAnnouncer([ID]);
    expect(announcer.has(ID)).toBe(true);
    expect(announcer.announce(URL_WITH_ACCOUNT)).toBeNull();

    const other = `https://game.mahjongsoul.com/?paipu=${OTHER_ID}`;
    expect(announcer.has(OTHER_ID)).toBe(false);
    announcer.markAnnounced(OTHER_ID);
    expect(announcer.has(OTHER_ID)).toBe(true);
    expect(announcer.announce(other)).toBeNull();
  });

  it('E-15 保存した牌譜 ID の一覧から、入れ物を作り直せる（アカウントの番号は入らない）', () => {
    const first = new PaipuLinkAnnouncer();
    first.announce(URL_WITH_ACCOUNT);
    const saved = first.ids();
    expect(saved).toEqual([ID]);
    expect(saved.join(',')).not.toContain(ACCOUNT);

    const second = new PaipuLinkAnnouncer(saved);
    expect(second.announce(URL_WITH_ACCOUNT)).toBeNull();
    expect(second.announce(`https://game.mahjongsoul.com/?paipu=${OTHER_ID}`)?.paipuId).toBe(OTHER_ID);
  });
});
