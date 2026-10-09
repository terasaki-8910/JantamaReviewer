/**
 * プロジェクト固有の ESLint 規則（ACCEPTANCE L-1 / L-2）。
 * ユーザー自身の Bayesian-chara-picker の規則（no-emoji / no-literal-color）をそのまま移した。
 *
 * いずれもソーステキスト全体を走査する。AST ノード（文字列リテラル / JSXText）
 * だけを見る実装にすると、コメントや識別子に紛れた違反を取りこぼすため。
 */

/** 絵文字。© ® ™ は Extended_Pictographic に含まれるが記号として正当なので除外する。 */
const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/gu;
const EMOJI_ALLOW = new Set(['©', '®', '™']);

/** 色リテラル。hex / rgb() / hsl() / oklch() などの関数記法。 */
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/g;

/** ソーステキスト上の絶対 index から報告する共通ヘルパ。 */
function reportAt(context, index, messageId, data) {
  const sourceCode = context.sourceCode;
  context.report({
    loc: sourceCode.getLocFromIndex(index),
    messageId,
    data,
  });
}

/** L-2: ソースに絵文字を 1 文字も置かない。 */
const noEmoji = {
  meta: {
    type: 'problem',
    docs: { description: 'ソース中の絵文字を禁止する（ACCEPTANCE L-2）' },
    schema: [],
    messages: {
      found: '絵文字は使用できません（U+{{code}}）。テキストまたはアイコンに置き換えてください。',
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.getText();
        for (const match of text.matchAll(EMOJI_RE)) {
          if (EMOJI_ALLOW.has(match[0])) continue;
          const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
          reportAt(context, match.index, 'found', { code });
        }
      },
    };
  },
};

/** L-1: デザイントークン以外で色リテラルを書かない。 */
const noLiteralColor = {
  meta: {
    type: 'problem',
    docs: { description: '色リテラルの直書きを禁止する（ACCEPTANCE L-1）' },
    schema: [],
    messages: {
      found:
        '色リテラル "{{literal}}" は直書きできません。tokens.css のデザイントークン（var(--...)）経由で参照してください。',
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.getText();
        for (const match of text.matchAll(COLOR_RE)) {
          reportAt(context, match.index, 'found', { literal: match[0] });
        }
      },
    };
  },
};

export default {
  meta: { name: 'jantama-local' },
  rules: {
    'no-emoji': noEmoji,
    'no-literal-color': noLiteralColor,
  },
};
