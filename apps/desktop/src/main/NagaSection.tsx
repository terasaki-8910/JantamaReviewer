import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { api, errorMessage } from '../api/tauri';
import type { SessionRecord } from '../api/types';
import { Icon } from './Icon';
import { InfoTip } from './InfoTip';
import {
  NAGA_HELP,
  NAGA_HELP_LABEL,
  NAGA_OPEN_SHORT_LABEL,
  NAGA_REMOVE_LABEL,
  NAGA_SAVE_LABEL,
  NAGA_TITLE,
  NAGA_URL_INVALID,
  NAGA_URL_LABEL,
  NAGA_URL_PLACEHOLDER,
  isNagaUrl,
} from './naga';
import { nagaCommand } from './nagaEdits';
import { useUndo } from './undo/UndoProvider';

interface NagaSectionProps {
  session: SessionRecord;
  /** 保存したあと（取り消し・やり直しのあとも）に、半荘の一覧を読み直す。 */
  reload: () => Promise<void>;
}

/**
 * 半荘のページの「NAGA の結果」の欄（F22 段 2）。結果を取り込んで読めている半荘だけに、局の評価の表の下へ置く。
 * NAGA で解析した結果のページの URL を貼って保存すると、リンクとして出て（いつものブラウザで開く）、半荘を通して見る画面の操作の段にも
 * 「NAGA の結果を開く」が出る。消せる。保存と消去は、取り消せる命令にして（U-11）、Ctrl+Z / Ctrl+Y で戻る・やり直せる。
 * アプリは、この URL にアクセスしない。NAGA のサイトの https の URL だけを受け付ける（Rust 側が決める）。
 */
export function NagaSection({ session, reload }: NagaSectionProps) {
  const undo = useUndo();
  const titleId = useId();
  const errorId = useId();
  const saved = session.naga?.url ?? null;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  // 保存・消去が済んで欄の形が替わったあと、キーボードの位置を移す先（押したボタン・入力欄は、替わると消える）。
  // 消したあとは、入力欄ではなく見出しへ移す（文字を打つ欄の中では、アプリの Ctrl+Z が働かず、消したのを戻せないため）
  const focusNext = useRef<'title' | 'link' | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (target === 'title' ? titleRef : linkRef).current?.focus();
  }, [saved]);

  const run = async (before: string | null, after: string | null, focus: 'title' | 'link') => {
    setBusy(true);
    focusNext.current = focus;
    try {
      await undo.run(nagaCommand(api, reload, { sessionId: session.id, before, after }));
      setError(null);
      setDraft('');
    } catch (failure) {
      focusNext.current = null;
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    // 貼り間違いには、すぐ答える（保存の命令を作らない）。Rust 側も、同じ決まりで確かめる
    if (!isNagaUrl(text)) {
      setError(NAGA_URL_INVALID);
      return;
    }
    void run(null, text, 'link');
  };

  return (
    <section aria-labelledby={titleId} className="naga">
      <div className="sec-head">
        <h2 className="sec-title" id={titleId} ref={titleRef} tabIndex={-1}>
          {NAGA_TITLE}
        </h2>
        <InfoTip label={NAGA_HELP_LABEL}>{NAGA_HELP}</InfoTip>
      </div>
      {saved === null ? (
        <form className="naga-form" noValidate onSubmit={save}>
          <input
            className="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label={NAGA_URL_LABEL}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            placeholder={NAGA_URL_PLACEHOLDER}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
          <button type="submit" className="btn" disabled={busy}>
            {NAGA_SAVE_LABEL}
          </button>
        </form>
      ) : (
        <div className="naga-saved">
          {/* 狭い幅では末尾を省くので、全文は、マウスを乗せたときの説明（title）にも出す */}
          <a className="naga-url" ref={linkRef} href={saved} title={saved} target="_blank" rel="noopener noreferrer">
            {saved}
          </a>
          <div className="naga-acts">
            <a className="btn sm" href={saved} target="_blank" rel="noopener noreferrer">
              <Icon name="external" className="naga-ic" />
              {NAGA_OPEN_SHORT_LABEL}
            </a>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void run(saved, null, 'title')}>
              {NAGA_REMOVE_LABEL}
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <p className="error selectable" id={errorId} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
