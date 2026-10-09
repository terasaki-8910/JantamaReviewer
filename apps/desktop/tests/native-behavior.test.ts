// @vitest-environment node
/**
 * 「ブラウザの名残を見せない」画面側の備え（N-3、N-5、N-7〜N-11）が、どちらの窓の入口にも入っていること、
 * HTML と CSS がそれを崩していないことを、ソースを読んで確かめる。
 * 備えの動きそのものは、jsdom の単体テスト（src/shared）と、実ブラウザの検査（tests/browser/native.browser.test.ts）が確かめる。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${APP}${path}`, 'utf8');

describe('どちらの窓の入口も、同じ備えをしている', () => {
  for (const entry of ['src/main/main.tsx', 'src/widget/main.tsx']) {
    describe(entry, () => {
      const source = read(entry);

      it('起動時に installNativeBehavior() を呼ぶ（右クリック・中ボタン・戻る進む・引きずり・入力欄の属性）', () => {
        expect(source).toMatch(/^import \{ installNativeBehavior \} from '\.\.\/shared\/nativeBehavior';$/m);
        expect(source).toMatch(/^installNativeBehavior\(\);$/m);
      });

      it('いちばん外側に ErrorBoundary を置く（ブラウザのエラーページの代わりのアプリの中のエラー画面）', () => {
        expect(source).toMatch(/<StrictMode>\s*<ErrorBoundary[^>]*>\s*<\w+ \/>\s*<\/ErrorBoundary>\s*<\/StrictMode>/);
      });

      it('native.css と error-screen.css を、トークンのあとに読み込む', () => {
        const tokens = source.indexOf("import '../styles/tokens.css';");
        const native = source.indexOf("import '../styles/native.css';");
        const error = source.indexOf("import '../styles/error-screen.css';");
        expect(tokens).toBeGreaterThanOrEqual(0);
        expect(native).toBeGreaterThan(tokens);
        expect(error).toBeGreaterThan(native);
      });

      it('テーマの初期化（背景色の知らせを含む）を呼ぶ', () => {
        expect(source).toMatch(/^initTheme\(\);$/m);
      });
    });
  }

  it('ウィジェットの窓は、小さい窓向けのエラー画面（compact）を使う', () => {
    expect(read('src/widget/main.tsx')).toMatch(/<ErrorBoundary compact>/);
    expect(read('src/main/main.tsx')).not.toMatch(/<ErrorBoundary compact>/);
  });
});

describe('HTML', () => {
  for (const page of ['index.html', 'widget.html']) {
    it(`${page}: 日本語・題名あり・アイコンは空（アイコンの要求で、存在しないページを探さない）・外のページを読み込まない`, () => {
      const html = read(page);
      expect(html).toMatch(/<html lang="ja">/);
      expect(html).toMatch(/<title>JantamaReviewer .+<\/title>/);
      expect(html).toMatch(/<link rel="icon" href="data:," \/>/);
      expect(html).not.toMatch(/<a\b|<form\b|<iframe\b|target="_blank"/);
    });
  }
});

describe('native.css（N-8、N-9、N-11）', () => {
  const css = read('src/styles/native.css');

  /** セレクタの塊 `{...}` の中身を、宣言ごとに取り出す。 */
  const declarationsOf = (selector: string): string[] => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} の規則がある`).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
  };

  it('N-8: UI の文字は選択できず、入力欄と .selectable だけ選択できる', () => {
    expect(declarationsOf('body')).toContain('user-select: none');
    expect(css).toMatch(/input,\s*textarea,\s*\.selectable \{\s*user-select: text;/);
  });

  it('N-8: 画像と図は引きずれない（-webkit-user-drag: none）', () => {
    expect(css).toMatch(/img,\s*svg \{\s*-webkit-user-drag: none;/);
  });

  it('N-9: カーソルは矢印が基本で、操作できるものだけが指の形・入力欄は文字の形', () => {
    expect(declarationsOf('body')).toContain('cursor: default');
    expect(css).toMatch(/\{\s*cursor: pointer;\s*\}/);
    expect(css).toMatch(/textarea \{\s*cursor: text;/);
    expect(css).toMatch(/:disabled[\s\S]*cursor: not-allowed/);
  });

  it('N-11: 端まで行ってもページが引っ張られない。スクロールバーは細く、色はトークンから', () => {
    expect(declarationsOf('html')).toContain('overscroll-behavior: none');
    expect(declarationsOf('body')).toContain('overscroll-behavior: none');
    expect(css).toMatch(/\* \{\s*scrollbar-width: thin;\s*scrollbar-color: var\(--[a-z-]+\) transparent;/);
  });
});
