// @vitest-environment node
/**
 * 実ブラウザで、mjai の窓に入れるスクリプトを検査する（E-11、N-9、N-10）。
 *
 * - E-11: URL 欄 `input[name="log-url"]` に牌譜リンクを入れるスクリプト（Rust のソース `prefill.js`）が、手書きの写しの
 *   フォームの上で、値を入れて、input と change のイベントを出す。送信のボタンは押さず、フォームも送信しない。
 *   写しは `tests/browser/fixtures/` の手書きのページで、サイトの HTML ではない。
 * - N-9・N-10: 窓の作り始めに評価させるページ側の設定（`mjai_native.js`）が、マウスの戻る・進む・中ボタンの既定の動作を止め、
 *   入力欄のスペルチェックと入力候補を切る。
 *
 * スクリプトは、Rust の窓が評価するものと同じファイルを読む（Rust 側は、`(関数)(牌譜リンクの JSON の文字列);` の形で評価する。
 * その組み立ては、`src-tauri/tests/mjai_navigation.rs` が確かめている）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchBrowser } from './harness';

const IMPORT_SOURCES = resolve(import.meta.dirname, '../../src-tauri/src/import');
const FIXTURES = resolve(import.meta.dirname, 'fixtures');

const prefillSource = readFileSync(resolve(IMPORT_SOURCES, 'prefill.js'), 'utf8');
const nativeSource = readFileSync(resolve(IMPORT_SOURCES, 'mjai_native.js'), 'utf8');

/** `prefill.js` の関数の式（先頭の説明のコメントと、終わりの `;` を除く）。Rust の `prefill_function` と同じ取り出し方。 */
const prefillFunction = prefillSource.slice(prefillSource.indexOf('(function')).trimEnd().replace(/;$/, '');

/** Rust の窓が評価する形（`prefill_script`）と同じ文を作る。 */
function prefillScript(link: string): string {
  return `(${prefillFunction})(${JSON.stringify(link)});`;
}

const LINK = 'https://game.example.test/?paipu=261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab_a12345';

let browser: Browser;

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
});

interface Opened {
  context: BrowserContext;
  page: Page;
  problems: string[];
  external: string[];
}

async function openFixture(name: string, init?: string): Promise<Opened> {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const problems: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('request', (request) => {
    if (!request.url().startsWith('file:') && !request.url().startsWith('data:')) external.push(request.url());
  });
  if (init) await page.addInitScript(init);
  await page.goto(pathToFileURL(resolve(FIXTURES, name)).href);
  return { context, page, problems, external };
}

interface FormState {
  value: string;
  events: string[];
  changeHandlerCalls: number;
  submits: number;
  clicks: number;
  active: string;
  url: string;
}

async function formState(page: Page): Promise<FormState> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __events: string[];
      __changeHandlerCalls?: number;
      __submits: number;
      __clicks: number;
    };
    const field = document.querySelector<HTMLInputElement>('input[name="log-url"]');
    return {
      value: field?.value ?? '(欄が無い)',
      events: [...w.__events],
      changeHandlerCalls: w.__changeHandlerCalls ?? 0,
      submits: w.__submits,
      clicks: w.__clicks,
      active: document.activeElement?.tagName ?? '',
      url: location.href,
    };
  });
}

describe('E-11: URL 欄に牌譜リンクを入れるスクリプト', () => {
  it('値を入れて、input と change のイベントを 1 回ずつ（この順で）出す。サイトの change の処理も働く', async () => {
    const { context, page, problems, external } = await openFixture('mjai-form.html');
    try {
      const before = await formState(page);
      const result = await page.evaluate(prefillScript(LINK));
      expect(result).toBe('filled');
      const after = await formState(page);
      expect(after.value).toBe(LINK);
      expect(after.events).toEqual(['input', 'change']);
      // 欄の onchange（写しの changeURL）まで届いている。
      expect(after.changeHandlerCalls).toBe(1);
      expect(problems).toEqual([]);
      expect(external).toEqual([]);
      expect(before.value).toBe('');
    } finally {
      await context.close();
    }
  });

  it('送信のボタンは押さず、フォームも送信せず、ページも移らず、フォーカスも動かさない', async () => {
    const { context, page } = await openFixture('mjai-form.html');
    try {
      const before = await formState(page);
      await page.evaluate(prefillScript(LINK));
      // 少し待って、あとから起きる送信がないことも確かめる。
      await page.waitForTimeout(300);
      const after = await formState(page);
      expect(after.clicks).toBe(0);
      expect(after.submits).toBe(0);
      expect(after.url).toBe(before.url);
      expect(after.active).toBe('BODY');
      // 送信のボタンは、押せる状態のまま（スクリプトが、無効にも有効にもしていない）。
      expect(await page.locator('button[name="submitBtn"]').isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('もう一度評価しても、同じ値のまま（ページを読み直すたびに入れる）。送信は起きない', async () => {
    const { context, page } = await openFixture('mjai-form.html');
    try {
      await page.evaluate(prefillScript(LINK));
      await page.evaluate(prefillScript(LINK));
      const after = await formState(page);
      expect(after.value).toBe(LINK);
      expect(after.events).toEqual(['input', 'change', 'input', 'change']);
      expect(after.submits).toBe(0);
      expect(after.clicks).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('欄があとから現れるページでは、現れるのを待って入れる（Cloudflare の確認のあとの読み直しなど）', async () => {
    const { context, page, problems } = await openFixture('mjai-form-late.html');
    try {
      expect(await page.evaluate(prefillScript(LINK))).toBe('waiting');
      await page.waitForFunction(() => {
        const field = document.querySelector<HTMLInputElement>('input[name="log-url"]');
        return field !== null && field.value !== '';
      });
      const after = await formState(page);
      expect(after.value).toBe(LINK);
      expect(after.events).toEqual(['input', 'change']);
      await page.waitForTimeout(200);
      const later = await formState(page);
      expect(later.submits).toBe(0);
      expect(later.clicks).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('欄が無いページ（確認の待ち画面）では、何もせず、エラーも出さない', async () => {
    const { context, page, problems } = await openFixture('mjai-challenge.html');
    try {
      expect(await page.evaluate(prefillScript(LINK))).toBe('waiting');
      await page.waitForTimeout(200);
      expect(await page.locator('input').count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('引用符・バックスラッシュ・スクリプトの終わり・改行に似た字を含むリンクでも、欄の値になるだけで、実行されない', async () => {
    const links = [
      'https://example.test/?q="x\\y"</script><script>window.__pwned=1</script>',
      "https://example.test/?a=');window.__pwned=1;//",
      'https://example.test/? x y',
      'https://example.test/#${window.__pwned=1}`',
    ];
    for (const link of links) {
      const { context, page, problems } = await openFixture('mjai-form.html');
      try {
        await page.evaluate(prefillScript(link));
        const state = await formState(page);
        expect(state.value).toBe(link);
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        expect(state.submits).toBe(0);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});

describe('N-9・N-10: mjai の窓のページ側の設定', () => {
  it('マウスの戻る・進む・中ボタンの既定の動作を止め、ほかのボタンは止めない', async () => {
    const { context, page, problems } = await openFixture('mjai-native.html', nativeSource);
    try {
      const results = await page.evaluate(() => {
        const out: Record<string, boolean> = {};
        for (const type of ['mousedown', 'mouseup', 'auxclick']) {
          for (const button of [0, 1, 2, 3, 4]) {
            const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
            document.getElementById('link')?.dispatchEvent(event);
            out[`${type}:${button}`] = event.defaultPrevented;
          }
        }
        return out;
      });
      for (const type of ['mousedown', 'mouseup', 'auxclick']) {
        expect(results[`${type}:1`], `${type} 中ボタン`).toBe(true);
        expect(results[`${type}:3`], `${type} 戻る`).toBe(true);
        expect(results[`${type}:4`], `${type} 進む`).toBe(true);
        expect(results[`${type}:0`], `${type} 左`).toBe(false);
        expect(results[`${type}:2`], `${type} 右`).toBe(false);
      }
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('入力欄（最初からあるもの・あとから足されるもの）の入力候補とスペルチェックを切る', async () => {
    const { context, page } = await openFixture('mjai-native.html', nativeSource);
    try {
      await page.waitForFunction(() => document.getElementById('late') !== null);
      for (const id of ['early', 'area', 'late']) {
        await page.waitForFunction(
          (target) => {
            const el = document.getElementById(target);
            return el?.getAttribute('autocomplete') === 'off' && el.getAttribute('spellcheck') === 'false';
          },
          id,
        );
      }
    } finally {
      await context.close();
    }
  });
});
