/**
 * 「読み」を入にしたあとの、用意の様子を伝える行（F23）。右の欄の上に出す（手牌の下の帯・卓の上の行は、読みがあるかどうかで動かない）。
 * - 計算している間: 「読みを計算しています… 64/117」（読み上げは aria-live の polite）
 * - 読みのモデルが入っていないとき: 「読みのモデルが入っていません。」と、設定の「解析のモデル」へ移る「設定を開く」
 * - 失敗したとき: 理由つきの知らせ（role="alert"）と「もう一度」
 * 用意ができたとき・探している間・切のときは、何も出さない。
 */
import type { ReadsLoad } from './useSessionReads';

/** 計算している間の文。`total` が分かるときは、済んだ数と全部の数を添える。 */
export function computingText(load: Extract<ReadsLoad, { kind: 'computing' }>): string {
  return load.total === null ? '読みを計算しています…' : `読みを計算しています… ${load.done}/${load.total}`;
}

interface ReadsStatusProps {
  load: ReadsLoad;
  /** 読みの入切を保存できなかった理由。 */
  saveError?: string | null;
  onRetry: () => void;
  /** 設定の「解析のモデル」を開く（シェルの外では無い）。 */
  onOpenSettings: (() => void) | null;
}

export function ReadsStatus({ load, saveError = null, onRetry, onOpenSettings }: ReadsStatusProps) {
  if (saveError !== null) {
    return (
      <p className="rd-status is-problem" role="alert" data-ai="reads-status">
        {saveError}
      </p>
    );
  }
  switch (load.kind) {
    case 'computing':
      return (
        <p className="rd-status" aria-live="polite" data-ai="reads-status">
          {computingText(load)}
        </p>
      );
    case 'no-model':
      return (
        <p className="rd-status" data-ai="reads-status">
          読みのモデルが入っていません。
          {onOpenSettings !== null && (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={onOpenSettings}>
                設定を開く
              </button>
            </>
          )}
        </p>
      );
    case 'error':
      return (
        <p className="rd-status is-problem" role="alert" data-ai="reads-status">
          読みを出せませんでした: {load.message}{' '}
          <button type="button" className="link-btn" onClick={onRetry}>
            もう一度
          </button>
        </p>
      );
    default:
      return null;
  }
}
