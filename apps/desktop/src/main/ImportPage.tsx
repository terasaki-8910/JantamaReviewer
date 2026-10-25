import { useEffect, useRef, useState, type RefObject } from 'react';

import { formatSessionShort } from './format';
import { paipuDateText, shortenMiddle, type ImportSummary } from './importFlow';
import { Icon } from './Icon';
import { marksText, problemText, stepText } from './importText';
import { useDoubtOnly } from './study/StudyProvider';
import { TargetConfirm } from './TargetImport';
import type { ChooseOption, ImportFlow, ImportState } from './useImportFlow';

interface Props {
  flow: ImportFlow;
  /** 取り込んだ半荘を、記録のページで開く。 */
  onOpenSession: (sessionId: string) => void;
}

/**
 * 検討結果を取り込むページ（F1）。承認済みの見本（round7-samples の import）の流れ:
 * 牌譜リンクを見つけた → mjai の窓で Submit を押す → 取り込んでいます → 取り込みました。
 * 見本に無い状態（リンクが無い・半荘を選ぶ・失敗）と、mjai の窓が使えないときの代わりの取り込み方は、同じ静かな書き方で足している。
 */
export function ImportPage({ flow, onOpenSession }: Props) {
  const { state } = flow;
  const heading = useRef<HTMLHeadingElement>(null);
  const [pasted, setPasted] = useState('');

  // ページを開いたとき（牌譜リンクを待つ状態なら）クリップボードを読む。
  // flow は毎回新しい値になりうるので、開いたときの 1 回だけ読む。
  const { refreshClipboard } = flow;
  useEffect(() => {
    void refreshClipboard();
  }, [refreshClipboard]);

  // 状態が変わったら、見出しにキーボードの位置を移す（画面を読み上げる人に、変わったことが伝わるように）。
  useEffect(() => {
    heading.current?.focus();
  }, [state.phase]);

  const showsFallback = state.phase === 'prompt' || state.phase === 'window';

  return (
    <>
      <header className="head">
        <h1 className="title">検討結果を取り込む</h1>
      </header>
      <div className="page">
        <div className="import-flow">
          {state.phase === 'prompt' && state.notice && (
            <p className="notice" role="alert">
              {state.notice}
            </p>
          )}
          <StatePanel
            state={state}
            flow={flow}
            heading={heading}
            onOpenSession={onOpenSession}
          />
          {showsFallback && <Fallback flow={flow} pasted={pasted} onPasted={setPasted} />}
        </div>
      </div>
    </>
  );
}

interface PanelProps {
  state: ImportState;
  flow: ImportFlow;
  heading: RefObject<HTMLHeadingElement | null>;
  onOpenSession: (sessionId: string) => void;
}

function StatePanel({ state, flow, heading, onOpenSession }: PanelProps) {
  switch (state.phase) {
    case 'prompt':
      return flow.link ? (
        <section className="panel" aria-labelledby="import-heading">
          <h2 id="import-heading" ref={heading} tabIndex={-1}>
            <Icon name="link" className="lead-icon" />
            コピーした牌譜リンクを見つけました
          </h2>
          <dl className="kv">
            <dt>リンク</dt>
            <dd>
              <p className="linkline selectable">{linkDisplay(flow.link.url, flow.link.paipuId)}</p>
            </dd>
            <dt>半荘</dt>
            <dd>{halfLabel(flow.link.paipuId)}</dd>
          </dl>
          <div>
            <button type="button" className="btn primary wrap" onClick={() => void flow.startMjai()}>
              mjai で検討する
            </button>
          </div>
          <MortalNote />
        </section>
      ) : (
        <section className="panel" aria-labelledby="import-heading">
          <h2 id="import-heading" ref={heading} tabIndex={-1}>
            <Icon name="link" className="lead-icon" />
            {state.checked ? '牌譜リンクがありません' : 'クリップボードを調べています'}
          </h2>
          {state.checked && (
            <>
              <p role="status">{problemText(state.problem)}</p>
              <p className="quiet">
                雀魂で「牌譜を共有」→「コピー」をしてから、ここに戻ってください。コピーしたリンクは、この窓に戻ったときに、自動で見つけます。
              </p>
              <div>
                <button type="button" className="btn wrap" onClick={() => void flow.refreshClipboard()}>
                  クリップボードを調べ直す
                </button>
              </div>
            </>
          )}
        </section>
      );

    case 'window':
      return (
        <section className="panel" aria-labelledby="import-heading">
          <h2 id="import-heading" ref={heading} tabIndex={-1}>
            <Icon name="external" className="lead-icon" />
            mjai の窓で Submit を押してください
          </h2>
          <p>
            mjai の窓を開いて、牌譜リンクを入れました。窓の Submit を押してください。Cloudflare の確認が出たら、それも通してください。
            結果が出ると、窓は自動で閉じて、取り込みが続きます。AI の答えは、ここには出ません。
          </p>
          <MortalNote />
          <div className="actions">
            <button type="button" className="btn wrap" onClick={() => void flow.showMjaiWindow()}>
              窓を前面に出す
            </button>
            <button type="button" className="btn wrap" onClick={flow.cancel}>
              やめる
            </button>
          </div>
        </section>
      );

    case 'working':
      return (
        <section className="panel" aria-labelledby="import-heading">
          <h2 id="import-heading" ref={heading} tabIndex={-1}>
            <span className="dotc" aria-hidden="true" />
            取り込んでいます
          </h2>
          <p role="status">{stepText(state.step, state.progress)}</p>
          {state.step === 'reading' && state.progress && state.progress.total > 0 && (
            <progress
              className="meter"
              aria-label="画面の読み取りの進み具合"
              value={state.progress.done}
              max={state.progress.total}
            />
          )}
        </section>
      );

    case 'choose':
      return (
        <section className="panel" aria-labelledby="import-heading">
          <h2 id="import-heading" ref={heading} tabIndex={-1}>
            どの半荘の結果か、選んでください
          </h2>
          <p>
            {state.matchingCount >= 2
              ? '記録した画面から読み取った局と点数が合う半荘が、複数あります。結びつける半荘を選んでください。'
              : '記録した半荘のうち、画面から読み取った局と点数がこの結果に合うものが、見つかりませんでした。結びつける半荘を選んでください。'}
          </p>
          <ul className="choices" aria-label="結びつける半荘の一覧（新しい順）">
            {state.options.map((option) => (
              <li key={option.id}>
                <ChoiceRow option={option} onChoose={() => void flow.choose(option.id)} />
              </li>
            ))}
          </ul>
          <div>
            <button type="button" className="btn wrap" onClick={() => void flow.choose(null)}>
              どれでもない（記録の無い半荘として取り込む）
            </button>
          </div>
          {state.warning && (
            <p className="quiet selectable">
              画面の文字認識が使えなかったので、画面からは決められませんでした（{state.warning}）
            </p>
          )}
        </section>
      );

    case 'confirm':
      return (
        <TargetConfirm
          check={state.check}
          label={flow.target?.label ?? null}
          heading={heading}
          onConfirm={() => void flow.confirmTarget()}
          onCancel={flow.cancel}
        />
      );

    case 'done':
      return <DonePanel summary={state.summary} heading={heading} onOpenSession={onOpenSession} />;

    case 'error':
      return (
        <section className="panel" aria-labelledby="import-heading">
          <h2 id="import-heading" ref={heading} tabIndex={-1}>
            <Icon name="alert" className="lead-icon" />
            {state.title}
          </h2>
          <p role="alert" className="selectable">
            {state.message}
          </p>
          <div>
            <button type="button" className="btn wrap" onClick={flow.reset}>
              最初からやり直す
            </button>
          </div>
        </section>
      );
  }
}

/** 牌譜リンクの表示: 雀魂のページと牌譜の ID の前と後ろだけ（アカウントを特定できる末尾の番号は、出さない）。 */
function linkDisplay(url: string, paipuId: string): string {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // 読めなければ、牌譜の ID だけを出す。
  }
  return `${host}/?paipu=${shortenMiddle(paipuId, 11, 4)}`;
}

function halfLabel(paipuId: string): string {
  const date = paipuDateText(paipuId);
  return date === null ? '雀魂の半荘' : `${date}の半荘`;
}

/** mjai の設定は毎回同じにする、という決まり（SPEC F1）。 */
function MortalNote() {
  return (
    <p className="quiet">
      mjai の設定は、サイトの既定のまま（Mortal 4.1b balanced・温度は既定）にしてください。毎回同じ設定にすると、結果を比べられます。
    </p>
  );
}

function ChoiceRow({ option, onChoose }: { option: ChooseOption; onChoose: () => void }) {
  // 迷いだけを記録する設定が入のときは、〇△✕ の数を出さない（F0）
  const doubtOnly = useDoubtOnly();
  return (
    <button type="button" className="choice" onClick={onChoose}>
      <span className="choice-when">{formatSessionShort(option.startedMs)}</span>
      <span className="choice-counts">
        迷い <b>{option.markCount}</b>
        {!doubtOnly && (
          <>
            {' '}
            · 評価 <b>{option.ratingCount}</b>
          </>
        )}
      </span>
      {option.matching && <span className="tag">画面が合う</span>}
    </button>
  );
}

function DonePanel({
  summary,
  heading,
  onOpenSession,
}: {
  summary: ImportSummary;
  heading: RefObject<HTMLHeadingElement | null>;
  onOpenSession: (sessionId: string) => void;
}) {
  const marks = marksText(summary);
  const doubtOnly = useDoubtOnly();
  return (
    <section className="panel" aria-labelledby="import-heading">
      <h2 id="import-heading" ref={heading} tabIndex={-1}>
        <Icon name="check" className="lead-icon" />
        取り込みました
      </h2>
      <dl className="kv wide">
        {summary.room && (
          <>
            <dt>卓</dt>
            <dd>{summary.room}</dd>
          </>
        )}
        <dt>Rating</dt>
        <dd>
          <span className="mono">{summary.ratingText ?? '-'}</span>
          {summary.grade && <span className="grade-note">（{summary.grade}）</span>}
        </dd>
      </dl>
      <p className="counts">
        判断 <b>{summary.decisionCount}</b> · 悪手 <b>{summary.disagreementCount}</b>
        {summary.linkedToRecording && (
          <>
            {' '}
            · 迷い <b>{summary.markCount}</b>
          </>
        )}
        {marks && <span className="quiet">{marks}</span>}
      </p>
      {!summary.linkedToRecording && (
        <p className="quiet">
          {doubtOnly ? '記録の無い半荘として取り込みました。迷いマークは、ありません。' : '記録の無い半荘として取り込みました。迷いマークと評価は、ありません。'}
        </p>
      )}
      {!doubtOnly && summary.linkedToRecording && summary.ratingCount > 0 && (
        <p className="quiet">
          局の評価 {summary.ratingCount} 件のうち、{summary.placedRatings} 件を局に当てはめました。
        </p>
      )}
      {summary.warnings.map((warning) => (
        <p key={warning} className="quiet selectable">
          {warning}
        </p>
      ))}
      <div>
        <button
          type="button"
          className="btn primary wrap"
          onClick={() => onOpenSession(summary.sessionId)}
        >
          {formatSessionShort(summary.startedMs)} の半荘を開く
        </button>
      </div>
    </section>
  );
}

/** mjai の窓が使えないとき・使わないときの、代わりの取り込み方（F1）。静かに、パネルの下に置く。 */
function Fallback({
  flow,
  pasted,
  onPasted,
}: {
  flow: ImportFlow;
  pasted: string;
  onPasted: (text: string) => void;
}) {
  const submit = () => {
    if (pasted.trim() !== '') void flow.submitPastedUrl(pasted);
  };
  return (
    <section className="fallback" aria-labelledby="fallback-heading">
      <h2 className="sec-title" id="fallback-heading">
        mjai の窓を使わずに取り込む
      </h2>
      <div className="field">
        <label htmlFor="pasted-url">mjai の結果の URL</label>
        <div className="setting-row">
          <input
            id="pasted-url"
            className="input paste"
            type="text"
            value={pasted}
            placeholder="結果の URL をここに貼り付け"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onPasted(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
            }}
          />
          <button type="button" className="btn" disabled={pasted.trim() === ''} onClick={submit}>
            この URL で取り込む
          </button>
        </div>
      </div>
      <div>
        <button type="button" className="btn sm" onClick={() => void flow.chooseFile()}>
          結果の JSON ファイルを開く
        </button>
      </div>
    </section>
  );
}


