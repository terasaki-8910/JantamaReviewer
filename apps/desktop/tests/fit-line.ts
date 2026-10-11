/**
 * MAKA の当てはめの見込みの 1 行（U-31。局の評価の表の下）の、HTML 上の形。
 * 「ぴったり 34%・±1段階以内 66%」の割合は、MAKA の評価への当てはめの値で、AI（Mortal）の確率ではない。
 * 「AI の候補・確率・順位が画面に無い」ことを確かめる検査（U-1）は、この 1 行を外してから、確率らしい文字を探す。
 * 試験のデータで、画面の部品ではない。
 */
export const FIT_LINE = /<p class="tbl-note fit"[\s\S]*?<\/p>/g;

/** 画像の場所（asset の URL は、% で符号化された文字を含む）と、MAKA の当てはめの見込みの 1 行を外した HTML。 */
export function withoutImagesAndFitLine(html: string): string {
  return html.replace(/ src="[^"]*"/g, '').replace(FIT_LINE, '');
}
