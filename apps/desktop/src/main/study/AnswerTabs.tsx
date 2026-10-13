/**
 * 答え合わせの欄のタブの枠（F14、U-34。R15-2「B（タブ）にして、タブはその場面に関係があるときだけ出す」）。
 *
 * 既定のタブ（「受け入れ・役」。いまの受け入れ枚数と役の欄）に、その場面に関係のあるタブだけを足す。足すタブは `revealTabs.tsx` の一覧に 1 つずつ書く
 * （この枠は、タブの中身を知らない）。足すタブが無いときは、枠を作らず、既定の欄をそのまま出す（呼ぶ側が決める）。
 *
 * WAI-ARIA のタブ（Tabs pattern・自動で選ぶ）: タブの並びは 1 つの止まり場所（選んでいるタブだけ Tab で届く）。← → で前・次のタブ（端は反対の端へ）、
 * Home・End で最初・最後のタブ。キーで移ると、選んで、キーボードの位置もそのタブへ移す。中身の欄（tabpanel）は、選んでいるタブの分だけ中身を描き、
 * ほかは空のまま隠しておく（`aria-controls` の行き先は、いつも DOM にある）。
 * ← → と Home・End は、半荘を通して見る画面のキー（前・次の判断、局の頭・終わり）にも割り当てられているので、タブにキーボードの位置があるときは、
 * ここで受けて、画面のキーには渡さない（`preventDefault`。Alt・Ctrl・Shift 付きは、画面の戻る・進むなどに使うので触らない）。
 * 見た目は styles/waits.css（承認済みの見本の `.rv-tabs`）。色はトークンだけ。
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec {
  /** タブの鍵（保存はしない。同じ画面の中で一意）。 */
  id: string;
  /** タブの文字。 */
  label: string;
  /** 中身。選んでいるときだけ呼ぶ。 */
  panel: () => ReactNode;
}

interface AnswerTabsProps {
  /** 先頭が既定のタブ。2 つ以上のとき、タブの並びを出す。 */
  tabs: readonly TabSpec[];
  /** タブの並びの名前（読み上げ用）。 */
  label: string;
}

export function AnswerTabs({ tabs, label }: AnswerTabsProps) {
  const base = useId();
  const [selected, setSelected] = useState(tabs[0]?.id ?? '');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  // 選んでいたタブが無くなったら、既定のタブに戻る
  const current = tabs.some((tab) => tab.id === selected) ? selected : (tabs[0]?.id ?? '');

  const move = (to: number) => {
    const tab = tabs[(to + tabs.length) % tabs.length];
    if (tab === undefined) return;
    setSelected(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let to: number;
    switch (event.key) {
      case 'ArrowRight':
        to = index + 1;
        break;
      case 'ArrowLeft':
        to = index - 1;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    move(to);
  };

  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => `${base}-panel-${id}`;
  return (
    <div className="rv-tabs-box">
      <div className="rv-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            id={tabId(tab.id)}
            aria-controls={panelId(tab.id)}
            aria-selected={tab.id === current}
            tabIndex={tab.id === current ? 0 : -1}
            data-tab={tab.id}
            ref={(element) => {
              if (element === null) refs.current.delete(tab.id);
              else refs.current.set(tab.id, element);
            }}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          className="rv-panel"
          role="tabpanel"
          key={tab.id}
          id={panelId(tab.id)}
          aria-labelledby={tabId(tab.id)}
          hidden={tab.id !== current}
        >
          {tab.id === current ? tab.panel() : null}
        </div>
      ))}
    </div>
  );
}
