import type { ShownMemo } from '../memos';

/**
 * 答え合わせのあとの「終局直後のメモ」（F4、U-28）: 自分の答えの下に、その問題に結びつくメモ（「候補」と「理由」）を出す。
 * 答える前は出さない（呼ぶ側が、答え合わせのあとにだけ渡す。DOM にも無い）。AI の評価ではないので、`data-ai` は付けない。
 * メモが 2 つ以上あるとき（同じ判断に迷いが 2 つ・追加のメモがある）は、メモごとに小さな名前（「迷い3」「追加のメモ」）を付ける。
 */
export function MemoShown({ memos }: { memos: readonly ShownMemo[] }) {
  if (memos.length === 0) return null;
  return (
    <div className="q-sec memo-shown" data-memo="shown">
      <h2 className="sec-title">終局直後のメモ</h2>
      {memos.map((item, index) => (
        <div className="memo-item" key={`${item.source}-${item.label}-${index}`}>
          {memos.length > 1 && <p className="memo-from">{item.label}</p>}
          <dl className="memo-dl">
            {item.memo.candidates !== '' && (
              <div>
                <dt>候補</dt>
                <dd>{item.memo.candidates}</dd>
              </div>
            )}
            {item.memo.reason !== '' && (
              <div>
                <dt>理由</dt>
                <dd>{item.memo.reason}</dd>
              </div>
            )}
          </dl>
        </div>
      ))}
    </div>
  );
}
