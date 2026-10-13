import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, errorMessage, onSyncStatus } from '../api/tauri';
import type { SyncStatus } from '../api/types';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { InfoTip } from './InfoTip';
import {
  ALLOW_DELETE_CONFIRM,
  ALLOW_DELETE_DESCRIPTION,
  ALLOW_DELETE_LABEL,
  ALLOW_DELETE_TITLE,
  CANCEL_LABEL,
  DISCONNECT_CONFIRM,
  DISCONNECT_DESCRIPTION,
  DISCONNECT_LABEL,
  DISCONNECT_TITLE,
  ENABLE_LABEL,
  ENABLE_NEEDS_SETUP,
  NOTHING_TO_SAVE,
  REBUILD_CONFIRM,
  REBUILD_DESCRIPTION,
  REBUILD_LABEL,
  REBUILD_TITLE,
  ROW_DEVICE,
  ROW_STATE,
  ROW_TARGET,
  ROW_TOKEN,
  SAVED_MESSAGE,
  SAVE_LABEL,
  SYNC_HELP,
  SYNC_NOW_LABEL,
  SYNC_TITLE,
  TARGET_NONE,
  TOKEN_HELP,
  TOKEN_LABEL,
  TOKEN_NOT_SAVED,
  TOKEN_PLACEHOLDER_EMPTY,
  TOKEN_PLACEHOLDER_SAVED,
  TOKEN_SAVED,
  URL_HELP,
  URL_LABEL,
  URL_PLACEHOLDER,
  stateLine,
} from './syncText';

interface SyncBlockProps {
  /** 確認を開いている間は true、閉じたら false（呼ぶ側が、裏の画面を `inert` にして、サイドバーのキー操作を止める）。 */
  onModalChange?: (open: boolean) => void;
}

/** 開いている確認。 */
type Ask = 'rebuild' | 'disconnect' | 'allow-delete';

/** 画面に出している知らせか失敗の理由（`seq` は、出すたびに進む番号）。 */
interface Notice {
  text: string;
  seq: number;
}

/**
 * 設定の「同期」の欄（F15、D-4）。同期先の DB の URL とトークンを保存し、この端末で同期を使うかを選び、状態を見て、
 * 「今すぐ同期」「同期用の DB を作り直す」「この端末の同期を切る」を行う。
 * 同期そのもの（通信・突き合わせ）は、Rust 側の裏の担当が行う。ここは、状態の知らせを受けて出すだけ。
 * トークンは、貼った 1 回だけ保存のコマンドに渡し、すぐ欄を空にする（保管庫に入れるのは Rust 側。画面は、持たない）。
 * 作り直し・同期を切る・削除をそのまま同期する、は、確認（既定のボタンは「やめる」）を出す。
 */
export function SyncBlock({ onModalChange }: SyncBlockProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessageText] = useState<Notice | null>(null);
  const [error, setErrorText] = useState<Notice | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const seq = useRef(0);
  const askerRef = useRef<HTMLButtonElement | null>(null);
  const focusAfter = useRef<(() => void) | null>(null);

  // 状態を読み、変わるたびの知らせを受ける
  useEffect(() => {
    let alive = true;
    const disposers: Array<() => void> = [];
    api.getSyncStatus().then(
      (next) => {
        if (alive && next) setStatus(next);
      },
      () => undefined,
    );
    void onSyncStatus((next) => {
      if (alive && next) setStatus(next);
    }).then((dispose) => {
      if (alive) disposers.push(dispose);
      else dispose();
    });
    return () => {
      alive = false;
      disposers.forEach((dispose) => dispose());
    };
  }, []);

  const setMessage = (text: string | null) => {
    seq.current += 1;
    setMessageText(text === null ? null : { text, seq: seq.current });
  };
  const setError = (text: string | null) => {
    seq.current += 1;
    setErrorText(text === null ? null : { text, seq: seq.current });
  };

  // 知らせ・失敗の理由が出たら、そこへキーボードの位置を移す（押したボタンが、処理の間は押せなくなっても、位置が消えないように）
  useEffect(() => {
    if (message !== null) messageRef.current?.focus();
  }, [message]);
  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  // 確認を閉じたあと（裏の画面が操作できるようになってから）、キーボードの位置を戻す
  useEffect(() => {
    if (ask !== null || focusAfter.current === null) return;
    const restore = focusAfter.current;
    focusAfter.current = null;
    restore();
  }, [ask]);

  // 画面が消えるときは、確認が開いていないことを知らせる
  const notify = useRef(onModalChange);
  useEffect(() => {
    notify.current = onModalChange;
  });
  useEffect(
    () => () => {
      notify.current?.(false);
    },
    [],
  );

  const changeAsk = (next: Ask | null) => {
    setAsk(next);
    notify.current?.(next !== null);
  };

  /** 操作を、押せない間（busy）をはさんで行う。失敗は、理由を出す。 */
  const run = useCallback(async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setMessage(null);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveConnection = () => {
    const url = urlDraft.trim();
    const token = tokenDraft.trim();
    if (url === '' && token === '') {
      setMessage(null);
      setError(NOTHING_TO_SAVE);
      return;
    }
    void run(async () => {
      const next = await api.saveSyncConnection(url === '' ? null : url, token === '' ? null : token);
      if (next) setStatus(next);
      // トークンは、保存できたら、すぐ欄から消す（失敗したときは、貼り直さなくていいように、残す）
      setTokenDraft('');
      setUrlDraft('');
      setMessage(SAVED_MESSAGE);
    });
  };

  const toggleEnabled = (enabled: boolean) => {
    void run(async () => {
      const next = await api.setSyncEnabled(enabled);
      if (next) setStatus(next);
      setMessage(null);
    });
  };

  const confirmAsk = () => {
    const kind = ask;
    if (kind === null) return;
    focusAfter.current = () => askerRef.current?.focus();
    changeAsk(null);
    void run(async () => {
      setMessage(null);
      if (kind === 'rebuild') await api.rebuildSyncDb();
      else if (kind === 'allow-delete') await api.allowSyncMassDelete();
      else {
        const next = await api.disconnectSync();
        if (next) setStatus(next);
      }
    });
  };

  const cancelAsk = () => {
    focusAfter.current = () => askerRef.current?.focus();
    changeAsk(null);
  };

  /** 確認を開く。閉じたあと、キーボードの位置を戻す先として、押したボタンを覚える。 */
  const openAsk = (kind: Ask, button: HTMLButtonElement) => {
    askerRef.current = button;
    changeAsk(kind);
  };

  const configured = status !== null && status.url_host !== '';
  const enabled = status?.enabled === true;
  const syncing = status?.state === 'syncing';
  const line = status === null ? null : stateLine(status);
  const dialog =
    ask === 'rebuild'
      ? { title: REBUILD_TITLE, description: REBUILD_DESCRIPTION, confirm: REBUILD_CONFIRM }
      : ask === 'disconnect'
        ? { title: DISCONNECT_TITLE, description: DISCONNECT_DESCRIPTION, confirm: DISCONNECT_CONFIRM }
        : ask === 'allow-delete'
          ? { title: ALLOW_DELETE_TITLE, description: ALLOW_DELETE_DESCRIPTION, confirm: ALLOW_DELETE_CONFIRM }
          : null;

  return (
    <div className="setting" role="group" aria-labelledby="sync-lbl">
      <div className="ex-head">
        <span className="lbl field-label" id="sync-lbl">
          {SYNC_TITLE}
        </span>
        <InfoTip label="同期の説明" id="sync-help">
          {SYNC_HELP}
        </InfoTip>
      </div>

      <div className="sync-fields">
        <div className="sync-field">
          <label htmlFor="sync-url">{URL_LABEL}</label>
          <input
            id="sync-url"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={urlDraft}
            placeholder={URL_PLACEHOLDER}
            aria-describedby="sync-url-help"
            onChange={(event) => setUrlDraft(event.target.value)}
          />
          <p className="quiet" id="sync-url-help">
            {URL_HELP}
          </p>
        </div>
        <div className="sync-field">
          <label htmlFor="sync-token">{TOKEN_LABEL}</label>
          <input
            id="sync-token"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={tokenDraft}
            placeholder={status?.has_token ? TOKEN_PLACEHOLDER_SAVED : TOKEN_PLACEHOLDER_EMPTY}
            aria-describedby="sync-token-help"
            onChange={(event) => setTokenDraft(event.target.value)}
          />
          <p className="quiet" id="sync-token-help">
            {TOKEN_HELP}
          </p>
        </div>
        <div className="setting-row">
          <button type="button" className="btn" disabled={busy} onClick={saveConnection}>
            {SAVE_LABEL}
          </button>
        </div>
      </div>

      <div className="sync-enable">
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !configured}
            aria-describedby="sync-enable-help"
            onChange={(event) => toggleEnabled(event.target.checked)}
          />
          {ENABLE_LABEL}
        </label>
        {(!configured || status?.has_token !== true) && (
          <p className="quiet" id="sync-enable-help">
            {ENABLE_NEEDS_SETUP}
          </p>
        )}
      </div>

      <dl className="ex-dl">
        <div className="ex-row">
          <dt>{ROW_TARGET}</dt>
          <dd>{configured ? <span className="mono">{status?.url_host}</span> : TARGET_NONE}</dd>
        </div>
        <div className="ex-row">
          <dt>{ROW_TOKEN}</dt>
          <dd>{status?.has_token ? TOKEN_SAVED : TOKEN_NOT_SAVED}</dd>
        </div>
        <div className="ex-row">
          <dt>{ROW_STATE}</dt>
          <dd>
            {line !== null && (
              <span
                className={line.tone === 'problem' ? 'error selectable' : 'selectable'}
                role="status"
                aria-live="polite"
              >
                {line.text}
              </span>
            )}
          </dd>
        </div>
        {status !== null && status.device_id !== '' && (
          <div className="ex-row">
            <dt>{ROW_DEVICE}</dt>
            <dd className="mono">{status.device_id}</dd>
          </div>
        )}
      </dl>

      {status !== null && status.warnings.length > 0 && (
        <ul className="quiet sync-warn selectable">
          {status.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="sync-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !enabled || syncing}
          onClick={() => void run(() => api.syncNow())}
        >
          {SYNC_NOW_LABEL}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !enabled || syncing}
          onClick={(event) => openAsk('rebuild', event.currentTarget)}
        >
          {REBUILD_LABEL}
        </button>
        <button type="button" className="btn" disabled={busy || !configured} onClick={(event) => openAsk('disconnect', event.currentTarget)}>
          {DISCONNECT_LABEL}
        </button>
        {status?.can_allow_mass_delete === true && (
          <button type="button" className="btn" disabled={busy} onClick={(event) => openAsk('allow-delete', event.currentTarget)}>
            {ALLOW_DELETE_LABEL}
          </button>
        )}
      </div>

      {message !== null && (
        <p className="ex-msg selectable" role="status" tabIndex={-1} ref={messageRef}>
          <span className="ex-ic">
            <Icon name="check" />
          </span>
          <span>{message.text}</span>
        </p>
      )}
      {error !== null && (
        <p className="error selectable" role="alert" tabIndex={-1} ref={errorRef}>
          {error.text}
        </p>
      )}
      {dialog !== null &&
        createPortal(
          <ConfirmDialog
            title={dialog.title}
            description={dialog.description}
            confirmLabel={dialog.confirm}
            cancelLabel={CANCEL_LABEL}
            onConfirm={confirmAsk}
            onCancel={cancelAsk}
          />,
          document.body,
        )}
    </div>
  );
}
