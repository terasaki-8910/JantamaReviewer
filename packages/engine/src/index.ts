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
 * - クリップボードの牌譜リンク: `detectPaipuLink`（見つける）・`detectNewPaipuLink` / `PaipuLinkAnnouncer`（同じ牌譜 ID は一度だけ知らせる）（E-15）
 * - 画面中央の文字認識の行から局・残りの牌の数・点数: `parseCenterText(lines)`（E-16）。
 *   結びつけの関数に渡すスクショの読み取りは `ScreenReading`（`center`＝読み取り済み か `lines`＝文字認識の行）。
 * - 迷いマークの結びつけ: `linkMarks(report, marks)`（E-17）。局は点数との照合で決め（`kyokuFactsOf` / `locateKyokus`）、
 *   判断は残りの牌の数がいちばん近いもの（同じ差は候補すべて）。判断の呼び名と保存用の鍵は
 *   `DecisionRef`（`listDecisionRefs` / `findDecisionRef` / `decisionKey`。「手で選ぶ」の一覧にも使う）
 * - 局の評価（〇△✕）の結びつけ: `linkRatings(report, ratings)`（E-18）。評価は `t_ms` と読み取り（`center` か `lines`）を持つ記録。
 *   局の始め（残り `HAND_START_TILES_LEFT` 枚以上）に読めたら前の局、途中なら読んだ局、読めないものは前後の間へ押した順。
 *   戻り値は `alignRatings`（E-7）と同じ形（status・assigned・extra・missingHands・message）に、評価ごとの当てはめ方 `placements` を足したもの
 * - 結果を結びつける半荘: `matchSessionForReport(report, sessions)`（E-19）。sessions は結果がまだ無い半荘
 *   （`id`・`started_ms`・スクショの読み取り `marks`）。合うものがちょうど1つなら `match`、合うものが無いか2つ以上なら `choose`
 *   （`sessionIds` は新しい順）、結果の無い半荘が無ければ `new`
 */
export const ENGINE_PACKAGE = '@jantama/engine' as const;

export * from './actions';
export * from './center-text';
export * from './decision';
export * from './decision-ref';
export * from './disagreement';
export * from './discard-compare';
export * from './grade';
export * from './import';
export * from './isotonic';
export * from './kyoku';
export * from './kyoku-locate';
export * from './maka';
export * from './mark-link';
export * from './outcome';
export * from './paipu-link';
export * from './rating';
export * from './rating-alignment';
export * from './rating-link';
export * from './replay';
export * from './report';
export * from './report-types';
export * from './result';
export * from './session-match';
export * from './shanten';
export * from './srs';
export * from './tenhou-url';
export * from './tiles';
