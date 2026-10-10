/**
 * 検討結果の取り込みの進め方（F1・F9・F11）。画面にも Tauri にも依存しない部分と、Rust 側のコマンドを呼ぶ部分（`ImportDeps`）を
 * 分けてあり、`ImportDeps` を差し替えて単体で試験できる。
 *
 * 流れ（結果の JSON を受け取ってから）:
 * 1. 検査: エンジンの `importReportText` で、牌譜を再生して、検討結果と合うか確かめる（合わなければ、理由を出して止める）
 * 2. 読み取り: 結果が無い半荘（新しい順、直近 7 日）の迷いマーク・評価のスクショを、Rust 側で文字認識にかける（対局後だけ。SPEC 2章）
 * 3. 当てはめ: `matchSessionForReport` で、結果を結びつける半荘を決める
 *    （1 つに決まる＝そのまま／決まらない＝一覧から選んでもらう／結果の無い半荘が無い＝記録の無い半荘として取り込む）
 * 4. 保存: 結果を半荘のフォルダに保存し、迷いマーク・評価の結びつけ（`linkMarks`・`linkRatings`）を書く
 * 5. まとめ: `summarizeHanchan` で、Rating・段階・結びつけた迷いマークの数・選んでほしい数を出す
 */
import {
  importReportText,
  linkRatings,
  listDisagreements,
  matchSessionForReport,
  summarizeHanchan,
  type ImportedGame,
  type MarkLink,
  type RatingLinking,
  type ScreenReading,
  type SessionCandidate,
  type SessionMatch,
} from '@jantama/engine';

import type { Links, OcrCache, Rating, SessionOcr, SessionRecord } from '../api/types';

/** 結果を結びつける半荘の候補にする、記録した半荘の新しさ。これより古い半荘は、候補に入れない（読み取りの手間を減らす）。 */
export const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 局の鍵（局の通し番号と本場）。判断の鍵 `k1h1e7` の、局の部分（`k1h1`）と同じ作り方。評価の結びつけに保存する。 */
export function kyokuKey(kyoku: number, honba: number): string {
  return `k${kyoku}h${honba}`;
}

/** 取り込みの途中経過（画面に出す言葉は、画面側が決める）。 */
export type ImportStep = 'fetching' | 'checking' | 'reading' | 'saving';

/** 取り込めなかった理由。`title` は短い見出し、`message` は詳しい理由（局・巡目などを含む）。 */
export interface ImportFailure {
  title: string;
  message: string;
}

/** Rust 側のコマンドのうち、取り込みが使うもの（試験で差し替える）。 */
export interface ImportDeps {
  listSessions(): Promise<SessionRecord[]>;
  ocrSessions(sessionIds: string[]): Promise<SessionOcr[]>;
  saveReport(sessionId: string | null, text: string): Promise<string>;
  replaceLinks(sessionId: string, links: Links): Promise<void>;
  now(): number;
}

/** 迷いマーク 1 件と、そのスクショの文字認識の行（読めなければ `lines` が無い）。 */
export interface MarkReading extends ScreenReading {
  id: number;
  t_ms: number;
}

/** 評価 1 件と、そのスクショの文字認識の行。 */
export interface RatingReading extends ScreenReading {
  id: number;
  t_ms: number;
  rating: Rating;
}

/** 写しの中の、画像 1 枚の行。写しが無い・その画像が無い・読めなかった（理由つき）ときは `undefined`（読めない扱い）。 */
function linesOf(ocr: OcrCache | null | undefined, relative: string | null | undefined): string[] | undefined {
  if (!ocr || !relative) return undefined;
  const entry = ocr.entries[relative];
  return entry && !entry.error ? entry.lines : undefined;
}

/** 半荘の迷いマークと、そのスクショの読み取り（記録の順）。 */
export function markReadings(session: Pick<SessionRecord, 'marks'>, ocr: OcrCache | null | undefined): MarkReading[] {
  return session.marks.map((mark) => ({
    id: mark.id,
    t_ms: mark.t_ms,
    lines: linesOf(ocr, mark.screenshot),
  }));
}

/** 半荘の評価と、そのスクショの読み取り（押した順）。 */
export function ratingReadings(session: Pick<SessionRecord, 'ratings'>, ocr: OcrCache | null | undefined): RatingReading[] {
  return session.ratings.map((rating) => ({
    id: rating.id,
    t_ms: rating.t_ms,
    rating: rating.rating,
    lines: linesOf(ocr, rating.screenshot),
  }));
}

/**
 * 結果の結びつけ先の候補: 結果がまだ無い半荘のうち、直近 7 日のもの（新しい順）。
 * 結果だけの半荘（記録の無いまま取り込んだもの）は、結果があるので入らない。
 */
export function candidateSessions(sessions: readonly SessionRecord[], now: number): SessionRecord[] {
  return sessions
    .filter((s) => s.report_path === null && now - s.started_ms <= CANDIDATE_WINDOW_MS)
    .sort((a, b) => b.started_ms - a.started_ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** `matchSessionForReport` に渡す形にする。迷いマークも評価も、スクショは局と点数を読む手がかり。 */
export function toSessionCandidate(session: SessionRecord, ocr: OcrCache | null | undefined): SessionCandidate {
  return {
    id: session.id,
    started_ms: session.started_ms,
    marks: [...markReadings(session, ocr), ...ratingReadings(session, ocr)].map((r) => ({ lines: r.lines })),
  };
}

/**
 * 自動で決めた結びつけを、保存する形にする。
 * - 迷いマーク: 判断が 1 つに決まったものだけ、その判断の鍵を保存する。候補が複数のものと、手で選ぶものは、
 *   保存しない（「まだ決めていない」のまま。画面で、選んでもらう）
 * - 評価: 当てはめた局の鍵。どの局にも当てはめられなかった評価は、空の文字列（「どの局にも結びつけない」）
 */
export function buildLinks(
  report: ImportedGame['report'],
  marks: readonly MarkLink<MarkReading>[],
  ratings: RatingLinking<RatingReading> | null,
): Links {
  const links: Links = { marks: {}, ratings: {} };
  for (const link of marks) {
    const only = link.status === 'linked' ? link.candidates[0] : undefined;
    if (only) links.marks[String(link.mark.id)] = only.key;
  }
  for (const placement of ratings?.placements ?? []) {
    const kyoku = placement.position === null ? undefined : report.review.kyokus[placement.position];
    links.ratings[String(placement.rating.id)] = kyoku ? kyokuKey(kyoku.kyoku, kyoku.honba) : '';
  }
  return links;
}

/** 取り込んだあとに出すまとめ。 */
export interface ImportSummary {
  /** 保存した半荘の名前。 */
  sessionId: string;
  /** 半荘の開始の時刻。記録した半荘は最初の記録の時刻、記録の無い半荘として作ったときは取り込んだ時刻。 */
  startedMs: number;
  /** 記録した半荘に結びつけたか。false なら、記録の無い半荘として新しく作った。 */
  linkedToRecording: boolean;
  /** 卓の呼び名（例: 玉の間・南）。 */
  room: string | null;
  /** 半荘全体の Rating（例: 93.0）。 */
  ratingText: string | null;
  /** 半荘全体の段階（例: S-）。 */
  grade: string | null;
  decisionCount: number;
  /** 大きな不一致（Mortal が実戦の行動に付けた確率が 5% 未満の判断）の数。 */
  disagreementCount: number;
  /** 結びつけ先の半荘の迷いマークの数。 */
  markCount: number;
  /** そのうち、判断に結びつけた数。 */
  linkedMarks: number;
  /** そのうち、選んでほしい数（候補が複数・読み取れない・合う局が無い）。 */
  choiceMarks: number;
  /** 局の評価の数と、局に当てはめた数。 */
  ratingCount: number;
  placedRatings: number;
  /** 文字認識が使えなかった・結びつけを保存できなかったときの、知らせたいこと。 */
  warnings: string[];
}

/** 取り込みの準備の結果。 */
export interface ImportContext {
  /** 結果の生の JSON。 */
  text: string;
  game: ImportedGame;
  /** 結びつけ先の候補（結果が無い・直近 7 日の半荘。新しい順）。 */
  sessions: SessionRecord[];
  /** 半荘ごとの、文字認識の結果の写し。 */
  ocr: Map<string, OcrCache>;
  /** 文字認識が使えなかったときの理由。 */
  ocrWarning: string | null;
  match: SessionMatch;
}

export type PrepareResult = { ok: true; context: ImportContext } | { ok: false; failure: ImportFailure };

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 結果の JSON を検査して出た失敗を、見出しと理由にする。 */
function failureOf(error: { code: string; message: string }): ImportFailure {
  if (error.code !== 'parse') {
    // 再生して合わなかった。理由は、局と巡目を含む文（例: 東1局 4巡目: 手牌が記録と一致しません…）。
    return { title: '牌譜と検討結果が合いません', message: error.message };
  }
  const title = '結果の JSON を読めませんでした';
  // エンジンの理由は、見出しと同じ文で始まる。見出しと重ならないよう、あとの詳しい部分だけを括弧に入れる。
  const detail = error.message.startsWith(`${title}: `) ? error.message.slice(title.length + 2) : error.message;
  return {
    title,
    message: `mjai の検討結果として読めませんでした。別のページやファイルを選んだか、サイトの作りが変わった可能性があります。（${detail}）`,
  };
}

/**
 * 結果の JSON を検査して、結びつけ先を決めるところまで進める（保存はしない）。
 * `onStep` は、段階が変わるたびに呼ぶ。
 */
export async function prepareImport(
  deps: ImportDeps,
  text: string,
  onStep: (step: ImportStep) => void = () => undefined,
): Promise<PrepareResult> {
  onStep('checking');
  const imported = importReportText(text);
  if (!imported.ok) {
    return { ok: false, failure: failureOf(imported.error) };
  }

  let all: SessionRecord[];
  try {
    all = await deps.listSessions();
  } catch (error) {
    return {
      ok: false,
      failure: { title: '半荘の一覧を読めませんでした', message: messageOf(error) },
    };
  }
  const sessions = candidateSessions(all, deps.now());

  // 読み取りは、候補の半荘のスクショだけ（対局後の、取り込みのときだけ）。使えなくても、取り込み自体は続ける。
  const ocr = new Map<string, OcrCache>();
  let ocrWarning: string | null = null;
  if (sessions.length > 0) {
    onStep('reading');
    try {
      for (const result of await deps.ocrSessions(sessions.map((s) => s.id))) {
        ocr.set(result.session_id, result.ocr);
      }
    } catch (error) {
      ocrWarning = messageOf(error);
    }
  }

  const cacheOf = (session: SessionRecord) => ocr.get(session.id) ?? session.ocr;
  const match = matchSessionForReport(
    imported.value.report,
    sessions.map((session) => toSessionCandidate(session, cacheOf(session))),
  );
  return { ok: true, context: { text, game: imported.value, sessions, ocr, ocrWarning, match } };
}

/**
 * 結果を保存して、迷いマーク・評価の結びつけを書き、まとめを返す。
 * `sessionId` が null なら、記録の無い半荘として新しく作る。
 * 結果の保存に失敗したときは例外を投げる。結びつけの保存だけ失敗したときは、結果は保存済みなので、まとめに知らせを添えて返す。
 */
export async function completeImport(
  deps: ImportDeps,
  context: ImportContext,
  sessionId: string | null,
): Promise<ImportSummary> {
  const session = sessionId === null ? null : (context.sessions.find((s) => s.id === sessionId) ?? null);
  if (sessionId !== null && session === null) {
    throw new Error('選んだ半荘が、結びつけ先の一覧にありません。もう一度やり直してください。');
  }
  const savedId = await deps.saveReport(sessionId, context.text);

  const report = context.game.report;
  const cache = session ? (context.ocr.get(session.id) ?? session.ocr) : null;
  const marks = session ? markReadings(session, cache) : [];
  const hanchan = summarizeHanchan(report, { marks });
  const ratings = session ? ratingReadings(session, cache) : [];
  const ratingLinking = session && ratings.length > 0 ? linkRatings(report, ratings) : null;

  const warnings: string[] = [];
  if (context.ocrWarning !== null) {
    warnings.push(
      `画面の文字認識が使えなかったので、迷いマークと評価は読み取れていません（${context.ocrWarning}）`,
    );
  }
  if (session) {
    const links = buildLinks(report, hanchan.marks, ratingLinking);
    if (Object.keys(links.marks).length > 0 || Object.keys(links.ratings).length > 0) {
      try {
        await deps.replaceLinks(savedId, links);
      } catch (error) {
        warnings.push(`結果は保存しましたが、結びつけを保存できませんでした（${messageOf(error)}）`);
      }
    }
  }

  const linked = hanchan.marks.filter((m) => m.status === 'linked').length;
  return {
    sessionId: savedId,
    startedMs: session ? session.started_ms : deps.now(),
    linkedToRecording: session !== null,
    room: hanchan.room,
    ratingText: hanchan.ratingText,
    grade: hanchan.grade,
    decisionCount: hanchan.decisionCount,
    disagreementCount: listDisagreements(context.game.decisions).total,
    markCount: hanchan.marks.length,
    linkedMarks: linked,
    choiceMarks: hanchan.marks.length - linked,
    ratingCount: ratings.length,
    placedRatings: ratingLinking ? ratingLinking.placements.filter((p) => p.position !== null).length : 0,
    warnings,
  };
}

/** 牌譜 ID（`261009-<uuid>`）の先頭の日付（年は下 2 桁、月、日）を、「10月9日」の形にする。読めなければ null。 */
export function paipuDateText(paipuId: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})-/.exec(paipuId);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${month}月${day}日`;
}

/** 長い文字列を、前の 18 字・後ろの 4 字を残して、真ん中を「…」で省く（牌譜リンクの表示用）。 */
export function shortenMiddle(text: string, head = 18, tail = 4): string {
  const chars = Array.from(text);
  if (chars.length <= head + tail + 1) return text;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}
