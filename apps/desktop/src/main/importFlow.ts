/**
 * 検討結果の取り込みの進め方（F1・F9・F11）。画面にも Tauri にも依存しない部分と、Rust 側のコマンドを呼ぶ部分（`ImportDeps`）を
 * 分けてあり、`ImportDeps` を差し替えて単体で試験できる。
 *
 * 流れ（結果の JSON を受け取ってから）:
 * 1. 検査: エンジンの `importReportText` で、牌譜を再生して、検討結果と合うか確かめる（合わなければ、理由を出して止める）
 * 2. 読み取り: 結果が無い半荘（新しい順、直近 7 日）の迷いマーク・評価のスクショを、Rust 側で文字認識にかける（対局後だけ。SPEC 2章）
 * 3. 当てはめ: `matchSessionForReport` で、結果を結びつける半荘を決める
 *    （1 つに決まる＝そのまま／決まらない＝一覧から選んでもらう／結果の無い半荘が無い＝記録の無い半荘として取り込む）
 *    取り込み前の半荘のページから、その半荘に取り込むとき（`PrepareOptions.target`。U-14）は、この当てはめをせず、その半荘だけを読み取って、
 *    読めたスクショが結果と合うかを調べる（`checkShotsAgainstReport`）。合わないものがあれば、保存の前に利用者に聞く
 * 4. 保存: 結果を半荘のフォルダに保存し、評価の結びつけ（`linkRatings`）を書く。
 *    迷いマークの結びつけ（`linkMarks`）は、保存しない（推定は、読み取りの写しと結果から、いつでも同じに出せる。
 *    保存するのは、利用者が選んだものだけ。選んだものには「推定」の印が付かないため）
 * 5. まとめ: `summarizeHanchan` で、Rating・段階・推定で結びつけた迷いマークの数・手で選んでほしい数を出す
 */
import {
  checkShotsAgainstReport,
  importReportText,
  linkRatings,
  listDisagreements,
  matchSessionForReport,
  summarizeHanchan,
  type ImportedGame,
  type RatingLinking,
  type ScreenReading,
  type SessionCandidate,
  type SessionMatch,
} from '@jantama/engine';

import type { Links, OcrCache, Rating, SessionOcr, SessionRecord } from '../api/types';
import { centerText } from './format';

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

/**
 * 写しの中の、画像 1 枚の読み取り（1 回目の行と、読み直しの行）。写しが無い・その画像が無い・読めなかった（理由つき）ときは、
 * どちらも無い（読めない扱い）。
 */
function shotOf(
  ocr: OcrCache | null | undefined,
  relative: string | null | undefined,
): Pick<ScreenReading, 'lines' | 'retries'> {
  if (!ocr || !relative) return {};
  const entry = ocr.entries[relative];
  if (!entry || entry.error) return {};
  return entry.retries && entry.retries.length > 0
    ? { lines: entry.lines, retries: entry.retries.map((retry) => retry.lines) }
    : { lines: entry.lines };
}

/** 半荘の迷いマークと、そのスクショの読み取り（記録の順）。 */
export function markReadings(session: Pick<SessionRecord, 'marks'>, ocr: OcrCache | null | undefined): MarkReading[] {
  return session.marks.map((mark) => ({
    id: mark.id,
    t_ms: mark.t_ms,
    ...shotOf(ocr, mark.screenshot),
  }));
}

/** 半荘の評価と、そのスクショの読み取り（押した順）。 */
export function ratingReadings(session: Pick<SessionRecord, 'ratings'>, ocr: OcrCache | null | undefined): RatingReading[] {
  return session.ratings.map((rating) => ({
    id: rating.id,
    t_ms: rating.t_ms,
    rating: rating.rating,
    ...shotOf(ocr, rating.screenshot),
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
    marks: [...markReadings(session, ocr), ...ratingReadings(session, ocr)].map((r) => ({
      lines: r.lines,
      retries: r.retries,
    })),
  };
}

/**
 * 自動で決めた結びつけを、保存する形にする。
 * - 迷いマーク: 保存しない。1 位の推定は、読み取りの写しと結果から、いつでも同じに出せる。保存するのは、利用者が選んだものだけ
 *   （保存してあるものには、「推定」の印が付かない）
 * - 評価: 当てはめた局の鍵。どの局にも当てはめられなかった評価は、空の文字列（「どの局にも結びつけない」）
 */
export function buildLinks(report: ImportedGame['report'], ratings: RatingLinking<RatingReading> | null): Links {
  const links: Links = { marks: {}, ratings: {} };
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
  /** そのうち、読めて、1 位の判断を推定として結びつけた数。 */
  estimatedMarks: number;
  /** そのうち、手で選んでほしい数（読み取れない・合う局が無い・その局に判断が無い）。 */
  manualMarks: number;
  /** 局の評価の数と、局に当てはめた数。 */
  ratingCount: number;
  placedRatings: number;
  /** 文字認識が使えなかった・結びつけを保存できなかったときの、知らせたいこと。 */
  warnings: string[];
}

/**
 * 結びつけ先の半荘が決まっているとき（`PrepareOptions.target`。U-14）の、スクショと結果の照合。
 * `mismatches` が、読めて、結果と合わなかったスクショ（迷い・評価の呼び名と、読んだ内容）。
 */
export interface TargetCheck {
  /** 結びつけ先の半荘の名前。 */
  sessionId: string;
  /** 読めたスクショの数と、そのうち結果と合ったものの数。 */
  readable: number;
  fitting: number;
  mismatches: Array<{ label: string; reading: string }>;
}

/** 取り込みの準備の結果。 */
export interface ImportContext {
  /** 結果の生の JSON。 */
  text: string;
  game: ImportedGame;
  /** 結びつけ先の候補（結果が無い・直近 7 日の半荘。新しい順）。結びつけ先が決まっているときは、その半荘だけ。 */
  sessions: SessionRecord[];
  /** 半荘ごとの、文字認識の結果の写し。 */
  ocr: Map<string, OcrCache>;
  /** 文字認識が使えなかったときの理由。 */
  ocrWarning: string | null;
  match: SessionMatch;
  /** 結びつけ先が決まっているときの、スクショと結果の照合。決まっていなければ null。 */
  targetCheck: TargetCheck | null;
}

export type PrepareResult = { ok: true; context: ImportContext } | { ok: false; failure: ImportFailure };

/** 取り込みの準備の指定。 */
export interface PrepareOptions {
  /**
   * 結びつけ先の半荘の名前（取り込み前の半荘のページから、その半荘に取り込むとき。U-14）。
   * 決まっていれば、結びつけ先の照合（E-19）はせず、その半荘の画像だけを読み取る。
   */
  target?: string;
}

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
 * `onStep` は、段階が変わるたびに呼ぶ。`options.target` があれば、その半荘に結びつける（U-14。結びつけ先の照合はしない）。
 */
export async function prepareImport(
  deps: ImportDeps,
  text: string,
  onStep: (step: ImportStep) => void = () => undefined,
  options: PrepareOptions = {},
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

  const targetId = options.target;
  let sessions: SessionRecord[];
  if (targetId === undefined) {
    sessions = candidateSessions(all, deps.now());
  } else {
    const found = all.find((s) => s.id === targetId);
    if (found === undefined) {
      return {
        ok: false,
        failure: {
          title: '取り込む半荘が見つかりません',
          message: `取り込み先の半荘（${targetId}）が、半荘の一覧にありません。削除したか、保存先を変えた可能性があります。`,
        },
      };
    }
    if (found.report_path !== null) {
      return {
        ok: false,
        failure: {
          title: 'この半荘には、すでに結果が取り込まれています',
          message: '結果の入っている半荘には、別の結果を取り込めません。',
        },
      };
    }
    sessions = [found];
  }

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
  const base = { text, game: imported.value, sessions, ocr, ocrWarning };
  const target = targetId === undefined ? undefined : sessions[0];
  if (target !== undefined) {
    return {
      ok: true,
      context: {
        ...base,
        match: { kind: 'match', sessionId: target.id },
        targetCheck: checkTarget(imported.value.report, target, cacheOf(target)),
      },
    };
  }
  const match = matchSessionForReport(
    imported.value.report,
    sessions.map((session) => toSessionCandidate(session, cacheOf(session))),
  );
  return { ok: true, context: { ...base, match, targetCheck: null } };
}

/** 結びつけ先の半荘の迷い・評価のスクショが、結果と合うかを調べる（読めたものだけ）。 */
function checkTarget(report: ImportedGame['report'], session: SessionRecord, ocr: OcrCache | null | undefined): TargetCheck {
  const marks = markReadings(session, ocr);
  const ratings = ratingReadings(session, ocr);
  const check = checkShotsAgainstReport(report, [...marks, ...ratings]);
  const nameOf = (index: number): string => {
    if (index < marks.length) return `迷い${index + 1}`;
    const at = index - marks.length;
    return `評価${session.ratings[at]?.hand ?? at + 1}局目`;
  };
  return {
    sessionId: session.id,
    readable: check.readable,
    fitting: check.fitting,
    mismatches: check.mismatches.map((m) => ({ label: nameOf(m.index), reading: centerText(m.center) })),
  };
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
    const links = buildLinks(report, ratingLinking);
    if (Object.keys(links.marks).length > 0 || Object.keys(links.ratings).length > 0) {
      try {
        await deps.replaceLinks(savedId, links);
      } catch (error) {
        warnings.push(`結果は保存しましたが、結びつけを保存できませんでした（${messageOf(error)}）`);
      }
    }
  }

  const estimated = hanchan.marks.filter((m) => m.status === 'estimated').length;
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
    estimatedMarks: estimated,
    manualMarks: hanchan.marks.length - estimated,
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
