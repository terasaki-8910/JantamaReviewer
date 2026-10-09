/**
 * 結果 JSON の読み取りと検査（E-1）。
 *
 * 取り込む JSON は外から来るので、型の注釈を信じず、使う項目をすべて検査する。
 * 失敗したときは、どの項目がどう悪いかを「パス（review.kyokus[3].entries[7].details[2].prob のような形）」つきで返す。
 * 判断の数が review.total_reviewed と一致することも、ここで確かめる。
 */
import { type Result, err, ok } from './result';
import type {
  ActionEvent,
  EndStatusEvent,
  Fuuro,
  MjaiEvent,
  MortalReport,
  ReportDetail,
  ReportEntry,
  ReportKyoku,
  ReportReview,
  Seat,
  Wind,
} from './report-types';
import { type Tile, isTile } from './tiles';

export interface ParseIssue {
  /** 直す場所。`$` が JSON 全体。 */
  path: string;
  message: string;
}

export interface ReportParseError {
  /** 利用者に見せてよい 1 つのメッセージ（最初の問題と件数）。 */
  message: string;
  issues: ParseIssue[];
}

/** 最初のいくつかの問題だけ集める（壊れた巨大な JSON で数万件にならないように）。 */
const MAX_ISSUES = 30;

class Ctx {
  readonly issues: ParseIssue[] = [];
  omitted = 0;

  add(path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, message });
    else this.omitted++;
  }
}

type Obj = Record<string, unknown>;

function describe(value: unknown): string {
  if (value === undefined) return '（ありません）';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.length > 30 ? `${value.slice(0, 30)}...` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `配列（${value.length}個）`;
  return 'オブジェクト';
}

function asObject(v: unknown, path: string, ctx: Ctx): Obj | undefined {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Obj;
  ctx.add(path, `オブジェクトが必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asArray(v: unknown, path: string, ctx: Ctx): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  ctx.add(path, `配列が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asNumber(v: unknown, path: string, ctx: Ctx): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  ctx.add(path, `数値が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asInt(v: unknown, path: string, ctx: Ctx, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) return v;
  const range = Number.isFinite(min) || Number.isFinite(max) ? `（${Number.isFinite(min) ? min : ''}から${Number.isFinite(max) ? max : ''}）` : '';
  ctx.add(path, `整数${range}が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asString(v: unknown, path: string, ctx: Ctx): string | undefined {
  if (typeof v === 'string') return v;
  ctx.add(path, `文字列が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asBoolean(v: unknown, path: string, ctx: Ctx): boolean | undefined {
  if (typeof v === 'boolean') return v;
  ctx.add(path, `true か false が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asSeat(v: unknown, path: string, ctx: Ctx): Seat | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) return v as Seat;
  ctx.add(path, `席の番号（0 から 3）が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asTile(v: unknown, path: string, ctx: Ctx): Tile | undefined {
  if (isTile(v)) return v;
  ctx.add(path, `牌の表記（1m・5pr・E など）が必要です（実際: ${describe(v)}）`);
  return undefined;
}

function asTiles(v: unknown, path: string, ctx: Ctx, length?: number): Tile[] | undefined {
  const arr = asArray(v, path, ctx);
  if (!arr) return undefined;
  if (length !== undefined && arr.length !== length) {
    ctx.add(path, `牌が ${length} 枚必要です（実際: ${arr.length} 枚）`);
    return undefined;
  }
  const out: Tile[] = [];
  let good = true;
  arr.forEach((item, i) => {
    const t = asTile(item, `${path}[${i}]`, ctx);
    if (t === undefined) good = false;
    else out.push(t);
  });
  return good ? out : undefined;
}

function asNumbers(v: unknown, path: string, ctx: Ctx, length?: number): number[] | undefined {
  const arr = asArray(v, path, ctx);
  if (!arr) return undefined;
  if (length !== undefined && arr.length !== length) {
    ctx.add(path, `数値が ${length} 個必要です（実際: ${arr.length} 個）`);
    return undefined;
  }
  const out: number[] = [];
  let good = true;
  arr.forEach((item, i) => {
    const n = asNumber(item, `${path}[${i}]`, ctx);
    if (n === undefined) good = false;
    else out.push(n);
  });
  return good ? out : undefined;
}

/** 項目が無い（undefined）ときだけ、無いことを報告して undefined を返す。 */
function need(o: Obj, key: string, path: string, ctx: Ctx): unknown {
  const v = o[key];
  if (v === undefined) {
    ctx.add(`${path}.${key}`, '項目がありません');
    return undefined;
  }
  return v;
}

function parseWind(v: unknown, path: string, ctx: Ctx): Wind | undefined {
  if (v === 'E' || v === 'S' || v === 'W' || v === 'N') return v;
  ctx.add(path, `場風（E・S・W・N）が必要です（実際: ${describe(v)}）`);
  return undefined;
}

/** 点数の増減の配列（4席）を、任意の項目として読む。 */
function optionalDeltas(o: Obj, path: string, ctx: Ctx): { value: number[] | undefined; good: boolean } {
  if (o.deltas === undefined || o.deltas === null) return { value: undefined, good: true };
  const deltas = asNumbers(o.deltas, `${path}.deltas`, ctx, 4);
  return { value: deltas, good: deltas !== undefined };
}

/**
 * 牌譜の1件、または判断の行動（actions が true なら none を許し、牌譜だけの種類は許さない）を読む。
 * 検査に通らなければ undefined。
 */
function parseEvent(v: unknown, path: string, ctx: Ctx, mode: 'log' | 'action'): MjaiEvent | ActionEvent | undefined {
  const o = asObject(v, path, ctx);
  if (!o) return undefined;
  const type = asString(need(o, 'type', path, ctx), `${path}.type`, ctx);
  if (type === undefined) return undefined;

  const actor = (): Seat | undefined => asSeat(need(o, 'actor', path, ctx), `${path}.actor`, ctx);
  const target = (): Seat | undefined => asSeat(need(o, 'target', path, ctx), `${path}.target`, ctx);
  const pai = (): Tile | undefined => asTile(need(o, 'pai', path, ctx), `${path}.pai`, ctx);
  const consumed = (n: number): Tile[] | undefined => asTiles(need(o, 'consumed', path, ctx), `${path}.consumed`, ctx, n);

  switch (type) {
    case 'dahai': {
      const a = actor();
      const p = pai();
      const t = asBoolean(need(o, 'tsumogiri', path, ctx), `${path}.tsumogiri`, ctx);
      if (a === undefined || p === undefined || t === undefined) return undefined;
      return { type, actor: a, pai: p, tsumogiri: t };
    }
    case 'chi':
    case 'pon':
    case 'daiminkan': {
      const a = actor();
      const tg = target();
      const p = pai();
      const c = consumed(type === 'daiminkan' ? 3 : 2);
      if (a === undefined || tg === undefined || p === undefined || c === undefined) return undefined;
      return { type, actor: a, target: tg, pai: p, consumed: c };
    }
    case 'ankan': {
      const a = actor();
      const c = consumed(4);
      if (a === undefined || c === undefined) return undefined;
      return { type, actor: a, consumed: c };
    }
    case 'kakan': {
      const a = actor();
      const p = pai();
      const c = consumed(3);
      if (a === undefined || p === undefined || c === undefined) return undefined;
      return { type, actor: a, pai: p, consumed: c };
    }
    case 'reach': {
      const a = actor();
      return a === undefined ? undefined : { type, actor: a };
    }
    case 'hora': {
      const a = actor();
      const tg = target();
      const d = optionalDeltas(o, path, ctx);
      let ura: Tile[] | undefined;
      let uraGood = true;
      if (o.ura_markers !== undefined && o.ura_markers !== null) {
        ura = asTiles(o.ura_markers, `${path}.ura_markers`, ctx);
        uraGood = ura !== undefined;
      }
      if (a === undefined || tg === undefined || !d.good || !uraGood) return undefined;
      const event: MjaiEvent & { type: 'hora' } = { type, actor: a, target: tg };
      if (d.value) event.deltas = d.value;
      if (ura) event.ura_markers = ura;
      return event;
    }
    case 'ryukyoku': {
      const d = optionalDeltas(o, path, ctx);
      if (!d.good) return undefined;
      const event: MjaiEvent & { type: 'ryukyoku' } = { type };
      if (d.value) event.deltas = d.value;
      if (typeof o.reason === 'string') event.reason = o.reason;
      return event;
    }
    case 'none': {
      if (mode === 'log') break;
      return { type };
    }
    default:
      break;
  }

  if (mode === 'log') {
    switch (type) {
      case 'start_game': {
        const names = asArray(need(o, 'names', path, ctx), `${path}.names`, ctx);
        if (!names) return undefined;
        const out: string[] = [];
        let good = true;
        names.forEach((n, i) => {
          const s = asString(n, `${path}.names[${i}]`, ctx);
          if (s === undefined) good = false;
          else out.push(s);
        });
        if (!good) return undefined;
        const event: MjaiEvent & { type: 'start_game' } = { type, names: out };
        if (typeof o.kyoku_first === 'number') event.kyoku_first = o.kyoku_first;
        if (typeof o.aka_flag === 'boolean') event.aka_flag = o.aka_flag;
        return event;
      }
      case 'start_kyoku': {
        const bakaze = parseWind(need(o, 'bakaze', path, ctx), `${path}.bakaze`, ctx);
        const dora = asTile(need(o, 'dora_marker', path, ctx), `${path}.dora_marker`, ctx);
        const kyoku = asInt(need(o, 'kyoku', path, ctx), `${path}.kyoku`, ctx, 1, 4);
        const honba = asInt(need(o, 'honba', path, ctx), `${path}.honba`, ctx, 0);
        const kyotaku = asInt(need(o, 'kyotaku', path, ctx), `${path}.kyotaku`, ctx, 0);
        const oya = asSeat(need(o, 'oya', path, ctx), `${path}.oya`, ctx);
        const scores = asNumbers(need(o, 'scores', path, ctx), `${path}.scores`, ctx, 4);
        const tehaisRaw = asArray(need(o, 'tehais', path, ctx), `${path}.tehais`, ctx);
        let tehais: Tile[][] | undefined;
        if (tehaisRaw) {
          if (tehaisRaw.length !== 4) {
            ctx.add(`${path}.tehais`, `4人分の配牌が必要です（実際: ${tehaisRaw.length}人分）`);
          } else {
            const rows = tehaisRaw.map((row, i) => asTiles(row, `${path}.tehais[${i}]`, ctx, 13));
            if (rows.every((r): r is Tile[] => r !== undefined)) tehais = rows;
          }
        }
        if (
          bakaze === undefined ||
          dora === undefined ||
          kyoku === undefined ||
          honba === undefined ||
          kyotaku === undefined ||
          oya === undefined ||
          scores === undefined ||
          tehais === undefined
        ) {
          return undefined;
        }
        return { type, bakaze, dora_marker: dora, kyoku, honba, kyotaku, oya, scores, tehais };
      }
      case 'tsumo': {
        const a = actor();
        const p = pai();
        if (a === undefined || p === undefined) return undefined;
        return { type, actor: a, pai: p };
      }
      case 'reach_accepted': {
        const a = actor();
        return a === undefined ? undefined : { type, actor: a };
      }
      case 'dora': {
        const m = asTile(need(o, 'dora_marker', path, ctx), `${path}.dora_marker`, ctx);
        return m === undefined ? undefined : { type, dora_marker: m };
      }
      case 'end_kyoku':
        return { type };
      case 'end_game':
        return { type };
      default:
        break;
    }
  }

  ctx.add(`${path}.type`, `知らない種類です: ${JSON.stringify(type)}`);
  return undefined;
}

function parseFuuro(v: unknown, path: string, ctx: Ctx): Fuuro | undefined {
  const o = asObject(v, path, ctx);
  if (!o) return undefined;
  const type = asString(need(o, 'type', path, ctx), `${path}.type`, ctx);
  if (type === undefined) return undefined;
  const target = (): Seat | undefined => asSeat(need(o, 'target', path, ctx), `${path}.target`, ctx);
  const pai = (): Tile | undefined => asTile(need(o, 'pai', path, ctx), `${path}.pai`, ctx);
  const consumed = (n: number): Tile[] | undefined => asTiles(need(o, 'consumed', path, ctx), `${path}.consumed`, ctx, n);
  switch (type) {
    case 'chi':
    case 'pon':
    case 'daiminkan': {
      const tg = target();
      const p = pai();
      const c = consumed(type === 'daiminkan' ? 3 : 2);
      if (tg === undefined || p === undefined || c === undefined) return undefined;
      return { type, target: tg, pai: p, consumed: c };
    }
    case 'kakan': {
      const p = pai();
      const tg = asSeat(need(o, 'previous_pon_target', path, ctx), `${path}.previous_pon_target`, ctx);
      const pp = asTile(need(o, 'previous_pon_pai', path, ctx), `${path}.previous_pon_pai`, ctx);
      const c = consumed(2);
      if (p === undefined || tg === undefined || pp === undefined || c === undefined) return undefined;
      return { type, pai: p, previous_pon_target: tg, previous_pon_pai: pp, consumed: c };
    }
    case 'ankan': {
      const c = consumed(4);
      return c === undefined ? undefined : { type, consumed: c };
    }
    default:
      ctx.add(`${path}.type`, `鳴きの種類（chi・pon・daiminkan・kakan・ankan）が必要です（実際: ${JSON.stringify(type)}）`);
      return undefined;
  }
}

function parseDetail(v: unknown, path: string, ctx: Ctx): ReportDetail | undefined {
  const o = asObject(v, path, ctx);
  if (!o) return undefined;
  const action = parseEvent(need(o, 'action', path, ctx), `${path}.action`, ctx, 'action') as ActionEvent | undefined;
  const q = asNumber(need(o, 'q_value', path, ctx), `${path}.q_value`, ctx);
  const prob = asNumber(need(o, 'prob', path, ctx), `${path}.prob`, ctx);
  if (action === undefined || q === undefined || prob === undefined) return undefined;
  return { action, q_value: q, prob };
}

function parseEntry(v: unknown, path: string, ctx: Ctx): ReportEntry | undefined {
  const o = asObject(v, path, ctx);
  if (!o) return undefined;
  const junme = asInt(need(o, 'junme', path, ctx), `${path}.junme`, ctx, 0);
  const tilesLeft = asInt(need(o, 'tiles_left', path, ctx), `${path}.tiles_left`, ctx, 0, 136);
  const lastActor = asSeat(need(o, 'last_actor', path, ctx), `${path}.last_actor`, ctx);
  const tile = asTile(need(o, 'tile', path, ctx), `${path}.tile`, ctx);

  let state: ReportEntry['state'] | undefined;
  const stateObj = asObject(need(o, 'state', path, ctx), `${path}.state`, ctx);
  if (stateObj) {
    const tehai = asTiles(need(stateObj, 'tehai', `${path}.state`, ctx), `${path}.state.tehai`, ctx);
    const fuuroArr = asArray(need(stateObj, 'fuuros', `${path}.state`, ctx), `${path}.state.fuuros`, ctx);
    let fuuros: Fuuro[] | undefined;
    if (fuuroArr) {
      const parsed = fuuroArr.map((f, i) => parseFuuro(f, `${path}.state.fuuros[${i}]`, ctx));
      if (parsed.every((f): f is Fuuro => f !== undefined)) fuuros = parsed;
    }
    if (tehai !== undefined && fuuros !== undefined) state = { tehai, fuuros };
  }

  const atChiPon = asBoolean(need(o, 'at_self_chi_pon', path, ctx), `${path}.at_self_chi_pon`, ctx);
  const atRiichi = asBoolean(need(o, 'at_self_riichi', path, ctx), `${path}.at_self_riichi`, ctx);
  const atKakan = asBoolean(need(o, 'at_opponent_kakan', path, ctx), `${path}.at_opponent_kakan`, ctx);
  const expected = parseEvent(need(o, 'expected', path, ctx), `${path}.expected`, ctx, 'action') as ActionEvent | undefined;
  const actual = parseEvent(need(o, 'actual', path, ctx), `${path}.actual`, ctx, 'action') as ActionEvent | undefined;
  const isEqual = asBoolean(need(o, 'is_equal', path, ctx), `${path}.is_equal`, ctx);
  const shanten = asInt(need(o, 'shanten', path, ctx), `${path}.shanten`, ctx, -1, 8);
  const atFuriten = asBoolean(need(o, 'at_furiten', path, ctx), `${path}.at_furiten`, ctx);

  let details: ReportDetail[] | undefined;
  const detailArr = asArray(need(o, 'details', path, ctx), `${path}.details`, ctx);
  if (detailArr) {
    if (detailArr.length === 0) {
      ctx.add(`${path}.details`, '候補が1つもありません');
    } else {
      const parsed = detailArr.map((d, i) => parseDetail(d, `${path}.details[${i}]`, ctx));
      if (parsed.every((d): d is ReportDetail => d !== undefined)) details = parsed;
    }
  }

  const actualIndex = asInt(need(o, 'actual_index', path, ctx), `${path}.actual_index`, ctx, 0);
  if (actualIndex !== undefined && details !== undefined && actualIndex >= details.length) {
    ctx.add(`${path}.actual_index`, `候補の数（${details.length}）より小さい整数が必要です（実際: ${actualIndex}）`);
    return undefined;
  }

  if (
    junme === undefined ||
    tilesLeft === undefined ||
    lastActor === undefined ||
    tile === undefined ||
    state === undefined ||
    atChiPon === undefined ||
    atRiichi === undefined ||
    atKakan === undefined ||
    expected === undefined ||
    actual === undefined ||
    isEqual === undefined ||
    shanten === undefined ||
    atFuriten === undefined ||
    details === undefined ||
    actualIndex === undefined
  ) {
    return undefined;
  }
  return {
    junme,
    tiles_left: tilesLeft,
    last_actor: lastActor,
    tile,
    state,
    at_self_chi_pon: atChiPon,
    at_self_riichi: atRiichi,
    at_opponent_kakan: atKakan,
    expected,
    actual,
    is_equal: isEqual,
    details,
    shanten,
    at_furiten: atFuriten,
    actual_index: actualIndex,
  };
}

function parseEndStatus(v: unknown, path: string, ctx: Ctx): EndStatusEvent | undefined {
  const event = parseEvent(v, path, ctx, 'log');
  if (event === undefined) return undefined;
  if (event.type !== 'hora' && event.type !== 'ryukyoku') {
    ctx.add(`${path}.type`, `局の結果は hora か ryukyoku が必要です（実際: ${JSON.stringify(event.type)}）`);
    return undefined;
  }
  if (event.deltas === undefined) {
    ctx.add(`${path}.deltas`, '点数の増減（4席）がありません');
    return undefined;
  }
  return event as EndStatusEvent;
}

function parseKyoku(v: unknown, path: string, ctx: Ctx): ReportKyoku | undefined {
  const o = asObject(v, path, ctx);
  if (!o) return undefined;
  const kyoku = asInt(need(o, 'kyoku', path, ctx), `${path}.kyoku`, ctx, 0, 15);
  const honba = asInt(need(o, 'honba', path, ctx), `${path}.honba`, ctx, 0);
  const scores = asNumbers(need(o, 'relative_scores', path, ctx), `${path}.relative_scores`, ctx, 4);

  let endStatus: EndStatusEvent[] | undefined;
  const endArr = asArray(need(o, 'end_status', path, ctx), `${path}.end_status`, ctx);
  if (endArr) {
    const parsed = endArr.map((e, i) => parseEndStatus(e, `${path}.end_status[${i}]`, ctx));
    if (parsed.every((e): e is EndStatusEvent => e !== undefined)) endStatus = parsed;
  }

  let entries: ReportEntry[] | undefined;
  const entryArr = asArray(need(o, 'entries', path, ctx), `${path}.entries`, ctx);
  if (entryArr) {
    const parsed = entryArr.map((e, i) => parseEntry(e, `${path}.entries[${i}]`, ctx));
    if (parsed.every((e): e is ReportEntry => e !== undefined)) entries = parsed;
  }

  if (kyoku === undefined || honba === undefined || scores === undefined || endStatus === undefined || entries === undefined) {
    return undefined;
  }
  return { kyoku, honba, end_status: endStatus, relative_scores: scores, entries };
}

function parseReview(v: unknown, path: string, ctx: Ctx): ReportReview | undefined {
  const o = asObject(v, path, ctx);
  if (!o) return undefined;
  const totalReviewed = asInt(need(o, 'total_reviewed', path, ctx), `${path}.total_reviewed`, ctx, 0);
  const totalMatches = asInt(need(o, 'total_matches', path, ctx), `${path}.total_matches`, ctx, 0);
  const rating = asNumber(need(o, 'rating', path, ctx), `${path}.rating`, ctx);
  const temperature = asNumber(need(o, 'temperature', path, ctx), `${path}.temperature`, ctx);
  const modelTag = asString(need(o, 'model_tag', path, ctx), `${path}.model_tag`, ctx);

  let kyokus: ReportKyoku[] | undefined;
  const kyokuArr = asArray(need(o, 'kyokus', path, ctx), `${path}.kyokus`, ctx);
  if (kyokuArr) {
    if (kyokuArr.length === 0) {
      ctx.add(`${path}.kyokus`, '局が1つもありません');
    } else {
      const parsed = kyokuArr.map((k, i) => parseKyoku(k, `${path}.kyokus[${i}]`, ctx));
      if (parsed.every((k): k is ReportKyoku => k !== undefined)) kyokus = parsed;
    }
  }

  // 局ごとの順位の確率。使わないので、形（数値の3重の配列）だけ見る。
  let phi: number[][][] | undefined;
  const phiArr = asArray(need(o, 'relative_phi_matrix', path, ctx), `${path}.relative_phi_matrix`, ctx);
  if (phiArr) {
    const parsed = phiArr.map((m, i) => {
      const rows = asArray(m, `${path}.relative_phi_matrix[${i}]`, ctx);
      if (!rows) return undefined;
      const out = rows.map((r, j) => asNumbers(r, `${path}.relative_phi_matrix[${i}][${j}]`, ctx));
      return out.every((r): r is number[] => r !== undefined) ? out : undefined;
    });
    if (parsed.every((m): m is number[][] => m !== undefined)) phi = parsed;
  }

  if (
    totalReviewed === undefined ||
    totalMatches === undefined ||
    rating === undefined ||
    temperature === undefined ||
    modelTag === undefined ||
    kyokus === undefined ||
    phi === undefined
  ) {
    return undefined;
  }
  return {
    total_reviewed: totalReviewed,
    total_matches: totalMatches,
    rating,
    temperature,
    kyokus,
    relative_phi_matrix: phi,
    model_tag: modelTag,
  };
}

/** 検査の結果から、利用者に見せる 1 つのメッセージを作る。 */
function summarize(issues: readonly ParseIssue[], omitted: number): string {
  const first = issues[0];
  if (!first) return '結果の JSON を読めませんでした';
  const more = issues.length + omitted - 1;
  return `結果の JSON を読めませんでした: ${first.path}: ${first.message}${more > 0 ? `（ほか ${more} 件）` : ''}`;
}

/**
 * 結果 JSON（読み込み済みの値）を検査して、型のついた値にする。
 * 失敗のときは、悪い項目のパスと理由の一覧を返す。
 */
export function parseReport(input: unknown): Result<MortalReport, ReportParseError> {
  const ctx = new Ctx();
  const root = asObject(input, '$', ctx);
  let report: MortalReport | undefined;

  if (root) {
    const engine = need(root, 'engine', '$', ctx);
    if (engine !== undefined && engine !== 'Mortal') {
      ctx.add('$.engine', `Mortal の結果だけを取り込めます（実際: ${describe(engine)}）`);
    }
    const gameLength = asString(need(root, 'game_length', '$', ctx), '$.game_length', ctx);
    const version = asString(need(root, 'version', '$', ctx), '$.version', ctx);
    const review = parseReview(need(root, 'review', '$', ctx), '$.review', ctx);
    const playerId = asSeat(need(root, 'player_id', '$', ctx), '$.player_id', ctx);
    const splitLogs = asArray(need(root, 'split_logs', '$', ctx), '$.split_logs', ctx);

    let mjaiLog: MjaiEvent[] | undefined;
    const logArr = asArray(need(root, 'mjai_log', '$', ctx), '$.mjai_log', ctx);
    if (logArr) {
      if (logArr.length === 0) {
        ctx.add('$.mjai_log', '牌譜が空です');
      } else {
        const parsed = logArr.map((e, i) => parseEvent(e, `$.mjai_log[${i}]`, ctx, 'log') as MjaiEvent | undefined);
        if (parsed.every((e): e is MjaiEvent => e !== undefined)) mjaiLog = parsed;
      }
    }

    if (review) {
      // E-1: 判断の数は review.total_reviewed と一致する
      const decisionCount = review.kyokus.reduce((n, k) => n + k.entries.length, 0);
      if (decisionCount !== review.total_reviewed) {
        ctx.add(
          '$.review.total_reviewed',
          `判断の数（${decisionCount}）が total_reviewed（${review.total_reviewed}）と一致しません`,
        );
      }
    }

    if (
      ctx.issues.length === 0 &&
      engine === 'Mortal' &&
      gameLength !== undefined &&
      version !== undefined &&
      review !== undefined &&
      playerId !== undefined &&
      splitLogs !== undefined &&
      mjaiLog !== undefined
    ) {
      report = { engine, game_length: gameLength, version, review, player_id: playerId, split_logs: splitLogs, mjai_log: mjaiLog };
    }
  }

  if (report === undefined || ctx.issues.length > 0) {
    if (ctx.issues.length === 0) ctx.add('$', '結果の JSON を読めませんでした');
    return err({ message: summarize(ctx.issues, ctx.omitted), issues: ctx.issues });
  }
  return ok(report);
}

/** JSON の文字列から読む。JSON として壊れているときもメッセージを返す。 */
export function parseReportText(text: string): Result<MortalReport, ReportParseError> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const message = `結果の JSON を読めませんでした: JSON として正しくありません（${reason}）`;
    return err({ message, issues: [{ path: '$', message: `JSON として正しくありません（${reason}）` }] });
  }
  return parseReport(json);
}
