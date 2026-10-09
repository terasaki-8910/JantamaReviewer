/**
 * @jantama/engine: 牌譜の読み取り・盤面の再生・受け入れ枚数・Rating・段階の当てはめ・解き直しの予定など、
 * 画面にも Tauri にも依存しない計算を置く純粋な TypeScript パッケージ。
 * DOM・ネットワーク・ファイルには触れない（ファイルの読み書きと通信は呼び出す側が受け持つ）。
 *
 * 主な入口:
 * - 取り込み: `importReportText` / `importReport`（結果 JSON を検査し、牌譜を再生して、判断ごとの盤面を作る。E-1・E-2）
 * - 判断の種類とタグ: `classifyDecisionKind` / `classifyTags`（E-8）
 * - 不一致の一覧: `listDisagreements`（E-4）
 * - 受け入れ枚数: `shanten` / `ukeire` / `discardOptions` / `tenhouPairiUrl`（E-3）、打牌の判断での比較: `compareDiscardUkeire`（F6）
 * - 2〜3巡前からの再生: `framesBeforeDecision`（F3）
 * - Rating: `gameRating` / `handRatings`（E-12）、段階の当てはめ: `fitGradeModel` / `evaluateLeaveOneGameOut`（E-13）
 * - 局の結果と暫定の〇△✕: `summarizeKyokus`（E-6）、評価の突き合わせ: `alignRatings`（E-7）
 * - 解き直しの予定: `scheduleReview`（E-5）、牌譜リンク: `parsePaipuLink`（E-9）、MAKA の打牌: `recordMakaMove`（E-14）
 */
export const ENGINE_PACKAGE = '@jantama/engine' as const;

export * from './actions';
export * from './decision';
export * from './disagreement';
export * from './discard-compare';
export * from './grade';
export * from './import';
export * from './isotonic';
export * from './kyoku';
export * from './maka';
export * from './outcome';
export * from './paipu-link';
export * from './rating';
export * from './rating-alignment';
export * from './replay';
export * from './report';
export * from './report-types';
export * from './result';
export * from './shanten';
export * from './srs';
export * from './tenhou-url';
export * from './tiles';
