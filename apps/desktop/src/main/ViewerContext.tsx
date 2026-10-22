/**
 * 迷いの画像の大きな表示（`Lightbox`）を開く関数を、画面のどこからでも使えるように配る。
 * 表示そのもの（開いている間、裏の画面を操作できなくすること・閉じたあとにキーボードの位置を戻すこと）は、検討画面のシェル（`App`）が持つ。
 * 半荘のページの迷いのカードと、出題・通して見る画面の「迷いのスクショ」の欄が使う。シェルの外（部品だけの試験）では、関数は無い（null）。
 */
import { createContext, useContext } from 'react';

import type { ViewerRequest } from './Lightbox';

export type OpenViewer = (request: ViewerRequest) => void;

const ViewerContext = createContext<OpenViewer | null>(null);

export const ViewerProvider = ViewerContext.Provider;

export function useOpenViewer(): OpenViewer | null {
  return useContext(ViewerContext);
}
