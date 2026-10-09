// @vitest-environment node
/**
 * L-1 色・L-2 絵文字・L-3 アクセシビリティの静的検査が、実際に違反を見つけること。
 * lint の設定が壊れて何も検出しなくなる事故を防ぐため、わざと違反を含むコードを eslint / stylelint に通す。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

async function eslintRuleIds(code: string, file = 'apps/desktop/src/widget/Probe.tsx'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

async function stylelintRules(code: string, file: string): Promise<string[]> {
  const result = await stylelint.lint({ code, codeFilename: join(ROOT, file), cwd: ROOT });
  return (result.results[0]?.warnings ?? []).map((w) => w.rule);
}

const CLEAN = 'export function Probe() {\n  return <p className="quiet">本文</p>;\n}\n';

describe('eslint（TSX）', () => {
  it('違反の無いコードは通る', async () => {
    expect(await eslintRuleIds(CLEAN)).toEqual([]);
  });

  it('L-1: 色の値の直書きを見つける（16 進・rgb・hsl・color-mix）', async () => {
    for (const literal of ["'#ff0000'", "'#fff'", "'rgb(1, 2, 3)'", "'rgba(1, 2, 3, 0.5)'", "'hsl(10 20% 30%)'", "'color-mix(in srgb, red, blue)'"]) {
      const ids = await eslintRuleIds(`export const c = ${literal};\n`);
      expect(ids, literal).toContain('local/no-literal-color');
    }
  });

  it('L-2: 絵文字を見つける（文言にもコメントにも）', async () => {
    expect(await eslintRuleIds('export const t = "\u{1F600}";\n')).toContain('local/no-emoji');
    expect(await eslintRuleIds('// \u{2728}\nexport const t = 1;\n')).toContain('local/no-emoji');
    // 評価の文字（〇 △ ✕）は絵文字ではない。
    expect(await eslintRuleIds('export const t = "〇△✕";\n')).toEqual([]);
  });

  it('L-3: アクセシビリティの違反を見つける（alt の無い画像・キーボードの無いクリック）', async () => {
    expect(await eslintRuleIds('export const A = () => <img src="a.png" />;\n')).toContain('jsx-a11y/alt-text');
    const clickable = await eslintRuleIds('export const A = () => <div onClick={() => 0}>x</div>;\n');
    expect(clickable).toContain('jsx-a11y/click-events-have-key-events');
    expect(clickable).toContain('jsx-a11y/no-static-element-interactions');
    expect(await eslintRuleIds('export const A = () => <a href="#">x</a>;\n')).toContain(
      'jsx-a11y/anchor-is-valid',
    );
    expect(await eslintRuleIds('export const A = () => <div aria-foo="x" />;\n')).toContain(
      'jsx-a11y/aria-props',
    );
  });

  it('S-2: 画面側のコードから通信できない（fetch・XMLHttpRequest・WebSocket）', async () => {
    for (const call of ["fetch('x')", 'new XMLHttpRequest()', "new WebSocket('x')"]) {
      expect(await eslintRuleIds(`export const r = ${call};\n`), call).toContain('no-restricted-globals');
    }
    // テストのコードには掛けない。
    expect(await eslintRuleIds("export const r = fetch('x');\n", 'apps/desktop/tests/probe.ts')).not.toContain(
      'no-restricted-globals',
    );
  });

  it('絵文字の禁止は、画面以外のコード（テスト・設定）にも掛かる', async () => {
    expect(await eslintRuleIds('export const t = "\u{1F600}";\n', 'apps/desktop/tests/probe.ts')).toContain(
      'local/no-emoji',
    );
    expect(await eslintRuleIds('export default "\u{1F600}";\n', 'packages/engine/src/probe.ts')).toContain(
      'local/no-emoji',
    );
  });
});

describe('stylelint（CSS）', () => {
  const PROBE = 'apps/desktop/src/styles/probe.css';

  it('違反の無い CSS は通る', async () => {
    expect(await stylelintRules('.a {\n  color: var(--ink);\n}\n', PROBE)).toEqual([]);
  });

  it('L-1: 16 進・名前つきの色・色関数を見つける', async () => {
    expect(await stylelintRules('.a {\n  color: #fff;\n}\n', PROBE)).toContain('color-no-hex');
    expect(await stylelintRules('.a {\n  color: red;\n}\n', PROBE)).toContain('color-named');
    const fn = await stylelintRules('.a {\n  color: rgb(0 0 0 / 50%);\n}\n', PROBE);
    expect(fn).toContain('function-disallowed-list');
    expect(await stylelintRules('.a {\n  color: color-mix(in srgb, var(--a), var(--b));\n}\n', PROBE)).toContain(
      'function-disallowed-list',
    );
  });

  it('トークンの定義（tokens.css）だけは、色の値を書いてよい', async () => {
    const code = ':root {\n  --x: #FFFFFF;\n  --y: rgba(0, 0, 0, 0.12);\n}\n';
    expect(await stylelintRules(code, 'apps/desktop/src/styles/tokens.css')).toEqual([]);
    expect(await stylelintRules(code, PROBE)).toContain('color-no-hex');
  });
});
