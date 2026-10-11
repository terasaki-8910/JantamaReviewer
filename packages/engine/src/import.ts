/**
 * 取り込み: 結果 JSON を読み、牌譜を再生して、各判断の時点の盤面を組み立てる（E-1・E-2）。
 *
 * mjai-reviewer は牌譜の event を 1 つずつ Mortal に渡し、本人に 2 つ以上の選択肢がある時点で判断（entry）を記録する。
 * ここでは牌譜を同じように 1 event ずつ再生し、判断が作られうる event（本人のツモ・他家の打牌と加槓・本人のチーとポン・
 * 本人のリーチ）の直後に、記録の last_actor・tile・tiles_left・フラグが合う判断を、順に当てはめる。
 * 当てはめた判断ごとに、手牌（ツモ牌を含む）・副露・実戦の行動が記録と一致することを確かめ、
 * 1 つでも合わなければ、局と巡目を示して取り込みを失敗にする。
 */
import { deriveActualAction, describeAction, sameAction } from './actions';
import { type Decision, type DecisionKind, classifyDecisionKind, classifyTags } from './decision';
import { kyokuLabel } from './kyoku';
import { type ParseIssue, parseReport } from './report';
import type { Fuuro, MjaiEvent, MortalReport, ReportEntry, Seat } from './report-types';
import { KyokuReplayer, type KyokuLog, type ReplayFrame, ReplayLogError, replayFrames, splitKyokus } from './replay';
import { type Result, err, ok } from './result';
import { sceneShanten } from './scene-shanten';
import { type Tile, sortTiles } from './tiles';

export type ImportErrorCode =
  | 'parse'
  | 'kyoku-count'
  | 'kyoku-header'
  | 'log'
  | 'no-position'
  | 'hand-mismatch'
  | 'meld-mismatch'
  | 'action-mismatch';

export interface ImportError {
  code: ImportErrorCode;
  /** 利用者に見せてよい理由。局と巡目が分かるときはそれを含む。 */
  message: string;
  /** 局の名前（分かるとき）。例: 東2局1本場 */
  kyokuLabel?: string;
  /** 巡目（分かるとき）。 */
  junme?: number;
  /** 何番目の局か（分かるとき）。 */
  kyokuPosition?: number;
  /** その局の何番目の判断か（分かるとき）。 */
  entryIndex?: number;
  /** code が parse のときの、悪い項目の一覧。 */
  issues?: ParseIssue[];
}

/** 取り込んだ半荘の 1 局。 */
export interface ImportedKyoku {
  /** 何番目の局か（0 から）。 */
  position: number;
  /** 局の通し番号（東1局が 0）。 */
  kyoku: number;
  honba: number;
  label: string;
  /** mjai_log の中の start_kyoku の位置。 */
  startIndex: number;
  /** mjai_log の中のこの局の最後の event の位置。 */
  endIndex: number;
  decisions: Decision[];
}

/** 取り込んだ半荘。 */
export interface ImportedGame {
  report: MortalReport;
  /** レビューした本人の席。 */
  playerId: Seat;
  kyokus: ImportedKyoku[];
  /** 全判断（半荘の順）。 */
  decisions: Decision[];
}

/** 判断が作られうる event か、そのときのフラグ。作られえない event は null。 */
interface CandidateFlags {
  atSelfChiPon: boolean;
  atSelfRiichi: boolean;
  atOpponentKakan: boolean;
}

function candidateFlags(event: MjaiEvent, playerId: Seat): CandidateFlags | null {
  const none: CandidateFlags = { atSelfChiPon: false, atSelfRiichi: false, atOpponentKakan: false };
  switch (event.type) {
    case 'tsumo':
      return event.actor === playerId ? none : null;
    case 'dahai':
    case 'ankan':
      return event.actor !== playerId ? none : null;
    case 'kakan':
      return event.actor !== playerId ? { ...none, atOpponentKakan: true } : null;
    case 'chi':
    case 'pon':
      return event.actor === playerId ? { ...none, atSelfChiPon: true } : null;
    case 'reach':
      return event.actor === playerId ? { ...none, atSelfRiichi: true } : null;
    default:
      return null;
  }
}

function tilesText(tiles: readonly Tile[]): string {
  return sortTiles(tiles).join(' ');
}

function sameTiles(a: readonly Tile[], b: readonly Tile[]): boolean {
  if (a.length !== b.length) return false;
  const x = sortTiles(a);
  const y = sortTiles(b);
  return x.every((t, i) => t === y[i]);
}

/** 副露 1 つを、順不同の牌を並べ替えた比べやすい文字列にする。 */
function meldKey(m: Fuuro): string {
  const consumed = sortTiles(m.consumed).join(',');
  switch (m.type) {
    case 'chi':
    case 'pon':
    case 'daiminkan':
      return `${m.type}|${m.target}|${m.pai}|${consumed}`;
    case 'kakan':
      return `kakan|${m.pai}|${m.previous_pon_target}|${m.previous_pon_pai}|${consumed}`;
    case 'ankan':
      return `ankan|${consumed}`;
  }
}

function sameMelds(a: readonly Fuuro[], b: readonly Fuuro[]): boolean {
  return a.length === b.length && a.every((m, i) => meldKey(m) === meldKey(b[i] as Fuuro));
}

function meldsText(melds: readonly Fuuro[]): string {
  return melds.length === 0 ? 'なし' : melds.map(meldKey).join(' / ');
}

/** 結果 JSON（検査済み）を再生して、判断ごとの盤面つきの半荘にする。 */
export function importParsedReport(report: MortalReport): Result<ImportedGame, ImportError> {
  const playerId = report.player_id;
  const kyokuLogs = splitKyokus(report.mjai_log);
  const reviewKyokus = report.review.kyokus;

  if (kyokuLogs.length !== reviewKyokus.length) {
    return err({
      code: 'kyoku-count',
      message: `局の数が合いません（review: ${reviewKyokus.length}局、牌譜: ${kyokuLogs.length}局）`,
    });
  }

  const kyokus: ImportedKyoku[] = [];
  const decisions: Decision[] = [];

  for (let position = 0; position < reviewKyokus.length; position++) {
    const reviewKyoku = reviewKyokus[position];
    const log = kyokuLogs[position];
    if (!reviewKyoku || !log) continue;

    const replayer = new KyokuReplayer(log.start, playerId);
    const label = kyokuLabel(reviewKyoku.kyoku, reviewKyoku.honba);
    if (replayer.kyokuIndex !== reviewKyoku.kyoku || log.start.honba !== reviewKyoku.honba) {
      return err({
        code: 'kyoku-header',
        kyokuPosition: position,
        message: `${position + 1}局目の局の名前が合いません（review: ${label}、牌譜: ${kyokuLabel(replayer.kyokuIndex, log.start.honba)}）`,
      });
    }

    const result = alignKyoku(report, log, position, label, replayer, reviewKyoku.entries, decisions.length);
    if (!result.ok) return result;
    decisions.push(...result.value);
    kyokus.push({
      position,
      kyoku: reviewKyoku.kyoku,
      honba: reviewKyoku.honba,
      label,
      startIndex: log.startIndex,
      endIndex: log.startIndex + log.events.length - 1,
      decisions: result.value,
    });
  }

  return ok({ report, playerId, kyokus, decisions });
}

function alignKyoku(
  report: MortalReport,
  log: KyokuLog,
  position: number,
  label: string,
  replayer: KyokuReplayer,
  entries: readonly ReportEntry[],
  firstIndex: number,
): Result<Decision[], ImportError> {
  const playerId = report.player_id;
  const decisions: Decision[] = [];
  let next = 0;

  const fail = (code: ImportErrorCode, entry: ReportEntry, entryIndex: number, detail: string): Result<never, ImportError> =>
    err({
      code,
      kyokuLabel: label,
      junme: entry.junme,
      kyokuPosition: position,
      entryIndex,
      message: `${label} ${entry.junme}巡目: ${detail}`,
    });

  for (let i = 1; i < log.events.length; i++) {
    const event = log.events[i] as MjaiEvent;
    try {
      replayer.apply(event, log.startIndex + i);
    } catch (e) {
      if (e instanceof ReplayLogError) {
        return err({
          code: 'log',
          kyokuLabel: label,
          junme: replayer.junme,
          kyokuPosition: position,
          message: `${label} ${replayer.junme}巡目付近: 牌譜が矛盾しています（${e.message}。mjai_log[${e.eventIndex}]）`,
        });
      }
      throw e;
    }

    const entry = entries[next];
    if (!entry) continue;
    const flags = candidateFlags(event, playerId);
    if (
      !flags ||
      entry.last_actor !== replayer.lastActor ||
      entry.tile !== replayer.lastTile ||
      entry.tiles_left !== replayer.tilesLeft ||
      entry.at_self_chi_pon !== flags.atSelfChiPon ||
      entry.at_self_riichi !== flags.atSelfRiichi ||
      entry.at_opponent_kakan !== flags.atOpponentKakan
    ) {
      continue;
    }

    // 手牌（ツモ牌を含む）・副露・実戦の行動が記録と一致するか
    const hand = replayer.ownHand();
    if (!sameTiles(hand, entry.state.tehai)) {
      return fail('hand-mismatch', entry, next, `手牌が記録と一致しません（記録: ${tilesText(entry.state.tehai)}、再生: ${tilesText(hand)}）`);
    }
    const melds = replayer.ownMelds();
    if (!sameMelds(melds, entry.state.fuuros)) {
      return fail('meld-mismatch', entry, next, `副露が記録と一致しません（記録: ${meldsText(entry.state.fuuros)}、再生: ${meldsText(melds)}）`);
    }
    const actual = deriveActualAction(log.events, i, playerId);
    if (actual === null || !sameAction(actual, entry.actual)) {
      return fail(
        'action-mismatch',
        entry,
        next,
        `実戦の行動が牌譜と一致しません（記録: ${describeAction(entry.actual)}、牌譜: ${actual ? describeAction(actual) : '不明'}）`,
      );
    }

    const board = replayer.snapshot();
    const kind: DecisionKind = classifyDecisionKind(entry.details);
    const reviewKyoku = report.review.kyokus[position];
    decisions.push({
      index: firstIndex + decisions.length,
      kyokuPosition: position,
      entryIndex: next,
      kyoku: reviewKyoku ? reviewKyoku.kyoku : board.kyokuIndex,
      honba: board.honba,
      kyokuLabel: label,
      junme: entry.junme,
      eventIndex: log.startIndex + i,
      entry,
      board,
      kind,
      shanten: sceneShanten(board),
      tags: classifyTags(entry, kind, board),
    });
    next++;
  }

  if (next < entries.length) {
    const entry = entries[next] as ReportEntry;
    return fail(
      'no-position',
      entry,
      next,
      `判断（${entry.tile}・残り${entry.tiles_left}枚・直前に動いた席${entry.last_actor}）に対応する局面が牌譜に見つかりません`,
    );
  }
  return ok(decisions);
}

/**
 * 判断の 2〜3 巡前から判断の時点までの盤面を、event ごとに返す（F3: 2〜3巡前から再生できる）。
 * 本人の巡目が「判断の巡目 - turnsBefore」になったとき（そのツモ・チー・ポンの直後）から始める。
 * それより前が無ければ配牌から。最後の盤面は、判断の盤面と同じ。
 */
export function framesBeforeDecision(game: ImportedGame, decision: Decision, turnsBefore = 2): ReplayFrame[] {
  const log = splitKyokus(game.report.mjai_log)[decision.kyokuPosition];
  if (!log) throw new RangeError(`${decision.kyokuPosition + 1}局目が牌譜にありません`);
  const frames = replayFrames(log, game.playerId);
  const target = decision.board.junme - Math.max(0, Math.floor(turnsBefore));
  const found = target > 0 ? frames.findIndex((f) => f.board.junme >= target) : -1;
  return frames.slice(Math.max(0, found), decision.eventIndex - log.startIndex + 1);
}

/** 結果 JSON（読み込み済みの値）を検査して、再生する。 */
export function importReport(json: unknown): Result<ImportedGame, ImportError> {
  const parsed = parseReport(json);
  if (!parsed.ok) return err({ code: 'parse', message: parsed.error.message, issues: parsed.error.issues });
  return importParsedReport(parsed.value);
}

/** JSON の文字列から取り込む。 */
export function importReportText(text: string): Result<ImportedGame, ImportError> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err({
      code: 'parse',
      message: `結果の JSON を読めませんでした: JSON として正しくありません（${reason}）`,
      issues: [{ path: '$', message: `JSON として正しくありません（${reason}）` }],
    });
  }
  return importReport(json);
}
