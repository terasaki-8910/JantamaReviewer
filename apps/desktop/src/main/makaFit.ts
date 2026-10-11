/**
 * MAKA の当てはめの見込み（F10、U-31、R11-13）の、画面側の部分: 取り込んだ半荘と、入れた MAKA の評価から、当てはめ直す入力を作る。
 * 当てはめ・見込みの計算は、エンジンの `fitMaka`（純粋な計算）。ここは、半荘のまとめ（局ごとの Rating）と保存してある
 * MAKA の評価（`maka.json`）を、その入力にするだけ。消した半荘（一覧に無い半荘）は、呼ぶ側が渡さない（D-3 と同じ）。
 */
import {
  baseMakaFit,
  type FitSession,
  type HanchanSummary,
  type MakaFit,
  type UserMakaGrade,
} from '@jantama/engine';

import type { MakaGrades } from '../api/types';
import { makaGradeOf } from './handRows';
import { kyokuKey } from './importFlow';

/** 当てはめの状態。`revision` は、当てはめが替わるたびに 1 つ増える（画面が「合わせ直した」ことに気づくため）。 */
export interface MakaFitState {
  fit: MakaFit;
  revision: number;
}

/** 最初の状態: 基礎の 67 局だけ（利用者の評価が 0 件）。 */
export function initialFitState(): MakaFitState {
  return { fit: baseMakaFit(), revision: 0 };
}

/** 半荘 1 つ分の入力（まとめを読み終えた半荘）。 */
export interface FitSource {
  sessionId: string;
  summary: HanchanSummary;
  /** 保存してある MAKA の局ごとの評価（局の鍵 → 段階）。 */
  maka: MakaGrades['kyokus'];
}

export interface FitInput {
  users: UserMakaGrade[];
  /** 利用者の評価のある半荘の、点数のある局すべて（基礎の半荘との突き合わせに使う）。 */
  sessions: FitSession[];
}

/**
 * 当てはめの入力を作る。MAKA の評価を入れた局のうち、点数（Rating）のあるものだけが記録になる（判断の無い局は点数が無い）。
 * 並びは、半荘の名前の順・局の順（読み込みが終わる順に左右されない）。
 */
export function fitInputOf(sources: readonly FitSource[]): FitInput {
  const users: UserMakaGrade[] = [];
  const sessions: FitSession[] = [];
  for (const source of [...sources].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))) {
    const before = users.length;
    for (const kyoku of source.summary.kyokus) {
      if (kyoku.rating === null) continue;
      const grade = makaGradeOf(source.maka[kyokuKey(kyoku.kyoku, kyoku.honba)]);
      if (grade !== null) users.push({ sessionId: source.sessionId, label: kyoku.label, score: kyoku.rating * 100, grade });
    }
    if (users.length > before) {
      sessions.push({
        sessionId: source.sessionId,
        kyokus: source.summary.kyokus
          .filter((k) => k.rating !== null)
          .map((k) => ({ label: k.label, score: (k.rating as number) * 100 })),
      });
    }
  }
  return { users, sessions };
}

/** 入力の中身が同じかを比べるための文字列（同じなら、当てはめ直さない）。評価が 0 件なら空。 */
export function fitSignature(input: FitInput): string {
  const users = input.users.map((u) => `${u.sessionId}|${u.label}|${u.score}|${u.grade}`).join('\n');
  // 半荘の突き合わせは、半荘の局全部を見る。評価が同じでも、局が替われば、当てはめ直す
  const kyokus = input.sessions.map((s) => `${s.sessionId}:${s.kyokus.map((k) => `${k.label}=${k.score}`).join(',')}`).join('\n');
  return users === '' ? '' : `${users}\n--\n${kyokus}`;
}
