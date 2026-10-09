import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 押した直後にボタンを光らせるための状態。キーごとに一定時間だけ true になる。
 * 光らせたあとの戻し忘れ（アンマウント後の更新）が起きないよう、タイマーは後始末する。
 */
export function useFlash(durationMs = 380) {
  const [active, setActive] = useState<Record<string, boolean>>({});
  const timers = useRef(new Map<string, number>());

  const flash = useCallback(
    (key: string) => {
      setActive((current) => ({ ...current, [key]: true }));
      const pending = timers.current.get(key);
      if (pending !== undefined) window.clearTimeout(pending);
      timers.current.set(
        key,
        window.setTimeout(() => {
          setActive((current) => ({ ...current, [key]: false }));
          timers.current.delete(key);
        }, durationMs),
      );
    },
    [durationMs],
  );

  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      pendingTimers.forEach((id) => window.clearTimeout(id));
      pendingTimers.clear();
    };
  }, []);

  return [active, flash] as const;
}
