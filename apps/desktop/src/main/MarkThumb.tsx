/**
 * 迷いのスクショの小さな写真（押すと大きく見られる。R7-4）。撮れなかった迷いは、同じ大きさの「画像なし」の箱（F9）。
 * 半荘のページの迷いのカード（`MarkCard`）と、出題・通して見る画面の「迷いのスクショ」の欄が、同じ部品を使う。
 */
import { convertFileSrc } from '@tauri-apps/api/core';

import type { MarkRecord } from '../api/types';
import { Icon } from './Icon';

interface MarkThumbProps {
  mark: MarkRecord;
  /** 画面に出す迷いの番号（1 から）。 */
  number: number;
  /** 画像を大きく表示する。`opener` は、閉じたときにキーボードの位置を戻す先（この写真）。 */
  onOpen: (opener: HTMLElement) => void;
}

export function MarkThumb({ mark, number, onOpen }: MarkThumbProps) {
  if (!mark.screenshot_path) {
    return (
      <div className="mthumb-empty" title={mark.capture_error ?? undefined}>
        画像なし
      </div>
    );
  }
  return (
    <button type="button" className="mthumb" data-thumb={mark.id} aria-label={`迷い${number}の画像を大きく見る`} onClick={(event) => onOpen(event.currentTarget)}>
      <img
        className="thumb"
        src={convertFileSrc(mark.screenshot_path)}
        alt={`迷い${number}のスクリーンショット`}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      <span className="zoom" aria-hidden="true">
        <Icon name="expand" />
      </span>
    </button>
  );
}
