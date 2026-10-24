/**
 * MAKA の当てはめの見込みの 1 行（U-31。局の評価の表の下）の、HTML 上の形。
 * 「ぴったり 34%・±1段階以内 66%」の割合は、MAKA の評価への当てはめの値で、AI（Mortal）の確率ではない。
 * 「AI の候補・確率・順位が画面に無い」ことを確かめる検査（U-1）は、この 1 行を外してから、確率らしい文字を探す。
 * 半荘のページの見出しの、AI 一致率・類似度・悪手率の 1 行（U-48。F18）も同じ: 半荘全体の割合で、判断ごとの AI の答え
 * （候補・確率・順位）ではない。1 行と、説明のアイコンの重なりの文（「確率」という言葉が入る）を外してから探す。
 * 試験のデータで、画面の部品ではない。
 */
export const FIT_LINE = /<p class="tbl-note fit"[\s\S]*?<\/p>/g;

/** AI 一致率・類似度・悪手率の 1 行（一覧と説明のアイコン。入れ子の div は無い）。 */
export const AI_METRICS_LINE = /<div class="head-metrics">[\s\S]*?<\/div>/g;

/** その説明の重なりの文（body の下に描かれる）。 */
export const AI_METRICS_HINT = /<span class="infotip-pop"[^>]*>AI（Mortal）と比べた数です[\s\S]*?<\/span>/g;

/**
 * 画像の場所（asset の URL は、% で符号化された文字を含む）と、MAKA の当てはめの見込みの 1 行と、
 * AI 一致率・類似度・悪手率の 1 行（と説明の文）を外した HTML。
 */
export function withoutImagesAndFitLine(html: string): string {
  return html.replace(/ src="[^"]*"/g, '').replace(FIT_LINE, '').replace(AI_METRICS_LINE, '').replace(AI_METRICS_HINT, '');
}
