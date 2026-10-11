import { useState, type ReactNode } from 'react';

import { Popup, type PopupItem, type PopupPlacement } from './Popup';

/**
 * 「ボタンを押すと、選択肢のメニューが開き、1 つ選ぶ」部品（WAI-ARIA の menu button）。選択肢の見た目は `Popup`（段階の絞り込みと同じ）。
 *
 * 文字を打つ欄の `<select>` を使わないのは、キーボードで矢印を押すだけで選びが決まってしまう（そのたびに保存され、取り消しの
 * 積み重ねにも載る）のを避けるため。ここでは、Enter か押下で選んだときだけ決まる。選んだあとは、キーボードの位置をこのボタンへ戻す。
 */
export interface MenuSelectItem {
  key: string;
  label: string;
  /** 文字の前に置く図。 */
  icon?: ReactNode;
  /** true なら、文字は読み上げだけにする（図だけで意味が伝わるとき）。 */
  hideLabel?: boolean;
  /** 右に添える、静かな文字（局の選択の、迷いと不一致の数など）。 */
  hint?: string;
  /** いま選ばれているもの。 */
  checked: boolean;
  onSelect: () => void;
}

interface MenuSelectProps {
  /** ボタンの名前（読み上げ用。何の選択か・いまの値を含める）。 */
  label: string;
  /** 開いたメニューの名前（読み上げ用）。 */
  menuLabel: string;
  items: readonly MenuSelectItem[];
  className?: string;
  disabled?: boolean;
  /**
   * いくつでも選べるメニューにする（チェックの項目。押しても閉じず、キーボードの位置もメニューの中に残る）。
   * 閉じるのは、Esc・外を押す・Tab のとき。既定は、1 つ選ぶと閉じる。
   */
  multiple?: boolean;
  /** メニューを出す場所。既定は、ボタンの下に右端をそろえる。 */
  placement?: PopupPlacement;
  /** ボタンの中身（いまの値の見た目）。 */
  children: ReactNode;
}

export function MenuSelect({ label, menuLabel, items, className, disabled, multiple = false, placement, children }: MenuSelectProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const popupItems = (trigger: HTMLElement): PopupItem[] =>
    items.map((item): PopupItem => {
      if (multiple) {
        return { kind: 'check', key: item.key, label: item.label, hint: item.hint, checked: item.checked, onSelect: item.onSelect };
      }
      return {
        kind: 'radio',
        key: item.key,
        label: item.label,
        icon: item.icon,
        hideLabel: item.hideLabel,
        hint: item.hint,
        checked: item.checked,
        onSelect: () => {
          // 選んだあと、キーボードの位置はこのボタンに戻す（メニューの項目は、閉じると消えるため）。
          trigger.focus();
          item.onSelect();
        },
      };
    });

  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={label}
        disabled={disabled}
        onClick={(event) => setAnchor(anchor === null ? event.currentTarget : null)}
      >
        {children}
      </button>
      {anchor !== null && (
        <Popup
          label={menuLabel}
          anchor={anchor}
          items={popupItems(anchor)}
          placement={placement}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
