import { PaipuLinkAnnouncer } from '@jantama/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANNOUNCED_LIMIT,
  ANNOUNCED_STORAGE_KEY,
  loadAnnouncedIds,
  saveAnnouncedIds,
} from './announced';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('知らせた牌譜 ID の記憶（E-15）', () => {
  it('何も覚えていなければ空。書いたものを、そのまま読み戻せる', () => {
    expect(loadAnnouncedIds()).toEqual([]);
    saveAnnouncedIds(['a', 'b']);
    expect(loadAnnouncedIds()).toEqual(['a', 'b']);
  });

  it('覚えるのは、渡した牌譜 ID の文字列だけ（アカウントの番号を含まない ID を渡す前提）', () => {
    saveAnnouncedIds(['261009-7c1e9b2a']);
    expect(window.localStorage.getItem(ANNOUNCED_STORAGE_KEY)).toBe('["261009-7c1e9b2a"]');
  });

  it('上限を超えたら、古いものから忘れる', () => {
    const ids = Array.from({ length: ANNOUNCED_LIMIT + 5 }, (_, i) => `id${i}`);
    saveAnnouncedIds(ids);
    const loaded = loadAnnouncedIds();
    expect(loaded).toHaveLength(ANNOUNCED_LIMIT);
    expect(loaded[0]).toBe('id5');
    expect(loaded.at(-1)).toBe(`id${ANNOUNCED_LIMIT + 4}`);
  });

  it('壊れた記憶・文字列でない項目は、無いものとして扱う', () => {
    window.localStorage.setItem(ANNOUNCED_STORAGE_KEY, '{broken');
    expect(loadAnnouncedIds()).toEqual([]);
    window.localStorage.setItem(ANNOUNCED_STORAGE_KEY, '{"a":1}');
    expect(loadAnnouncedIds()).toEqual([]);
    window.localStorage.setItem(ANNOUNCED_STORAGE_KEY, '["ok", 3, null, "also"]');
    expect(loadAnnouncedIds()).toEqual(['ok', 'also']);
  });

  it('記憶が使えなくても、例外にしない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadAnnouncedIds()).toEqual([]);
    expect(() => saveAnnouncedIds(['a'])).not.toThrow();
  });

  it('覚えた ID を、エンジンの知らせ役に渡すと、同じ牌譜は知らせない（アカウントの番号が違う同じ牌譜も）', () => {
    saveAnnouncedIds(['261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab']);
    const announcer = new PaipuLinkAnnouncer(loadAnnouncedIds());
    const same = 'https://game.mahjongsoul.com/?paipu=261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab_a99999';
    expect(announcer.announce(same)).toBeNull();
    const other = 'https://game.mahjongsoul.com/?paipu=261010-aaaaaaaa-4f3d-4e11-8a55-0123456789ab_a1';
    expect(announcer.announce(other)?.paipuId).toBe('261010-aaaaaaaa-4f3d-4e11-8a55-0123456789ab');
    expect(announcer.announce(other)).toBeNull();
  });
});
