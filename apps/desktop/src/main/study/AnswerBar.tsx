/**
 * 答えの欄のいちばん上の段（F16、U-39、U-41）。先頭に「解決」の入切、右端に次へ進むボタン。
 * 欄をスクロールしても、いつも見える（スクロールするのは、この下の `.answer-scroll` だけ）。
 *
 * - 「解決」は、答える前でも、答え合わせのあとでも押せる。文字は入のときも切のときも「解決」で、押されているかは `aria-pressed` と、
 *   入のときの印（チェック）で分かる（色だけに頼らない）。自動では入れない
 * - 次へ進むボタンは、答え合わせのあとか、解決を入れたあとだけ出る（呼ぶ側が `next` を渡す）。名前も動きも、答え合わせのあとと同じ
 */
import { Icon } from '../Icon';

/** 局面の解決の入切（`useQuizWork` が作る）。 */
export interface ResolveControl {
  /** 解決しているか。 */
  on: boolean;
  /** 入れる・切る。 */
  toggle: () => void;
}

export interface AnswerNext {
  label: string;
  onClick: () => void;
}

interface AnswerBarProps {
  resolve: ResolveControl | undefined;
  /** 次へ進むボタン（出さないときは null）。 */
  next: AnswerNext | null;
}

export function AnswerBar({ resolve, next }: AnswerBarProps) {
  if (resolve === undefined && next === null) return null;
  return (
    <div className="answer-bar">
      {resolve !== undefined && (
        <button
          type="button"
          className={`btn resolve-btn${resolve.on ? ' on' : ''}`}
          id="resolve"
          aria-pressed={resolve.on}
          onClick={resolve.toggle}
        >
          {resolve.on && <Icon name="check" />}
          解決
        </button>
      )}
      {next !== null && (
        <button type="button" className="btn primary lg block" id="next" onClick={next.onClick}>
          {next.label}
        </button>
      )}
    </div>
  );
}
