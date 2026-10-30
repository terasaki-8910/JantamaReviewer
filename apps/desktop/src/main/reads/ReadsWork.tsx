/**
 * 作業の面（卓・手牌・右の欄）に渡す「読み」（F23）をまとめる。
 * - `ReadsWork`: 作業の面が受け取るもの。切り替え（出題・解き直しは卓の上、通して見る画面は操作の段にあるので渡さない）・右の欄の上の状態の行・
 *   手牌の下と他家の席と吹き出しに出す場面（無ければ null）
 * - `useQuizReads`: 出題・解き直しの画面の分。答え合わせのあとにだけ作る（答える前は null。DOM にも、読みのコマンドの呼び出しにも出ない。U-1）
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

export function useQuizReads({ sessionId, game, decision, past, revealed }: QuizReadsParams): ReadsWork | null {
  const feature = useReadsFeature(sessionId, revealed);
  useReadsKey(feature.keyChord, revealed && feature.loaded, feature.toggle);
  const { visible, reads } = feature;
  const view = useMemo<ReadsMomentView | null>(() => {
    if (!visible || reads === null || past) return null;
    const moment = momentFor(reads, momentAtDecision(game, decision));
    return moment === null ? null : { moment, board: decision.board };
  }, [visible, reads, past, game, decision]);
  if (!revealed) return null;
  return {
    // 設定を読めるまでは、切り替えを出さない（入なのに、一瞬切に見えないように）
    toggle: feature.loaded ? <ReadsToggle on={feature.visible} onToggle={feature.toggle} keyChord={feature.keyChord} /> : null,
    status: <ReadsFeatureStatus feature={feature} />,
    view,
  };
}
