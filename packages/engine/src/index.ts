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
 * - クリップボードの牌譜リンク（E-15）: `detectPaipuLink(text)` は `PaipuLink | null`。同じ牌譜 ID を一度だけ知らせるのは
 *   `detectNewPaipuLink(text, announced)`（純粋な関数）か `new PaipuLinkAnnouncer(ids).announce(text)`
 *
 * 取り込みのあとの結びつけ（F9〜F11。スクショの中央から読んだ局・残りの牌の数・点数を使う）。
 * スクショ 1 枚の読み取りは `ScreenReading` で渡す（`center`＝読み取り済み、`lines`＝文字認識の行。どちらも無ければ読めない扱い）:
 * - `parseCenterText(lines)`（E-16）: 文字認識の行 → `{ wind: 'E' | 'S' | 'W', number: 1〜4, tilesLeft, score } | null`（読めなければ null）
 * - `linkMarks(report, marks)`（E-17）: 迷いマーク → 判断。結果は渡した順の `MarkLink`（`status` は linked＝1つに決まった・
 *   candidates＝候補が複数・manual＝手で選ぶ）。局は点数との照合で決め（`kyokuFactsOf` / `locateKyokus`）、判断は残りの牌の数が
 *   いちばん近いもの（同じ差は候補すべて）。判断の呼び名と保存用の鍵は `DecisionRef`
 *   （`listDecisionRefs` / `findDecisionRef` / `decisionKey`。「手で選ぶ」の一覧にも使う）
 * - `linkRatings(report, ratings)`（E-18）: 局の評価（〇△✕）→ 局。評価は `t_ms` と読み取りを持つ記録。局の始め
 *   （残り `HAND_START_TILES_LEFT` 枚以上）に読めたら前の局、途中なら読んだ局、読めないものは前後の間へ押した順。
 *   戻り値は `alignRatings`（E-7）と同じ形（status・assigned・extra・missingHands・message）に、評価ごとの当てはめ方 `placements` を足したもの
 * - `matchSessionForReport(report, sessions)`（E-19）: 結果を結びつける半荘。sessions は結果がまだ無い半荘
 *   （`id`・`started_ms`・スクショの読み取り `marks`）。合うものがちょうど1つなら `match`、合うものが無いか2つ以上なら
 *   `choose`（`sessionIds` は新しい順）、結果の無い半荘が無ければ `new`
 * - `summarizeHanchan(report, { gradeModel?, marks? })`: 半荘の一覧と局の表に出すまとめ（卓・Rating・段階・局ごとの結果と
 *   点の増減・Rating・段階・迷いマークの結びつけ）。段階の当てはめの既定は `DEFAULT_GRADE_MODEL`
 *   （analysis/maka-fit/dataset.csv を `fitGradeModel` で当てはめた定数）
 * - `disagreesWithGrade(mark, grade)`（F10）: 局の自己評価（〇△✕）と AI 基準の段階が大きく食い違うか（局の表の印）。
 *   帯（〇 = S+〜A-、△ = B+〜B-、✕ = C+〜E）が 2 つ離れたら印。暫定の規則で、直すのはこの 1 つの関数のファイルだけ
 */
export const ENGINE_PACKAGE = '@jantama/engine' as const;

export * from './actions';
export * from './center-text';
export * from './decision';
export * from './decision-ref';
export * from './default-grade-model';
export * from './disagreement';
export * from './discard-compare';
export * from './grade';
export * from './hanchan-summary';
export * from './hand-rating';
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
