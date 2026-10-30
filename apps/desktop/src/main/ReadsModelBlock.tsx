import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';

import { onReadsModelProgress, readsApi, type ReadsModelProgress, type ReadsModelStatus } from '../api/reads';
import { errorMessage } from '../api/tauri';
import { InfoTip } from './InfoTip';
import {
  CANCELLING_TEXT,
  CANCEL_LABEL,
  CHOOSE_DIALOG_TITLE,
  CHOOSE_LABEL,
  CHOOSING_TEXT,
  DELETE_LABEL,
  DELETING_TEXT,
  DOWNLOAD_LABEL,
  NOT_INSTALLED_TEXT,
  ONNX_FILTER,
  READS_HELP,
  READS_HELP_LABEL,
  READS_ROW_LABEL,
  SECTION_TITLE,
  downloadingText,
  installedText,
  loadFailedText,
  metaText,
} from './readsModelText';

/** 取っている最中の表示を本体の状態に合わせ直す間隔（ミリ秒）。この画面を開き直したときだけ使う。 */
const POLL_MS = 1000;

/** いま、この画面が待っている操作。 */
type Busy = 'download' | 'choose' | 'delete' | null;

/**
 * 設定の「解析のモデル」の欄（F24、U-54）。読みのモデル（`tenpai.onnx`）の状態と出どころを出し、Hugging Face の決まった版を取る
 * （押したときだけ。進み具合と取り消しがある）・自分で取ったファイルを選ぶ・入っているモデルを消す。決まった版（SHA-256）でなければ、
 * 本体が理由を返すので、その文をそのまま出す。通信・ファイルの確かめは、本体（Rust）が行う（ここはコマンドを呼ぶだけ）。
 * 本体の状態が読めない間（試験の偽物など）は、何も出さない。
 */
export function ReadsModelBlock() {
  const [status, setStatus] = useState<ReadsModelStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReadsModelProgress | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttons = useRef<HTMLDivElement>(null);
  // 操作が終わったら、キーボードの位置を、いま押せるボタンへ戻す（押したボタンが、消える・押せなくなるため）
  const refocus = useRef(false);

  // 最初の状態と、取っている間の進み具合の知らせ
  useEffect(() => {
    let alive = true;
    readsApi.getModel().then(
      (next) => {
        if (alive) setStatus(next ?? null);
      },
      (failure: unknown) => {
        if (alive) setLoadError(errorMessage(failure));
      },
    );
    const listening = onReadsModelProgress((next) => {
      if (alive) setProgress(next);
    });
    return () => {
      alive = false;
      void listening.then((stop) => stop());
    };
  }, []);

  const downloading = busy === 'download' || status?.downloading === true;

  // この画面を開いたときに、すでに取っている最中なら（待っている操作は、この画面には無い）、終わるまで本体の状態を読み直す
  const reopened = status?.downloading === true && busy === null;
  useEffect(() => {
    if (!reopened) return undefined;
    const timer = window.setInterval(() => {
      readsApi.getModel().then(
        (next) => {
          if (next) setStatus(next);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reopened]);

  // 操作が終わったあと、押せる最初のボタンに、キーボードの位置を戻す
  useEffect(() => {
    if (!refocus.current || busy !== null) return;
    refocus.current = false;
    buttons.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [busy, status]);

  /** 本体に頼む操作 1 つ。待っている間は、ほかの操作を押せない。失敗したら、理由を出して、状態を読み直す。 */
  const act = useCallback(async (kind: Exclude<Busy, null>, action: () => Promise<ReadsModelStatus>) => {
    setBusy(kind);
    setError(null);
    setProgress(null);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (failure) {
      setError(errorMessage(failure));
      try {
        const latest = await readsApi.getModel();
        if (latest) setStatus(latest);
      } catch {
        // 読み直せなくても、直前の表示のまま、理由だけを出す
      }
    } finally {
      refocus.current = true;
      setBusy(null);
      setCancelling(false);
      setProgress(null);
    }
  }, []);

  const choose = async () => {
    setError(null);
    let picked: string | string[] | null;
    try {
      picked = await open({ title: CHOOSE_DIALOG_TITLE, multiple: false, directory: false, filters: ONNX_FILTER });
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    if (typeof picked !== 'string') return;
    await act('choose', () => readsApi.chooseModelFile(picked));
  };

  const cancel = () => {
    setCancelling(true);
    readsApi.cancelModelDownload().catch((failure: unknown) => {
      setCancelling(false);
      setError(errorMessage(failure));
    });
  };

  if (status === null && loadError === null) return null;

  const installed = status?.installed === true;
  const stateText =
    busy === 'choose'
      ? CHOOSING_TEXT
      : busy === 'delete'
        ? DELETING_TEXT
        : downloading
          ? cancelling
            ? CANCELLING_TEXT
            : downloadingText(progress)
          : installed
            ? installedText(status?.bytes ?? null)
            : NOT_INSTALLED_TEXT;
  const working = busy !== null;

  return (
    <div className="setting" role="group" aria-labelledby="reads-model-title" aria-busy={working || downloading}>
      <div className="ex-head">
        <span className="lbl field-label" id="reads-model-title">
          {SECTION_TITLE}
        </span>
      </div>

      <div className="ex-head">
        <span className="lbl-sm" id="reads-model-name">
          {READS_ROW_LABEL}
        </span>
        <InfoTip label={READS_HELP_LABEL} id="reads-model-help">
          {READS_HELP}
        </InfoTip>
      </div>

      {status !== null && (
        <>
          <p className="selectable" role="status" aria-live="polite" aria-labelledby="reads-model-name">
            {stateText}
          </p>
          <p className="quiet selectable">{metaText(status)}</p>
          <div className="setting-row" ref={buttons}>
            {downloading ? (
              <button type="button" className="btn" disabled={cancelling} aria-describedby="reads-model-help" onClick={cancel}>
                {CANCEL_LABEL}
              </button>
            ) : installed ? (
              <button
                type="button"
                className="btn"
                disabled={working}
                aria-describedby="reads-model-help"
                onClick={() => void act('delete', readsApi.deleteModel)}
              >
                {DELETE_LABEL}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={working}
                  aria-describedby="reads-model-help"
                  onClick={() => void act('download', readsApi.downloadModel)}
                >
                  {DOWNLOAD_LABEL}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={working}
                  aria-describedby="reads-model-help"
                  onClick={() => void choose()}
                >
                  {CHOOSE_LABEL}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {error !== null && (
        <p className="error selectable" role="alert">
          {error}
        </p>
      )}
      {status === null && loadError !== null && (
        <p className="error selectable" role="alert">
          {loadFailedText(loadError)}
        </p>
      )}
    </div>
  );
}
