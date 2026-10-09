import { describe, expect, it } from 'vitest';

import { ENGINE_PACKAGE } from './index';

// 後続の機能（F1 の牌譜の取り込みなど）がテストを足すまでの置き場。
// vitest がこのパッケージで動くこと自体を確かめる。
describe('@jantama/engine', () => {
  it('エントリが読み込める', () => {
    expect(ENGINE_PACKAGE).toBe('@jantama/engine');
  });
});
