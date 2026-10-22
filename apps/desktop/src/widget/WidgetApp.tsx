import { useCallback, useEffect, useRef, useState } from 'react';

import { api, errorMessage, onSettingsChanged, onStateChanged } from '../api/tauri';
import type { AppState, Orientation, Rating, Settings } from '../api/types';
import { describeChange } from './announce';
import { signalWindowReady } from '../shared/windowReady';
import { useFlash } from './useFlash';
import { Widget } from './Widget';

/**
 * ウィジェットの本体。記録の状態と形・迷いだけの設定を Rust 側から受け取り、ボタンの操作をコマンドにして送る。
 * 状態が変わるたびに Rust 側が `state-changed` を送るので、割り当てたボタンで付けた迷いマークも
 * ここに反映される。
 */
export function WidgetApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [orientation, setOrientation] = useState<Orientation | null>(null);
  // 迷いだけを記録する（設定）。入なら、窓は 48px 角の「迷い」ボタン 1 つ。設定を受け取るまでは null
  const [doubtOnly, setDoubtOnly] = useState<boolean | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // 最初の状態を受け取れなかったとき。エラー画面（ErrorBoundary）に回す。
  const [fatal, setFatal] = useState<Error | null>(null);
  const [flashing, flash] = useFlash();
  const previous = useRef<AppState | null>(null);

  const accept = useCallback(
    (next: AppState) => {
      const before = previous.current;
      const message = describeChange(before, next);
      if (before && next.mark_count > before.mark_count) flash('doubt');
      previous.current = next;
      setState(next);
      // 同じ内容を 2 度受け取っても（コマンドの返り値とイベント）、読み上げを消さない。
      if (message) setAnnouncement(message);
    },
    [flash],
  );

  useEffect(() => {
    let alive = true;
    const disposers: Array<() => void> = [];
    const track = (listening: Promise<() => void>) => {
      void listening.then((dispose) => {
        if (alive) disposers.push(dispose);
        else dispose();
      });
    };
    const takeSettings = (settings: Settings) => {
      setOrientation(settings.orientation);
      setDoubtOnly(settings.doubt_only === true);
    };
    track(onStateChanged(accept));
    track(onSettingsChanged(takeSettings));
    const fail = (error: unknown) => alive && setFatal(new Error(errorMessage(error)));
    void api
      .getState()
      .then((s) => alive && accept(s))
      .catch(fail);
    void api
      .getSettings()
      .then((s) => alive && takeSettings(s))
      .catch(fail);
    return () => {
      alive = false;
      disposers.forEach((dispose) => dispose());
    };
  }, [accept]);

  // 右クリックで、ネイティブのメニュー（新しい半荘・形の切り替え（迷いだけのときは取り消し）・検討画面・終了）を出す。
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      void api.showWidgetMenu();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);

  const report = useCallback((error: unknown) => setAnnouncement(errorMessage(error)), []);

  const onRate = useCallback(
    (rating: Rating) => {
      flash(`rate-${rating}`);
      void api.addRating(rating).then(accept).catch(report);
    },
    [accept, flash, report],
  );
  const onMark = useCallback(() => {
    flash('doubt');
    void api.addMark().then(accept).catch(report);
  }, [accept, flash, report]);
  const onUndo = useCallback(() => {
    void api.undo().then(accept).catch(report);
  }, [accept, report]);
  // 迷いだけのボタンを、押したまま動かした: 窓を動かす（記録はしない）。
  const onDrag = useCallback(() => {
    void api.startWindowDrag().catch(report);
  }, [report]);

  // 状態と形と迷いだけの設定がそろって、本物の絵が描けるようになったら、窓を見せてよいと知らせる（N-7）。
  const loaded = state !== null && orientation !== null && doubtOnly !== null;
  useEffect(() => {
    if (loaded) void signalWindowReady();
  }, [loaded]);

  if (fatal) throw fatal;
  // 状態を受け取る前に、間違った数字を一瞬出さない。
  if (!state || !orientation || doubtOnly === null) return null;

  return (
    <Widget
      orientation={orientation}
      doubtOnly={doubtOnly}
      state={state}
      flashing={flashing}
      announcement={announcement}
      onRate={onRate}
      onMark={onMark}
      onUndo={onUndo}
      onDrag={onDrag}
    />
  );
}
