/**
 * stylelint の設定。ユーザー自身の Bayesian-chara-picker の .stylelintrc.json の規約
 * （color-no-hex / color-named: never / 色関数の禁止。トークンのファイルだけ除外）を移した。
 * ACCEPTANCE L-1: トークンの定義以外に色の値を直接書かない。
 */
export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/target/**', 'state/**', 'coverage/**', 'docs/**'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': [
      'rgb',
      'rgba',
      'hsl',
      'hsla',
      'hwb',
      'lab',
      'lch',
      'oklab',
      'oklch',
      'color-mix',
    ],
  },
  overrides: [
    {
      // tokens.css は承認済みのサンプル（round2-samples/tokens.css）の写しで、書式を変えない
      // （トークンはデザインの確認を通してしか変えない）。色の定義はここだけに置くので、
      // 色の直書きの禁止と、書式だけの規則（rgba の記法・空行・16進の桁数など）をこのファイルでは外す。
      files: ['apps/desktop/src/styles/tokens.css'],
      rules: {
        'color-no-hex': null,
        'color-named': null,
        'function-disallowed-list': null,
        'color-function-notation': null,
        'color-function-alias-notation': null,
        'alpha-value-notation': null,
        'color-hex-length': null,
        'custom-property-empty-line-before': null,
        'declaration-empty-line-before': null,
        'declaration-block-single-line-max-declarations': null,
        'rule-empty-line-before': null,
        'at-rule-empty-line-before': null,
        'value-keyword-case': null,
        'property-no-vendor-prefix': null,
        'property-no-deprecated': null,
      },
    },
  ],
};
