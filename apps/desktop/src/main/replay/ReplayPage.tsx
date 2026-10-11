/**
 * 半荘を通して見る画面（F12）のページ。取り込んだ半荘の再生した結果が読めてから、画面（`ReplayScreen`）を出す。
 * 半荘を消した・結果を読み出せなかったときは、その旨を出す。
 */
import { ReplayScreen } from './ReplayScreen';
import { StudyNotice } from '../study/StudyNotice';
import { useStudy } from '../study/StudyProvider';

interface ReplayPageProps {
  sessionId: string;
  /** 開く判断の鍵（無ければ半荘の頭から）。 */
  startKey?: string;
}

export function ReplayPage({ sessionId, startKey }: ReplayPageProps) {
  const study = useStudy();
  const title = '半荘を通して見る';
  if (!study.ready) return <StudyNotice title={title}>読み込み中です。</StudyNotice>;
  const session = study.session(sessionId);
  const state = study.gameState(sessionId);
  if (session === undefined || state === undefined) {
    return (
      <StudyNotice title={title}>
        この半荘を開けませんでした。半荘を消したか、検討結果をまだ取り込んでいないためです。
      </StudyNotice>
    );
  }
  if (state.status !== 'ready') {
    return (
      <StudyNotice title={title} alert>
        取り込んだ結果を読み出せませんでした{state.status === 'unavailable' ? `（${state.reason}）` : ''}。
      </StudyNotice>
    );
  }
  return <ReplayScreen key={`${sessionId}/${startKey ?? ''}`} session={session} game={state.game} startKey={startKey} />;
}
