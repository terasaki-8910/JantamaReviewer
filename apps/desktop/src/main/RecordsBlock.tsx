import { open, save } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, errorMessage } from '../api/tauri';
import type { RecordsOverview, RecordsPreview } from '../api/types';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { InfoTip } from './InfoTip';
import {
  CONFIRM_TITLE,
  RECORDS_EXCLUDED,
  RECORDS_HELP,
  RECORDS_INCLUDES,
  countsText,
  defaultRecordsName,
  exportedMessage,
  fileNameOf,
  formatSize,
  heldSentence,
  importedMessage,
} from './recordsText';

const JSON_FILTER = [{ name: '記録のファイル（JSON）', extensions: ['json'] }];

interface RecordsBlockProps {
  /**
   * 読み込む前の確認を開いている間は true、閉じたら false（呼ぶ側が、裏の画面を `inert` にして、サイドバーのキー操作を止める）。
   */
  onModalChange?: (open: boolean) => void;
  /** 記録を置き換えたあとに呼ぶ。呼ぶ側は、画面のデータを読み直す（知らせの文を、読み直したあとの画面にも出す）。 */
  onReplaced?: (message: string) => void;
  /** 画面を読み直したあとに、最初から出しておく知らせ（読み込んだあとの「読み込みました…」）。 */
  initialNotice?: string | null;
}

/** 画面に出している知らせか失敗の理由（`seq` は、出すたびに進む番号）。 */
interface Notice {
  text: string;
  seq: number;
}

/** 確認を出している読み込み（選んだファイルと、確かめた中身の数）。 */
interface PendingImport {
  path: string;
  name: string;
  preview: RecordsPreview;
}

/**
 * 設定の「記録の書き出し」の欄（D-2、R11-14。承認済みの見本 export-a）。
 * 「書き出す」は保存のダイアログで場所を選んで、記録を 1 つの JSON に書く。「読み込む」は、ファイルを選ぶダイアログで選んだファイルを
 * 全部確かめてから、確認（既定のボタンは「やめる」）を出し、「置き換える」で、いまの記録をそのファイルの内容に置き換える。
 * ファイルの読み書きと確かめは、Rust 側が行う（ここは、ダイアログで選んだパスを渡すだけ）。
 */
export function RecordsBlock({ onModalChange, onReplaced, initialNotice = null }: RecordsBlockProps) {
  const [overview, setOverview] = useState<RecordsOverview | null>(null);
  // 知らせと失敗の理由は、出すたびに番号を進める（同じ文でも、キーボードの位置をそこへ移し直し、読み上げ直すため）
  const [message, setMessageText] = useState<Notice | null>(
    initialNotice === null ? null : { text: initialNotice, seq: 0 },
  );
  const [error, setErrorText] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<PendingImport | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const seq = useRef(0);
  const importRef = useRef<HTMLButtonElement>(null);
  // 確認を閉じたあと（裏の画面が操作できるようになってから）、キーボードの位置を戻す先
  const focusAfter = useRef<'import' | null>(null);

  const reloadOverview = useCallback(() => {
    api.recordsOverview().then(
      (next) => setOverview(next ?? null),
      () => setOverview(null),
    );
  }, []);

  useEffect(() => {
    reloadOverview();
  }, [reloadOverview]);

  const setMessage = (text: string | null) => {
    seq.current += 1;
    setMessageText(text === null ? null : { text, seq: seq.current });
  };
  const setError = (text: string | null) => {
    seq.current += 1;
    setErrorText(text === null ? null : { text, seq: seq.current });
  };

  // 知らせ・失敗の理由が出たら、そこへキーボードの位置を移す（押したボタンは、処理の間は押せないので、位置が消えないように）
  useEffect(() => {
    if (message !== null) messageRef.current?.focus();
  }, [message]);
  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  // 確認を閉じたあと、キーボードの位置を戻す
  useEffect(() => {
    if (ask !== null || focusAfter.current === null) return;
    focusAfter.current = null;
    importRef.current?.focus();
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

  const changeAsk = (next: PendingImport | null) => {
    setAsk(next);
    notify.current?.(next !== null);
  };

  const startExport = async () => {
    setError(null);
    let path: string | null;
    try {
      path = await save({
        title: '記録を書き出す',
        defaultPath: defaultRecordsName(new Date()),
        filters: JSON_FILTER,
      });
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    if (typeof path !== 'string') return;
    setBusy(true);
    try {
      const report = await api.exportRecords(path);
      setMessage(exportedMessage(fileNameOf(report.path), report.bytes));
    } catch (failure) {
      setMessage(null);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const startImport = async () => {
    setError(null);
    let path: string | null;
    try {
      const picked = await open({
        title: '記録のファイルを選ぶ',
        multiple: false,
        directory: false,
        filters: JSON_FILTER,
      });
      path = typeof picked === 'string' ? picked : null;
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    if (path === null) return;
    setBusy(true);
    try {
      // ファイルを全部確かめる（正しくなければ、確認は出さず、理由を出す）
      const preview = await api.inspectRecordsFile(path);
      setMessage(null);
      changeAsk({ path, name: fileNameOf(path), preview });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancelImport = () => {
    focusAfter.current = 'import';
    changeAsk(null);
  };

  const confirmImport = async () => {
    if (ask === null) return;
    const { path } = ask;
    focusAfter.current = 'import';
    changeAsk(null);
    setBusy(true);
    try {
      const report = await api.importRecords(path);
      const text = importedMessage(report);
      setMessage(text);
      if (onReplaced) onReplaced(text);
      else reloadOverview();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const name = defaultRecordsName(new Date());
  const held = ask === null ? null : heldSentence(ask.preview.held);

  return (
    <div className="setting" role="group" aria-labelledby="export-lbl">
      <div className="ex-head">
        <span className="lbl field-label" id="export-lbl">
          記録の書き出し
        </span>
        <InfoTip label="記録の書き出しの説明" id="export-help">
          {RECORDS_HELP}
        </InfoTip>
      </div>
      <div className="setting-row">
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-describedby="export-help"
          onClick={() => void startExport()}
        >
          書き出す
        </button>
        <button
          type="button"
          className="btn"
          ref={importRef}
          disabled={busy}
          aria-describedby="export-help"
          onClick={() => void startImport()}
        >
          読み込む
        </button>
      </div>
      <dl className="ex-dl">
        <div className="ex-row">
          <dt>含まれるもの</dt>
          <dd>{RECORDS_INCLUDES}</dd>
        </div>
        <div className="ex-row">
          <dt>ファイル</dt>
          <dd>
            <span className="mono">{name}</span>（1つ{overview !== null && `・${formatSize(overview.bytes)}`}）
          </dd>
        </div>
      </dl>
      <p className="quiet ex-not">{RECORDS_EXCLUDED}</p>
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
      {ask !== null &&
        createPortal(
          <ConfirmDialog
            title={CONFIRM_TITLE}
            description={
              <>
                <span className="mono ex-file">{ask.name}</span>
                <br />
                いまの記録を、このファイルの内容に置き換えます
                <span className="nw">{countsText(ask.preview)}</span>。元には戻せません。
                {held !== null && (
                  <>
                    <br />
                    <span className="ex-held">{held}</span>
                  </>
                )}
              </>
            }
            confirmLabel="置き換える"
            cancelLabel="やめる"
            onConfirm={() => void confirmImport()}
            onCancel={cancelImport}
          />,
          document.body,
        )}
    </div>
  );
}
