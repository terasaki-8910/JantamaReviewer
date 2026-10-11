/**
 * 半荘を通して見る画面のアイコン（Lucide 風の 24px 格子・線画。承認済みの見本と同じ線）。
 * サイドバーなどのアイコン（`../Icon.tsx`）とは別に持つ（この画面だけで使う形）。
 */
import type { ReactNode } from 'react';

const PATHS = {
  /** 局の頭。 */
  kstart: (
    <>
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" x2="5" y1="19" y2="5" />
    </>
  ),
  /** 局の終わり。 */
  kend: (
    <>
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" x2="19" y1="5" y2="19" />
    </>
  ),
  /** 前の巡目。 */
  pturn: (
    <>
      <path d="m11 17-5-5 5-5" />
      <path d="m18 17-5-5 5-5" />
    </>
  ),
  /** 次の巡目。 */
  nturn: (
    <>
      <path d="m6 17 5-5-5-5" />
      <path d="m13 17 5-5-5-5" />
    </>
  ),
  prev: <path d="m15 18-6-6 6-6" />,
  next: <path d="m9 18 6-6-6-6" />,
  down: <path d="m6 9 6 6 6-6" />,
  /** 通して見る（再生）。 */
  play: <path d="M5 3 19 12 5 21z" />,
  keyboard: (
    <>
      <path d="M10 8h.01" />
      <path d="M12 12h.01" />
      <path d="M14 8h.01" />
      <path d="M16 12h.01" />
      <path d="M18 8h.01" />
      <path d="M6 8h.01" />
      <path d="M7 16h10" />
      <path d="M8 12h.01" />
      <rect width="20" height="16" x="2" y="4" rx="2" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
} as const satisfies Record<string, ReactNode>;

export type ReplayIconName = keyof typeof PATHS;

export function ReplayIcon({ name, className }: { name: ReplayIconName; className?: string }) {
  return (
    <svg className={className === undefined ? 'ic' : `ic ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
