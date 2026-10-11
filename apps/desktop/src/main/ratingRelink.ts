/**
 * 評価の当てはめ直し（E-31、F11）。画面にも Tauri にも依存しない（保存の窓口 `RelinkApi` を渡す。試験では偽物を渡せる）。
 *
 * links.json の評価の結びつけ（`ratings`）は、取り込みのときに、そのときの当てはめ方で作って保存する。当てはめ方を変えたあと
 * （迷いと評価を押した時刻の順に並べて当てはめるようにしたあと。E-29）、前の当てはめ方で作った結びつけ（当てはめ方の版 `ratings_version` が
 * 無いか、いまの版 `RATING_LINK_VERSION` より小さい）は、半荘の画面を開いたときに、1 回だけ当てはめ直して保存する。
 *
 * - 当てはめには、利用者が保存した迷いの結びつけ（`links.marks`）を手がかりに使う。読み取りの写し（`ocr.json`）は、
 *   読み直しが済んだあとの最新のものを使う（`RereadStore` が、読み直しのあとに呼ぶ）
 * - 書き換わるのは、評価の結びつけと版だけ。迷いの結びつけ（`links.marks`）と、表で付け直した〇△✕（`self-ratings.json`）には触らない
 *   （Rust 側の `replace_rating_links` が、評価と版だけを置き換える）
 * - 当てはめ直したら、版を書くので、次に開いたときは当てはめ直さない（評価の局を、利用者が表で付け直したものは、いつも自己評価が先）
 */
import { RATING_LINK_VERSION, linkTimeline, parseReportText } from '@jantama/engine';

import type { SessionRecord } from '../api/types';
import { markReadings, ratingReadings, ratingLinkValues } from './importFlow';

/** 当てはめ直しが使う、保存の窓口（`api` の、この処理が使う部分）。 */
export interface RelinkApi {
  /** 半荘の記録の一覧。読み直しのあとの、最新の読み取りの写しと結びつけを含む。 */
  listSessions(): Promise<SessionRecord[]>;
  /** 取り込んだ結果の生の JSON。 */
  readReport(sessionId: string): Promise<string | null>;
  /** 評価の結びつけと版だけを置き換える。 */
  replaceRatingLinks(sessionId: string, ratings: Record<string, string>, version: number): Promise<void>;
}

/**
 * 評価の当てはめを、当てはめ直す必要があるか。結果を取り込んであり、評価があり、当てはめ方の版が無いか、いまの版より小さいとき。
 * 評価が無い半荘は、当てはめるものが無いので、要らない。
 */
export function needsRatingRelink(session: Pick<SessionRecord, 'report_path' | 'ratings' | 'links'>): boolean {
  return session.report_path !== null && session.ratings.length > 0 && (session.links.ratings_version ?? 0) < RATING_LINK_VERSION;
}

/**
 * 半荘の評価の当てはめを、必要なら当てはめ直して保存する。当てはめ直して保存したら true、要らなかった（版が新しい・評価が無い・取り込み前・
 * 結果を読めない）ときは false。保存に失敗したら投げる（版を書けていないので、次の起動で、もう一度試せる）。
 */
export async function relinkRatings(api: RelinkApi, sessionId: string): Promise<boolean> {
  const session = (await api.listSessions()).find((candidate) => candidate.id === sessionId);
  if (session === undefined || !needsRatingRelink(session)) return false;
  const text = await api.readReport(sessionId);
  if (typeof text !== 'string' || text === '') return false;
  const parsed = parseReportText(text);
  if (!parsed.ok) return false;
  const timeline = linkTimeline(parsed.value, {
    marks: markReadings(session, session.ocr),
    ratings: ratingReadings(session, session.ocr),
  });
  await api.replaceRatingLinks(sessionId, ratingLinkValues(parsed.value, timeline.ratings), RATING_LINK_VERSION);
  return true;
}
