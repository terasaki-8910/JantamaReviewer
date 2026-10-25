import { useId, useRef } from 'react';

import { sameVersion, shouldOfferUpdate } from './updateDecision';
import { useUpdate, type UpdateValue } from './UpdateProvider';
import {
  CHECKING_TEXT,
  CHECK_LABEL,
  FAILED_TEXT,
  INSTALLING_TEXT,
  INSTALL_LABEL,
  LATER_LABEL,
  LATER_NOTE,
  NOT_CHECKED_TEXT,
  NOT_CONFIGURED_TEXT,
  RECORDING_REASON,
  ROW_CURRENT,
  ROW_RESULT,
  SKIPPED_NOTE,
  SKIP_LABEL,
  UPDATE_TITLE,
  UP_TO_DATE_TEXT,
  foundText,
} from './updateText';

/** 結果の行に出す文。`problem` は確かめられなかったとき（理由つき）。 */
interface ResultLine {
  text: string;
  reason?: string;
  tone: 'normal' | 'quiet' | 'problem';
}

function resultLine(update: UpdateValue): ResultLine {
  const { view, installing, info } = update;
  if (installing) return { text: INSTALLING_TEXT, tone: 'normal' };
  switch (view.kind) {
    case 'none':
      return { text: NOT_CHECKED_TEXT, tone: 'quiet' };
    case 'checking':
      return { text: CHECKING_TEXT, tone: 'quiet' };
    case 'up_to_date':
      return { text: UP_TO_DATE_TEXT, tone: 'normal' };
    case 'not_configured':
      return { text: NOT_CONFIGURED_TEXT, tone: 'quiet' };
    case 'failed':
      return { text: FAILED_TEXT, reason: view.message, tone: 'problem' };
    case 'available': {
      // 「あとで」を押した版・飛ばした版でも、設定から確かめたときは、新しい版があることを伝える
      const skipped = info !== null && !shouldOfferUpdate(info.current_version, view.version, update.skipped);
      const later = update.later !== null && sameVersion(update.later, view.version);
      const note = skipped ? SKIPPED_NOTE : later ? LATER_NOTE : '';
      return { text: `${foundText(view.version)}${note}`, tone: 'normal' };
    }
  }
}

/**
 * 設定の「更新」の欄（F21、U-51）。今の版と、最後に確かめた結果（最新です／新しい版があります／確かめられませんでした／まだ設定されていません）、
 * 「更新を確かめる」。新しい版があるときは、更新の帯と同じ「今すぐ入れ直す」「あとで」「この版は飛ばす」を出す。
 * 設定のページを開いている間は、帯は出さない（この欄が、同じ案内を出す）。確かめるのは、押したときだけ（起動のときの確かめは、シェルの外で済ませてある）。
 */
export function UpdateBlock() {
  const update = useUpdate();
  const reasonId = useId();
  const checkRef = useRef<HTMLButtonElement>(null);
  if (update === null || update.info === null) return null;
  const { info, view, installing, recording, error } = update;
  const line = resultLine(update);
  const available = view.kind === 'available' ? view : null;
  const skipped = available !== null && !shouldOfferUpdate(info.current_version, available.version, update.skipped);
  const later = available !== null && update.later !== null && sameVersion(update.later, available.version);
  const blocked = available !== null && recording && !installing;
  return (
    <div className="setting" role="group" aria-labelledby="update-lbl">
      <div className="ex-head">
        <span className="lbl field-label" id="update-lbl">
          {UPDATE_TITLE}
        </span>
      </div>

      <dl className="ex-dl">
        <div className="ex-row">
          <dt>{ROW_CURRENT}</dt>
          <dd className="mono">{info.current_version}</dd>
        </div>
        <div className="ex-row">
          <dt>{ROW_RESULT}</dt>
          <dd>
            <span
              className={line.tone === 'problem' ? 'error selectable' : line.tone === 'quiet' ? 'quiet selectable' : 'selectable'}
              role="status"
              aria-live="polite"
            >
              {line.text}
              {line.reason !== undefined && <span className="update-reason selectable">{line.reason}</span>}
            </span>
          </dd>
        </div>
      </dl>

      <div className="setting-row">
        <button
          type="button"
          className="btn"
          ref={checkRef}
          disabled={installing}
          onClick={() => {
            if (view.kind !== 'checking') void update.checkNow();
          }}
        >
          {CHECK_LABEL}
        </button>
        {available !== null && (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={installing || recording}
              aria-describedby={blocked ? reasonId : undefined}
              onClick={() => void update.install()}
            >
              {INSTALL_LABEL}
            </button>
            {!skipped && !later && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={installing}
                  onClick={() => {
                    update.postpone();
                    checkRef.current?.focus();
                  }}
                >
                  {LATER_LABEL}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={installing}
                  onClick={() => void update.skip().then(() => checkRef.current?.focus())}
                >
                  {SKIP_LABEL}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {blocked && (
        <p className="quiet" id={reasonId}>
          {RECORDING_REASON}
        </p>
      )}
      {error !== null && (
        <p className="error selectable" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
