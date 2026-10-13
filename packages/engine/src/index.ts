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
 * - 解き直しの予定: `scheduleReview`（E-5。答えを選び直した問題は間隔を進めない）・`scheduleFirstReview`（出題で答えたら 1 日後。E-25）・
 *   `studyDate`（出題・解き直しの「今日」。午前 4 時まで前の日）、牌譜リンク: `parsePaipuLink`（E-9）、MAKA の打牌: `recordMakaMove`（E-14）
 * - 場面の向聴数: `sceneShanten`（E-21。打牌の判断はツモったあとの手から切る牌ごとの最小、鳴きの判断は鳴く前の手）
 * - 受け入れの残り: `discardDetails`（E-22。受け入れ牌ごとに、手牌だけの枚数と、場に見えている牌も除いた残り）、
 *   2向聴からの先: `followAfterTwoShanten`（E-23）
 * - 出題: 問題の一覧 `listProblems`・今日の出題の組 `buildDailySet`・「残り」`restOfProblems`・解き直しの期限 `dueAnswers`（E-24・E-25）、
 *   答えのボタンと AI の候補への当てはめ `answerOptions` / `choiceProbability`（打牌以外の答えは、雀魂と同じ並びのボタン）
 * - 半荘を通して見る画面（F12）: 時間軸 `buildReplayTimeline`（局ごとの手の列。手のあとの盤面は `replayFrames` の盤面そのもの。
 *   自分の判断は、ちょうど 1 つの手に属する。局の結果 `kyokuEndOf`。行き先は `nextTurnStep` / `prevTurnStep` / `nextKyokuStep` /
 *   `prevKyokuStep` / `decisionSteps` と `nextStepIn` / `prevStepIn`）、場面 `listReplayScenes`（迷いと不一致。E-26 の
 *   `replayMismatches` は、既定は確率が基準未満、設定を入れると AI の1位と違う判断すべて）
 * - クリップボードの牌譜リンク（E-15）: `detectPaipuLink(text)` は `PaipuLink | null`。同じ牌譜 ID を一度だけ知らせるのは
 *   `detectNewPaipuLink(text, announced)`（純粋な関数）か `new PaipuLinkAnnouncer(ids).announce(text)`
 *
 * - 待ちと打点・待ちの形・符の内訳（F14、E-36〜E-38。答え合わせのタブ「待ちと打点」）: `waitBoxOf`（聴牌になる行動ごとに、待ち牌ごとの役・飜・符・点数を
 *   ダマ・リーチ × ロン・ツモで。待ちの形は両面・嵌張・辺張・双碰・単騎、3 種類以上は多面張）。点数の計算は majiang-core（受け口は majiang-adapter.ts。
 *   エンジンで majiang-core を読み込むのはそのファイルだけ）、符の内訳 `fuBreakdownOf` は Python の mahjong の `fu_details` の数え方（fu-detail.ts）
 * - 守備の目安（F14、E-39。答え合わせのタブ「守備」）: `dangerBoxOf`（他家のリーチがある場面で、切れる牌ごとに、リーチした人ごと
 *   現物・スジ・壁・字牌・無スジの 1 語と補足。形式的な分類で、AI の確率ではない）。他家 1 人 × 牌 1 種類の分類は `classifyAgainst`
 *   （他家の種類ごとに数え方を持つ。いまはリーチだけ）。現物は盤面の `riichiOrder`・`passedAfterRiichi`（replay.ts）から。
 *   副露した他家（R16-6 の B）には、牌ごとの分類を出さず、気配の 1 行だけ（`openSignLinesOf`。open-sign.ts: 副露が 2 つ以上、または染め手の気配の人。
 *   暗槓は副露の数に入らず、リーチの人は対象にしない）。リーチの人がいなくても、この 1 行の人がいれば、`dangerBoxOf` は中身を返す（`signs`）
 * - 他家の手牌（F14、E-40。盤面の他家の手牌を押して開く。R16-7）: `openHandsAt`（局と牌譜の位置を渡すと、他家 3 人の閉じた手牌・副露・リーチと、
 *   聴牌している人の待ち（待ちの形・全員の手牌を開いたときの残り・その人が実際に付けている立直かダマで数えたロンの点）。盤面 `BoardState` には他家の手牌を入れない
 *   （席ごとの枚数 `handCounts` と、ツモ牌の有無 `handDrawn` だけ）。卓の全部は `tableAt`（replay.ts の `TableView`。和了の状況も持つ）
 * - 他家が聴牌した巡目（F14、E-43。R16-7 の A）: `opponentTracksOf`（局を牌譜で追い、他家 3 人ごとに、切るたびの向聴数（E-21 と同じ数え方）、
 *   聴牌になった打牌（聴牌の区間ごとに最初の 1 つ）、そこに至った経路（ツモ・チー・ポン・カン）、待ち）
 * - 局の結果の手（F14、E-40。局の評価の表の行を開いたとき）: `kyokuResultOf`（牌譜から和了者の手牌・和了牌・和了の状況を組み立てて majiang-core で役・飜・符・点数を計算し直す。
 *   他家のツモ・ロンも、ダブロンも。計算し直した点の増減は牌譜と一致する。放銃した局は相手の手牌と待ち。流局は 4 人の手牌（荒牌平局は聴牌・ノーテン））
 * - 役の調査（R10-6・R12-14。画面には使わない試作）: `evaluateWin`（和了形の役・符。HandCalculator と同じ選び方）、`settledYaku`（聴牌の手の「確定している役」）、
 *   `nearYaku`（役ごとに、あと何枚引けばその役の付く和了形になるか）。analysis/yaku/README.md
 *
 * 取り込みのあとの結びつけ（F9〜F11。スクショの中央から読んだ局・残りの牌の数・点数を使う）。
 * スクショ 1 枚の読み取りは `ScreenReading` で渡す（`center`＝読み取り済み、`lines`＝文字認識の行、`retries`＝1回目で読めないときに
 * 順に試す読み直しの行。どれも無ければ読めない扱い）:
 * - `parseCenterText(lines)`（E-16）: 文字認識の行 → `{ wind: 'E' | 'S' | 'W', number: 1〜4, tilesLeft, score } | null`（読めなければ null）。
 *   `firstReadable(lines, retries)`（E-20）は、1回目の行と読み直しの行のうち、最初に読めたものから取る（`readingOf` も同じ）
 * - `linkMarks(report, marks)`（E-17）: 迷いマーク → 判断。結果は渡した順の `MarkLink`（`status` は estimated＝読めた・
 *   manual＝手で選ぶ）。局は点数との照合で決め（`kyokuFactsOf` / `locateKyokus`）、その局の判断に順位を付ける
 *   （点 `markScore` = 残りの牌の数の差 + スルー 1.5 / 和了 3 + 読んだあとの判断 0.25。小さいほど上）。1位が推定（`estimate`）、
 *   1位との点の差が 0.75 以下の判断が、ほかの候補（`alternatives`。最大 4 つ）。判断の呼び名と保存用の鍵は `DecisionRef`
 *   （`listDecisionRefs` / `findDecisionRef` / `decisionKey`。「手で選ぶ」の一覧にも使う）
 * - `isFarFromReading(report, link, chosenKey)`（E-27）: ユーザーが選んだ判断（`links.json` の値）が、`linkMarks` の結果の推定にも
 *   ほかの候補にも入らず、読んだ局と違う局か、読んだ残りの牌の数との差が推定より大きいとき true（スクショの値から「離れている」）。
 *   推定が無い迷い（読めない・合う局が無い）は false
 * - `parsePartialCenterText(lines)` / `partialReadingOf(input)`（E-28）: 局の名前（風・番号）や残りの牌の数が崩れていても、点数の行が読めれば、
 *   読めた部分だけを返す（`PartialCenterText`。読めなかった部分は null）。`partialReadingOf` は、1回目と読み直しのうち、読めた部分の
 *   いちばん多いものを使う。すべて読めるものは `parseCenterText` / `readingOf` と同じ結果。読めた部分に合う局は
 *   `locatePartialKyokus`（読めた風・番号は局の名前と同じ、点数は局の始めの点数。リーチ棒の分は引く）
 * - `linkTimeline(report, { marks, ratings })`（E-29・E-30）: 迷いと評価を押した時刻の順に 1 本に並べて、局に当てはめる。評価のあとに押した
 *   ものは、その評価の局より後の局、迷いのあとに押したものは、その迷いの局か後の局。評価は当てはめないこともできる（同じ局に 2 つ当たるなら、
 *   あとに押したほうを残す）。読み取り（崩れた部分も）とユーザーが選んだ結びつけ（`marks` の `chosen`）に、できるだけ合わせる
 *   （費用は `CHOSEN_COST`・`FULL_READING_COST`・`PARTIAL_READING_COST`・`UNPLACED_RATING_COST`）。迷いの結果 `TimelineMarkLink` は、
 *   `MarkLink` に、当てはめた局 `kyokuPosition`・局の幅 `range`・どう決めたか `how`・前後の出来事を足したもの。残り枚数が読めた迷いは、
 *   局の幅の中で E-17 と同じ順位を付け（estimated）、読めない迷い・局だけ分かった迷いは、局の幅の中の判断をすべて選ぶ候補にする
 *   （`status` が kyoku。`choices`）。評価の結果は `linkRatings` と同じ形。当てはめ方を変えたら `RATING_LINK_VERSION` を上げる
 * - `linkRatings(report, ratings, marks?)`（E-29）: 局の評価（〇△✕）→ 局。`linkTimeline` のうち評価だけを返す入口。
 *   戻り値は `alignRatings`（E-7）と同じ形（status・assigned・extra・missingHands・message）に、評価ごとの当てはめ方 `placements` を足したもの。
 *   局の始め（残り `HAND_START_TILES_LEFT` 枚以上）に読めたら前の局
 * - `matchSessionForReport(report, sessions)`（E-19）: 結果を結びつける半荘。sessions は結果がまだ無い半荘
 *   （`id`・`started_ms`・スクショの読み取り `marks`）。合うものがちょうど1つなら `match`、合うものが無いか2つ以上なら
 *   `choose`（`sessionIds` は新しい順）、結果の無い半荘が無ければ `new`
 *   結びつけ先が決まっているとき（取り込み前の半荘のページから、その半荘に取り込むとき。U-14）は、`checkShotsAgainstReport(report, marks)`
 *   で、読めたスクショのうち結果と合わないもの（`mismatches`）を調べる
 * - `summarizeHanchan(report, { gradeModel?, marks? })`: 半荘の一覧と局の表に出すまとめ（卓・Rating・段階・局ごとの結果と
 *   点の増減・Rating・段階・迷いマークの結びつけ）。段階の当てはめの既定は `DEFAULT_GRADE_MODEL`
 *   （analysis/maka-fit/dataset.csv を `fitGradeModel` で当てはめた定数）
 * - `fitMaka(users, sessions)`（F10、U-31）: 基礎の 67 局（`MAKA_BASE_RECORDS`。dataset.csv から作った定数）に、利用者が入れた MAKA の評価を
 *   足して当てはめ直し、見込み（半荘を 1 つずつ外した「ぴったり」「±1段階以内」。`percentOf` で %）を返す。基礎の記録と同じ局の評価は、
 *   その記録を置き換える。取り込んだ半荘が基礎のどの半荘かは、局の名前と点数が全部同じかで決める（`matchBaseGame`）。
 *   `baseMakaFit()` は基礎だけの当てはめ。当てはめ直した段階をまとめに反映するのは `regradeSummary(summary, model)`
 * - `disagreesWithGrade(mark, grade)`（F10）: 局の自己評価（〇△✕）と AI 基準の段階が大きく食い違うか（局の表の印）。
 *   帯（〇 = S+〜S-、△ = A+〜A-、✕ = B+〜E。R13-3）が 2 つ離れたら印。直すのはこの 1 つの関数のファイルだけ。
 *   週の集計（U-30）の「一致」（`agreesWithGrade`）と「ずれ」（`markOffsetFromGrade`。自分 - AI 基準、-2 から 2）も、同じ帯で決める
 */
export const ENGINE_PACKAGE = '@jantama/engine' as const;

export * from './actions';
export * from './center-text';
export * from './danger';
export * from './decision';
export * from './decision-ref';
export * from './default-grade-model';
export * from './disagreement';
export * from './discard-compare';
export * from './fu-detail';
export * from './grade';
export * from './hanchan-summary';
export * from './hand-rating';
export * from './import';
export * from './isotonic';
export * from './kyoku';
export * from './kyoku-locate';
export * from './kyoku-result';
export * from './maka';
export * from './maka-fit';
export * from './maka-fit-base';
export * from './mark-link';
export * from './open-hands';
export * from './open-sign';
export * from './opponent-track';
export * from './outcome';
export * from './paipu-link';
export * from './problems';
export * from './quiz-choice';
export * from './rating';
export * from './rating-alignment';
export * from './rating-link';
export * from './replay';
export * from './replay-scenes';
export * from './replay-timeline';
export * from './report';
export * from './report-types';
export * from './result';
export * from './scene-shanten';
export * from './session-match';
export * from './shanten';
export * from './srs';
export * from './tenhou-url';
export * from './timeline-link';
export * from './tiles';
export * from './two-shanten-follow';
export * from './ukeire-remaining';
export * from './wait-value';
export * from './yaku';
export * from './yaku-near';
export * from './yaku-view';
