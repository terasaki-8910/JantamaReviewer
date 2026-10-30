/**
 * 読みのモデルが入っていないときの案内（F23）。「設定を開く」で設定を開き、「解析のモデル」の欄へ移る。
 * 設定を開く関数は、検討画面のシェル（`App`）が配る（出題・解き直し・通して見る画面のどこからでも使える）。シェルの外では無い（null）。
 * 欄への移動は、設定のページの見出し（「解析のモデル」）を探して、見える所へ動かし、キーボードの位置を移す
 * （設定のページは、設定を読み終えてから欄を描くので、見出しが現れるまで少し待つ）。
 */
import { createContext, useContext } from 'react';

/** 設定の、読みのモデルの欄の見出し。 */
export const MODEL_SECTION_HEADING = '解析のモデル';

/** 設定を開いて、読みのモデルの欄へ移る。 */
export type OpenModelSettings = () => void;

const SettingsLinkContext = createContext<OpenModelSettings | null>(null);

export const SettingsLinkProvider = SettingsLinkContext.Provider;

export function useOpenModelSettings(): OpenModelSettings | null {
  return useContext(SettingsLinkContext);
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';

/** 見出しの文字が `name` の見出し（無ければ null）。 */
function findHeading(name: string, root: ParentNode): HTMLElement | null {
  for (const heading of root.querySelectorAll<HTMLElement>(HEADINGS)) {
    if ((heading.textContent ?? '').trim() === name) return heading;
  }
  return null;
}

/** 見出しを見える所へ動かして、キーボードの位置を移す（見出しは、Tab の止まり場所ではないので、移せるようにする）。 */
function reveal(heading: HTMLElement): void {
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' });
  heading.focus({ preventScroll: true });
}

/**
 * 設定のページの見出し `name` へ移る。まだ描かれていなければ、現れるのを待つ（`timeoutMs` まで）。戻り値は、待つのをやめる関数。
 */
export function focusSettingsSection(name: string, root: ParentNode = document, timeoutMs = 5000): () => void {
  const found = findHeading(name, root);
  if (found !== null) {
    reveal(found);
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    const heading = findHeading(name, root);
    if (heading === null) return;
    observer.disconnect();
    window.clearTimeout(timer);
    reveal(heading);
  });
  const timer = window.setTimeout(() => observer.disconnect(), timeoutMs);
  observer.observe(root instanceof Document ? root.body : (root as Node), { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    window.clearTimeout(timer);
  };
}
