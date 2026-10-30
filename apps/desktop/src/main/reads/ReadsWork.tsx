/**
 * 作業の面（卓・手牌・右の欄）に渡す「読み」（F23）をまとめる。
 * - `ReadsWork`: 作業の面が受け取るもの。卓の上の切り替え・右の欄の上の状態の行・
 *   手牌の下と他家の席と吹き出しに出す場面（無ければ null）
 * - `useQuizReads`: 出題・解き直しの画面の分。`work` は答え合わせのあとにだけ作る（答える前は null。DOM にも、読みのコマンドの呼び出しにも出ない。U-1）。
 *   `reserved` は、手牌の下の帯を取っておくか（画面の根の `data-reads`）
 */
import type { Decision, ImportedGame } from '@jantama/engine';
import { useMemo, type ReactNode } from 'react';

import type { ReadsMomentView } from './explain';
import { momentAtDecision, momentFor } from './moments';
import { ReadsStatus } from './ReadsStatus';
import { ReadsToggle } from './ReadsToggle';
import { useOpenModelSettings } from './settingsLink';
import { useReadsFeature, useReadsKey, type ReadsFeature } from './useReadsFeature';

export interface ReadsWork {
  /** 卓の上の 1 行（盤面の見方の左）に置く切り替え。設定を読めるまでは null。 */
  toggle?: ReactNode;
  status: ReactNode;
  view: ReadsMomentView | null;
}

/** 右の欄の上の状態の行（切のとき・用意ができたときは何も出さない）。 */
export function ReadsFeatureStatus({ feature }: { feature: ReadsFeature }) {
  const openSettings = useOpenModelSettings();
  if (!feature.active) return null;
  return <ReadsStatus load={feature.visible ? feature.load : { kind: 'idle' }} saveError={feature.saveError} onRetry={feature.retry} onOpenSettings={openSettings} />;
}

interface QuizReadsParams {
  sessionId: string;
  game: ImportedGame;
  decision: Decision;
  /** 過去の盤面を見ているか（その盤面は、判断の盤面と手牌が違うので、読みを出さない）。 */
  past: boolean;
  /** 答え合わせのあとか。 */
  revealed: boolean;
}

export function useQuizReads({ sessionId, game, decision, past, revealed }: QuizReadsParams): { work: ReadsWork | null; reserved: boolean } {
  const feature = useReadsFeature(sessionId, revealed);
  useReadsKey(feature.keyChord, revealed && feature.loaded, feature.toggle);
  const { visible, reads } = feature;
  const view = useMemo<ReadsMomentView | null>(() => {
    if (!visible || reads === null || past) return null;
    const moment = momentFor(reads, momentAtDecision(game, decision));
    return moment === null ? null : { moment, board: decision.board };
  }, [visible, reads, past, game, decision]);
  if (!revealed) return { work: null, reserved: feature.reserved };
  return {
    work: {
      // 設定を読めるまでは、切り替えを出さない（入なのに、一瞬切に見えないように）
      toggle: feature.loaded ? <ReadsToggle on={feature.visible} onToggle={feature.toggle} keyChord={feature.keyChord} /> : null,
      status: <ReadsFeatureStatus feature={feature} />,
      view,
    },
    reserved: feature.reserved,
  };
}
