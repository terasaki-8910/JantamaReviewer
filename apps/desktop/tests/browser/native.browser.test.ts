// @vitest-environment node
/**
 * 実ブラウザで、「ブラウザの名残を見せない」画面側の備え（N-3、N-5、N-8〜N-11）を確かめる。
 * 実際の入口（main.tsx・widget/main.tsx）を動かして、描かれた画面の中で確かめる。
 *
 * - N-3 右クリック: 入力欄の上のほかでは、メニューを出さない（既定の動作が止められる）
 * - N-5 画面の切り替えで、URL・履歴が変わらない
 * - N-8 文字は選択できない（入力欄と、選択を許した文字は選択できる）。画像と図は引きずれない
 * - N-9 カーソルは矢印が基本、操作できるものだけが指の形。中ボタンと戻る・進むのボタンは止める
 * - N-10 すべての入力欄に、スペルチェック・自動入力などを切る属性がある
 * - N-11 スクロールバーはトークンの色で細く、端まで行っても引っ張られない
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TINY_PNG,
  launchBrowser,
  startPageServer,
  tauriMockScript,
  type PageServer,
  type Scenario,
} from './harness';

const state = {
  status: 'recording',
  session_id: '20261009-161200',
  mark_count: 2,
  ratings: ['good', 'fair'],
  next_hand: 3,
  can_undo: true,
  error: null,
};

const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
};

const at = (h: number, mi: number) => new Date(2026, 9, 9, h, mi, 0).getTime();

const sessions = [
  {
    id: '20261009-161200',
    started_ms: at(16, 12),
    mark_count: 3,
    rating_count: 2,
    marks: [0, 1, 2].map((i) => ({
      id: 10 + i,
      t_ms: at(16, 14 + i),
      screenshot: `marks/${i}.png`,
      capture: 'window',
      capture_error: null,
      screenshot_path: `C:\\data\\marks\\${i}.png`,
    })),
    ratings: [
      { id: 100, t_ms: at(16, 20), rating: 'good', hand: 1 },
      { id: 101, t_ms: at(16, 24), rating: 'bad', hand: 2 },
    ],
    events: [],
  },
];

function scenario(label: Scenario['label'], overrides: Partial<Scenario> = {}): Scenario {
  return { label, state, settings, sessions, thumb: TINY_PNG, ...overrides };
}

/** ページの窓に届いた入力のイベントを、バブルの段階（ほかのハンドラのあと）で記録する。 */
const RECORD_EVENTS = `(function () {
  window.__seen = [];
  var types = ['contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dragstart', 'dragover', 'drop'];
  types.forEach(function (type) {
    window.addEventListener(type, function (e) {
      var t = e.target;
      window.__seen.push({ type: type, button: e.button, prevented: e.defaultPrevented, tag: t && t.tagName ? t.tagName : '' });
    }, false);
  });
})();`;

let server: PageServer;
let browser: Browser;

beforeAll(async () => {
  server = await startPageServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Opened {
  context: BrowserContext;
  page: Page;
  problems: string[];
}

async function open(
  file: 'index.html' | 'widget.html',
  viewport: { width: number; height: number },
  scn: Scenario,
): Promise<Opened> {
  const context = await browser.newContext({ viewport, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  await page.addInitScript(tauriMockScript(scn));
  await page.addInitScript(RECORD_EVENTS);
  await page.goto(new URL(file, server.url).toString());
  return { context, page, problems };
}

async function openMain(): Promise<Opened> {
  const opened = await open('index.html', { width: 1280, height: 800 }, scenario('main'));
  await opened.page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
  await opened.page.getByRole('navigation', { name: '半荘の一覧' }).waitFor();
  return opened;
}

async function openSettings(): Promise<Opened> {
  const opened = await openMain();
  await opened.page.getByRole('button', { name: '設定' }).click();
  await opened.page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
  await opened.page.getByRole('radio', { name: 'マウスの「戻る」ボタン' }).waitFor();
  return opened;
}

async function openWidget(): Promise<Opened> {
  const opened = await open('widget.html', { width: 76, height: 336 }, scenario('widget'));
  await opened.page.getByRole('group', { name: '終わった局の評価' }).waitFor();
  return opened;
}

async function seenEvents(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __seen: Array<{ type: string; button: number; prevented: boolean; tag: string }> }).__seen,
  );
}

async function clearEvents(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __seen: unknown[] }).__seen = [];
  });
}

/** 描かれた画面のすべての要素で、カーソルが決まりどおりか（違うものを文にして返す）。 */
async function cursorViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const TEXT_FIELD =
      'textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="range"]):not([type="button"]):not([type="submit"])';
    const CONTROL = 'button, a[href], select, summary, [role="button"]';
    const TOGGLE = 'input[type="radio"], input[type="checkbox"]';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body, body *'))) {
      if (el.closest('.sr-only')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      // 操作できる部品の中（ボタンの文字や図、ラジオを包む札）は、その部品のカーソルを受け継ぐ。
      const toggleLabel = el.closest('label');
      const owner =
        el.closest(CONTROL) ??
        (toggleLabel && toggleLabel.querySelector(TOGGLE) ? toggleLabel : null) ??
        (el.matches(TOGGLE) ? el : null);
      let expected: string;
      if (el.matches(TEXT_FIELD)) {
        expected = (el as HTMLInputElement).disabled ? 'not-allowed' : 'text';
      } else if (owner) {
        const disabled = (owner as HTMLButtonElement).disabled === true || (el as HTMLButtonElement).disabled === true;
        expected = disabled ? 'not-allowed' : 'pointer';
      } else {
        expected = 'default';
      }
      if (style.cursor !== expected) {
        const label = `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().replace(/\s+/g, '.') : ''}`;
        bad.push(`${label}: ${style.cursor}（期待は ${expected}）`);
      }
    }
    return bad;
  });
}

describe('検討画面（記録ページ）', () => {
  it('N-8: 文字は選択できない（三連クリックしても、選択範囲が空のまま）', async () => {
    const { context, page, problems } = await openMain();
    try {
      for (const selector of ['.detail-title', '.brand .full', '.session-when', '.empty, .sec-title']) {
        await page.locator(selector).first().click({ clickCount: 3 });
        const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
        expect(selected, selector).toBe('');
      }
      expect(await page.evaluate(() => getComputedStyle(document.body).userSelect)).toBe('none');
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('N-9: カーソルは、操作できるものだけが指の形で、そのほかの文字・余白は矢印', async () => {
    const { context, page } = await openMain();
    try {
      expect(await cursorViolations(page)).toEqual([]);
      // 一覧と、ボタンが実際に指の形になっている（検査が空振りしていない）。
      const pointers = await page.evaluate(
        () => Array.from(document.querySelectorAll('button')).filter((b) => getComputedStyle(b).cursor === 'pointer').length,
      );
      expect(pointers).toBeGreaterThan(2);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.detail-title') as Element).cursor)).toBe(
        'default',
      );
    } finally {
      await context.close();
    }
  });

  it('N-8: 画像は引きずれない（draggable=false と -webkit-user-drag: none）。図も', async () => {
    const { context, page } = await openMain();
    try {
      await page.locator('img.thumb').first().waitFor();
      const info = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img'));
        const svgs = Array.from(document.querySelectorAll('svg'));
        return {
          images: images.length,
          draggable: images.map((img) => img.draggable),
          imageDrag: images.map((img) => getComputedStyle(img).getPropertyValue('-webkit-user-drag')),
          svgs: svgs.length,
          svgDrag: svgs.map((svg) => getComputedStyle(svg).getPropertyValue('-webkit-user-drag')),
        };
      });
      expect(info.images).toBeGreaterThanOrEqual(3);
      expect(info.draggable.every((d) => d === false)).toBe(true);
      expect(info.imageDrag.every((d) => d === 'none')).toBe(true);
      expect(info.svgs).toBeGreaterThan(3);
      expect(info.svgDrag.every((d) => d === 'none')).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('N-8: 画像を引きずろうとしても、引きずりが始まらない（dragstart が止められる）', async () => {
    const { context, page } = await openMain();
    try {
      const image = page.locator('img.thumb').first();
      await image.waitFor();
      const box = (await image.boundingBox())!;
      await clearEvents(page);
      await page.mouse.move(box.x + 20, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 80, { steps: 6 });
      await page.mouse.up();
      const seen = await seenEvents(page);
      // 引きずりが始まれば dragstart が来る。始まるなら、それは止められている。
      for (const event of seen.filter((e) => e.type === 'dragstart')) expect(event.prevented).toBe(true);
      // 合成のイベントでも、ページの中のどこでも止められる。
      const results = await page.evaluate(() => {
        const out: Record<string, boolean> = {};
        for (const type of ['dragstart', 'dragover', 'drop']) {
          out[type] = document.querySelector('img.thumb')!.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true }));
        }
        return out;
      });
      expect(results).toEqual({ dragstart: false, dragover: false, drop: false });
    } finally {
      await context.close();
    }
  });

  it('N-3: 文字や余白の上で右クリックしても、ブラウザのメニューを出さない（既定の動作が止められる）', async () => {
    const { context, page } = await openMain();
    try {
      for (const selector of ['.detail-title', '.brand .full', '.session-when', '.thumb', 'main.main']) {
        await clearEvents(page);
        const box = (await page.locator(selector).first().boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        const menus = (await seenEvents(page)).filter((e) => e.type === 'contextmenu');
        expect(menus.length, selector).toBe(1);
        expect(menus[0]?.prevented, selector).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it('N-9: 中ボタンを押しても、既定の動作（自動スクロール）が止められる。戻る・進むのボタンも', async () => {
    const { context, page } = await openMain();
    try {
      const box = (await page.locator('.detail-title').boundingBox())!;
      await clearEvents(page);
      await page.mouse.click(box.x + 4, box.y + 4, { button: 'middle' });
      const seen = await seenEvents(page);
      expect(seen.filter((e) => e.type === 'mousedown' && e.button === 1).every((e) => e.prevented)).toBe(true);
      expect(seen.some((e) => e.type === 'mousedown' && e.button === 1)).toBe(true);
      expect(seen.filter((e) => e.type === 'auxclick').every((e) => e.prevented)).toBe(true);

      // Playwright のマウスには戻る・進むのボタンが無いので、合成のイベントで確かめる。
      const results = await page.evaluate(() => {
        const out: Record<string, boolean> = {};
        for (const button of [3, 4]) {
          for (const type of ['mouseup', 'auxclick', 'mousedown']) {
            out[`${type} ${button}`] = document.body.dispatchEvent(
              new MouseEvent(type, { button, bubbles: true, cancelable: true }),
            );
          }
        }
        // 左ボタンは止めない。
        out['mouseup 0'] = document.body.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
        return out;
      });
      for (const [name, notPrevented] of Object.entries(results)) {
        expect(notPrevented, name).toBe(name === 'mouseup 0');
      }
    } finally {
      await context.close();
    }
  });

  it('N-11: 端まで行ってもページが引っ張られない。スクロールバーは細く、色はトークンから', async () => {
    const { context, page } = await openMain();
    try {
      const info = await page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--line-strong)';
        document.body.appendChild(probe);
        const token = getComputedStyle(probe).color;
        probe.remove();
        const root = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        const main = getComputedStyle(document.querySelector('main.main') as Element);
        return {
          token,
          rootOverscroll: root.overscrollBehavior,
          bodyOverscroll: body.overscrollBehavior,
          rootBarWidth: root.scrollbarWidth,
          rootBarColor: root.scrollbarColor,
          mainBarWidth: main.scrollbarWidth,
          mainBarColor: main.scrollbarColor,
        };
      });
      expect(info.rootOverscroll).toBe('none');
      expect(info.bodyOverscroll).toBe('none');
      for (const width of [info.rootBarWidth, info.mainBarWidth]) expect(width).toBe('thin');
      // 2 色（つまみと溝）。つまみはトークン（--line-strong）の色、溝は透明。
      for (const colors of [info.rootBarColor, info.mainBarColor]) {
        expect(colors.startsWith(info.token), `${colors} は ${info.token} で始まる`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it('N-5: 画面を切り替えても、URL・ハッシュ・履歴の項目は変わらない', async () => {
    const { context, page } = await openMain();
    try {
      const before = await page.evaluate(() => ({ href: location.href, length: history.length }));
      await page.getByRole('button', { name: '設定' }).click();
      await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
      await page.getByRole('button', { name: '記録' }).click();
      await page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
      const after = await page.evaluate(() => ({ href: location.href, length: history.length, hash: location.hash }));
      expect(after.href).toBe(before.href);
      expect(after.length).toBe(before.length);
      expect(after.hash).toBe('');
    } finally {
      await context.close();
    }
  });
});

describe('検討画面（設定ページ）', () => {
  it('N-8: 入力欄と、選択を許した文字（保存先のパス）は選択できる。ほかの文字は選択できない', async () => {
    const { context, page } = await openSettings();
    try {
      await page.locator('.path').click({ clickCount: 3 });
      expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).toBe(settings.data_dir);

      await page.locator('textarea').selectText();
      expect(
        await page.evaluate(() => {
          const area = document.querySelector('textarea') as HTMLTextAreaElement;
          return area.selectionEnd - area.selectionStart;
        }),
      ).toBeGreaterThan(0);

      await page.locator('legend.lbl').first().click({ clickCount: 3 });
      expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).not.toContain('迷いマークを付けるボタン');

      const styles = await page.evaluate(() => ({
        textarea: getComputedStyle(document.querySelector('textarea') as Element).userSelect,
        path: getComputedStyle(document.querySelector('.path') as Element).userSelect,
        legend: getComputedStyle(document.querySelector('legend') as Element).userSelect,
      }));
      expect(styles.textarea).toBe('text');
      expect(styles.path).toBe('text');
      expect(styles.legend).not.toBe('text');
    } finally {
      await context.close();
    }
  });

  it('N-9: カーソル（ラジオとチェックの札は指、文字の入力欄は文字の形、ほかの文字は矢印）', async () => {
    const { context, page } = await openSettings();
    try {
      expect(await cursorViolations(page)).toEqual([]);
      const cursors = await page.evaluate(() => ({
        textarea: getComputedStyle(document.querySelector('textarea') as Element).cursor,
        pill: getComputedStyle(document.querySelector('label.pill') as Element).cursor,
        check: getComputedStyle(document.querySelector('label.check') as Element).cursor,
        fieldLabel: getComputedStyle(document.querySelector('.field > label') as Element).cursor,
        hint: getComputedStyle(document.querySelector('.quiet') as Element).cursor,
      }));
      expect(cursors).toEqual({ textarea: 'text', pill: 'pointer', check: 'pointer', fieldLabel: 'default', hint: 'default' });
    } finally {
      await context.close();
    }
  });

  it('N-3: 文字を打ち込む欄の上では右クリックを止めず（メニューを残す）、ほかの上では止める', async () => {
    const { context, page } = await openSettings();
    try {
      await clearEvents(page);
      const area = (await page.locator('textarea').boundingBox())!;
      await page.mouse.click(area.x + 10, area.y + 10, { button: 'right' });
      const onField = (await seenEvents(page)).filter((e) => e.type === 'contextmenu');
      expect(onField).toHaveLength(1);
      expect(onField[0]?.tag).toBe('TEXTAREA');
      expect(onField[0]?.prevented).toBe(false);

      for (const selector of ['.path', 'legend.lbl', '.pill', '.check']) {
        await clearEvents(page);
        const box = (await page.locator(selector).first().boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        const menus = (await seenEvents(page)).filter((e) => e.type === 'contextmenu');
        expect(menus.length, selector).toBe(1);
        expect(menus[0]?.prevented, selector).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it('N-10: すべての入力欄に、スペルチェック・自動入力・自動補正・自動大文字化を切る属性がある', async () => {
    const { context, page } = await openSettings();
    try {
      const fields = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type,
          spellcheck: (el as HTMLInputElement).spellcheck,
          autocomplete: el.getAttribute('autocomplete'),
          autocorrect: el.getAttribute('autocorrect'),
          autocapitalize: el.getAttribute('autocapitalize'),
        })),
      );
      expect(fields.length).toBeGreaterThanOrEqual(7);
      for (const field of fields) {
        expect(field, `${field.tag} ${field.type}`).toMatchObject({
          spellcheck: false,
          autocomplete: 'off',
          autocorrect: 'off',
          autocapitalize: 'off',
        });
      }
    } finally {
      await context.close();
    }
  });

  it('N-10: あとから描かれた入力欄にも、同じ属性が付く', async () => {
    const { context, page } = await openSettings();
    try {
      const attrs = await page.evaluate(async () => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<label><input type="search"></label><textarea></textarea>';
        document.body.appendChild(wrapper);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return Array.from(wrapper.querySelectorAll('input, textarea')).map((el) => ({
          spellcheck: (el as HTMLInputElement).spellcheck,
          autocomplete: el.getAttribute('autocomplete'),
        }));
      });
      expect(attrs).toEqual([
        { spellcheck: false, autocomplete: 'off' },
        { spellcheck: false, autocomplete: 'off' },
      ]);
    } finally {
      await context.close();
    }
  });
});

describe('ウィジェット', () => {
  it('N-8: 文字は選択できない（三連クリックしても選択範囲が空）', async () => {
    const { context, page, problems } = await openWidget();
    try {
      for (const selector of ['.status', '.next']) {
        await page.locator(selector).first().click({ clickCount: 3 });
        expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''), selector).toBe('');
      }
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('N-9: カーソルは、ボタンだけが指の形で、ほかは矢印（つかんで動かす面も矢印）', async () => {
    const { context, page } = await openWidget();
    try {
      expect(await cursorViolations(page)).toEqual([]);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.widget') as Element).cursor)).toBe(
        'default',
      );
    } finally {
      await context.close();
    }
  });

  it('N-3: 右クリックでは、ブラウザのメニューではなく、アプリのメニューを出す（既定の動作は止まり、Rust のコマンドを呼ぶ）', async () => {
    const { context, page } = await openWidget();
    try {
      await clearEvents(page);
      const box = (await page.locator('.status').boundingBox())!;
      await page.mouse.click(box.x + 4, box.y + 4, { button: 'right' });
      const menus = (await seenEvents(page)).filter((e) => e.type === 'contextmenu');
      expect(menus).toHaveLength(1);
      expect(menus[0]?.prevented).toBe(true);
    } finally {
      await context.close();
    }
  });
});
