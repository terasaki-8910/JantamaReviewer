import { useSyncExternalStore } from 'react';

/** サイドバーがアイコンだけの細い列になる幅（styles/app.css の `@media (width < 640px)` と同じ）。 */
const NARROW_QUERY = '(width < 640px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** 窓が細い（640px 未満）か。 */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}
