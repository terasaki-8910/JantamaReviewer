/**
 * MAKA の評価への当てはめの見込み（F10、U-31、R11-13）。
 *
 * 点数（Rating）から段階への当てはめは、次の記録から作る:
 * - 基礎の記録: analysis/maka-fit/dataset.csv の 67 局（5 半荘。`MAKA_BASE_RECORDS`。csv から作った定数）
 * - 利用者が入れた MAKA の評価: 取り込んだ半荘の局ごとの評価（`maka.json`）。1 局 = 1 記録
 * 同じ局が基礎の記録にもあるときは、利用者の評価が、その基礎の記録に置き換わる（記録の数は増えない）。
 * 見込み（ぴったり何割・±1段階以内何割）は、半荘を 1 つずつ外して当てはめ、外した半荘の局を予想した値（`evaluateLeaveOneGameOut`。E-13）。
 *
 * 半荘の突き合わせ: 取り込んだ半荘は、基礎の記録の半荘（mjai の結果の ID。`game`）と、名前では結びつかない
 * （アプリは半荘をフォルダの名前で持ち、mjai の ID は覚えていない）。そこで中身で突き合わせる。取り込んだ半荘の局（名前と
 * Rating）が、基礎の記録のある半荘の局と、すべて同じなら（点数は `SCORE_MATCH_EPSILON` まで）、同じ半荘とみなす（`matchBaseGame`）。
 * Rating は 100% の局が多く、1 局だけの一致では別の半荘と取り違えうるので、局をすべて照らす。同じ半荘とみなしたら、その半荘の
 * 利用者の評価は、基礎の半荘の名前で数える（半荘を外す検証で、同じ半荘として外れる）。どれとも合わない半荘は、半荘ごとに別の半荘。
 */
import { type Grade, type GradeModel, type GradeRecord, evaluateLeaveOneGameOut, fitGradeModel } from './grade';
import { MAKA_BASE_RECORDS, type MakaBaseRecord } from './maka-fit-base';

/** 点数が同じとみなす差（Rating の 100 倍。同じ結果から同じ式で計算した値は、浮動小数点の誤差だけ違う）。 */
export const SCORE_MATCH_EPSILON = 1e-6;

/** 局の名前と、その局の点数（Rating の 100 倍）。 */
export interface FitKyoku {
  /** 局の名前。例: 東2局1本場（`kyokuLabel`）。 */
  label: string;
  score: number;
}

/** 利用者が入れた MAKA の評価 1 つ。 */
export interface UserMakaGrade extends FitKyoku {
  /** 取り込んだ半荘の名前（フォルダの名前）。 */
  sessionId: string;
  grade: Grade;
}

/** 取り込んだ半荘の、評価のある局の一覧（点数のある局すべて。基礎の半荘との突き合わせに使う）。 */
export interface FitSession {
  sessionId: string;
  kyokus: readonly FitKyoku[];
}

/** 基礎の記録の点数（Rating の 100 倍）。 */
export function baseScore(record: MakaBaseRecord): number {
  return record.rating * 100;
}

/** 基礎の記録を、当てはめの記録にする（局の順。67 件）。 */
export function baseGradeRecords(): GradeRecord[] {
  return MAKA_BASE_RECORDS.map((r) => ({ game: r.game, score: baseScore(r), grade: r.grade }));
}

/**
 * 取り込んだ半荘の局が、基礎の記録のどの半荘と同じかを探す。局の数も名前も点数も同じものが 1 つあれば、その半荘の名前を返す。
 * 点数の無い局（判断の無い局）は、数えずに照らす。合うものが無い（または空）なら null。
 */
export function matchBaseGame(kyokus: readonly FitKyoku[]): string | null {
  if (kyokus.length === 0) return null;
  const games = [...new Set(MAKA_BASE_RECORDS.map((r) => r.game))];
  for (const game of games) {
    const records = MAKA_BASE_RECORDS.filter((r) => r.game === game);
    if (records.length !== kyokus.length) continue;
    const same = kyokus.every((k) =>
      records.some((r) => r.label === k.label && Math.abs(baseScore(r) - k.score) <= SCORE_MATCH_EPSILON),
    );
    if (same) return game;
  }
  return null;
}

/** 半荘の名前 → 当てはめでの半荘の名前（基礎の半荘と同じならその名前、そうでなければ、取り込んだ半荘の名前そのまま）。 */
export function gameNamesOf(sessions: readonly FitSession[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of sessions) names.set(s.sessionId, matchBaseGame(s.kyokus) ?? `session:${s.sessionId}`);
  return names;
}

export interface MakaFitRecords {
  records: GradeRecord[];
  /** 基礎の記録を置き換えた利用者の評価の数。 */
  replaced: number;
}

/**
 * 当てはめに使う記録を作る。基礎の 67 件に、利用者の評価を足す。基礎の記録と同じ局の評価は、その記録を置き換える。
 * 利用者の評価は、渡した順に扱う（同じ局に 2 つ渡したら、あとのもの）。
 */
export function makaFitRecords(users: readonly UserMakaGrade[], sessions: readonly FitSession[]): MakaFitRecords {
  const names = gameNamesOf(sessions);
  const records = baseGradeRecords();
  const base = MAKA_BASE_RECORDS;
  const at = new Map<string, number>(); // `${game}\n${label}` → records の添字
  const keyOf = (game: string, label: string) => `${game}\n${label}`;
  base.forEach((r, i) => at.set(keyOf(r.game, r.label), i));
  const replacedAt = new Set<number>();
  for (const user of users) {
    const game = names.get(user.sessionId) ?? `session:${user.sessionId}`;
    const key = keyOf(game, user.label);
    const record: GradeRecord = { game, score: user.score, grade: user.grade };
    const found = at.get(key);
    if (found === undefined) {
      at.set(key, records.length);
      records.push(record);
    } else {
      records[found] = record;
      if (found < base.length) replacedAt.add(found);
    }
  }
  return { records, replaced: replacedAt.size };
}

export interface MakaFit {
  model: GradeModel;
  /** 当てはめに使った記録の数（基礎の 67 局 + 足した分。置き換えた分は増やさない）。 */
  recordCount: number;
  /** 利用者が入れた評価の数（基礎の記録を置き換えたものも含む）。 */
  userCount: number;
  /** 基礎の記録を置き換えた数。 */
  replacedCount: number;
  /** 半荘を 1 つずつ外して確かめた、段階がぴったり同じ割合（0 から 1）。確かめられないとき（半荘が 1 つだけ）は null。 */
  exact: number | null;
  /** 半荘を 1 つずつ外して確かめた、±1段階以内の割合（0 から 1）。 */
  withinOne: number | null;
}

/** 画面に出す割合（%。四捨五入）。確かめられなければ null。 */
export function percentOf(ratio: number | null): number | null {
  return ratio === null || Number.isNaN(ratio) ? null : Math.round(ratio * 100);
}

/** 当てはめ直す。利用者の評価が無ければ、基礎の 67 局だけの当てはめ（`DEFAULT_GRADE_MODEL` と同じ）。 */
export function fitMaka(users: readonly UserMakaGrade[] = [], sessions: readonly FitSession[] = []): MakaFit {
  const { records, replaced } = makaFitRecords(users, sessions);
  const model = fitGradeModel(records);
  const loo = evaluateLeaveOneGameOut(records);
  return {
    model,
    recordCount: records.length,
    userCount: users.length,
    replacedCount: replaced,
    exact: loo === null ? null : loo.agreement.exact,
    withinOne: loo === null ? null : loo.agreement.withinOne,
  };
}

let baseFit: MakaFit | null = null;

/** 基礎の記録だけの当てはめ（最初の見込み。67 局・ぴったり 34%・±1段階以内 66%）。 */
export function baseMakaFit(): MakaFit {
  baseFit ??= fitMaka();
  return baseFit;
}
