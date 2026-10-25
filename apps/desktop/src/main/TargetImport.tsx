import { useEffect, useId, useRef, useState, type Ref, type RefObject } from 'react';

import type { SessionRecord } from '../api/types';
import { formatSessionShort } from './format';
import { Icon } from './Icon';
import type { TargetCheck } from './importFlow';
import { marksText, stepText } from './importText';
import type { ImportFlow } from './useImportFlow';

/**
 * 取り込み前の半荘のページから、その半荘に検討結果を取り込む（U-14）。
 * 流れは、取り込みのページと同じ（クリップボードの牌譜リンク → mjai の窓で Submit → 結果の受け取り → 検査 → 画面の読み取り → 保存）だが、
 * - 取り込み先の半荘を決めてあるので、結びつけ先の照合（E-19）はしない
 * - 進み具合は、このページの中に出す（取り込みのページへは移らない）
 * - mjai の窓の題名に、取り込み先の半荘を出す（「10月9日 19:09 の半荘を検討（mjai）」。別の窓に移っても、どの半荘か分かる）
 * - 画面から読んだ局・点数が、結果と合わなかったら、保存の前に聞く（結果は、あとから入れ替えられないため）
 */

/** 取り込み先の半荘の呼び名（画面と mjai の窓の題名に出す）。例: 10月9日 19:09 */
export function targetLabelOf(session: Pick<SessionRecord, 'started_ms'>): string {
  return formatSessionShort(session.started_ms);
}

/** 取り込みが進んでいる間か（窓を開いて待つ・読み取り・保存・半荘を選ぶ・聞いている）。 */
function isBusy(phase: ImportFlow['state']['phase']): boolean {
  return phase === 'window' || phase === 'working' || phase === 'choose' || phase === 'confirm';
}

interface ButtonProps {
  session: Pick<SessionRecord, 'id' | 'started_ms'>;
  flow: ImportFlow;
  /** 始められなかったときの理由（クリップボードに牌譜リンクが無いなど）を、ページに出す。始めたら null。 */
  onNotice: (message: string | null) => void;
  /** ボタン（進み具合の知らせを閉じたあとに、キーボードの位置を戻す先）。 */
  buttonRef?: Ref<HTMLButtonElement>;
}

/** 取り込み前の半荘のページの、主な操作「この半荘に検討結果を取り込む」。 */
export function ImportHereButton({ session, flow, onNotice, buttonRef }: ButtonProps) {
  const [starting, setStarting] = useState(false);
  const busy = isBusy(flow.state.phase);
  const others = busy && flow.target?.sessionId !== session.id;

  const start = async () => {
    onNotice(null);
    setStarting(true);
    try {
      const result = await flow.startForSession({ sessionId: session.id, label: targetLabelOf(session) });
      if (!result.started) onNotice(result.message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="head-act">
      <button
        type="button"
        className="btn primary"
        ref={buttonRef}
        disabled={busy || starting}
        onClick={() => void start()}
      >
        この半荘に検討結果を取り込む
      </button>
      {others && <p className="quiet">ほかの取り込みが進んでいます</p>}
    </div>
  );
}

interface PanelProps {
  flow: ImportFlow;
}

/**
 * 取り込みの進み具合を、半荘のページの中に出す（取り込み先がこの半荘のとき）。
 * mjai の窓で Submit を待つ・読み取りなど取り込んでいる・聞いている（読んだ局・点数が結果と合わない）・失敗・完了。
 */
export function TargetImportPanel({ flow }: PanelProps) {
  const { state, target } = flow;
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  // 状態が変わったら、見出しにキーボードの位置を移す（画面を読み上げる人に、変わったことが伝わるように。取り込みのページと同じ）。
  useEffect(() => {
    heading.current?.focus();
  }, [state.phase]);

  if (target === null) return null;
  const where = <p className="quiet">取り込み先: {target.label} の半荘</p>;

  switch (state.phase) {
    case 'window':
      return (
        <section className="panel inline-import" aria-labelledby={headingId}>
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            <Icon name="external" className="lead-icon" />
            mjai の窓で Submit を押してください
          </h2>
          {where}
          <p>
            mjai の窓を開いて、牌譜リンクを入れました。窓の Submit を押してください。Cloudflare の確認が出たら、それも通してください。
            結果が出ると、窓は自動で閉じて、取り込みが続きます。AI の答えは、ここには出ません。
          </p>
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
        <section className="panel inline-import" aria-labelledby={headingId}>
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            <span className="dotc" aria-hidden="true" />
            取り込んでいます
          </h2>
          {where}
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

    case 'confirm':
      return (
        <TargetConfirm
          check={state.check}
          label={target.label}
          heading={heading}
          headingId={headingId}
          onConfirm={() => void flow.confirmTarget()}
          onCancel={flow.cancel}
        />
      );

    case 'error':
      return (
        <section className="panel inline-import" aria-labelledby={headingId}>
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            <Icon name="alert" className="lead-icon" />
            {state.title}
          </h2>
          {where}
          <p role="alert" className="selectable">
            {state.message}
          </p>
          <div className="actions">
            <button type="button" className="btn wrap" onClick={flow.reset}>
              閉じる
            </button>
          </div>
        </section>
      );

    case 'done': {
      const { summary } = state;
      const marks = marksText(summary);
      return (
        <section className="panel inline-import" aria-labelledby={headingId}>
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            <Icon name="check" className="lead-icon" />
            取り込みました
          </h2>
          {where}
          <p className="counts">
            判断 <b>{summary.decisionCount}</b> · 悪手 <b>{summary.disagreementCount}</b> · 迷い{' '}
            <b>{summary.markCount}</b>
            {marks && <span className="quiet">{marks}</span>}
          </p>
          {summary.warnings.map((warning) => (
            <p key={warning} className="quiet selectable">
              {warning}
            </p>
          ))}
          <div className="actions">
            <button type="button" className="btn wrap" onClick={flow.reset}>
              閉じる
            </button>
          </div>
        </section>
      );
    }

    default:
      return null;
  }
}

/** 読めなかった・合わなかった画面を、いくつまで並べるか（残りは「ほか N 枚」）。 */
const MISMATCH_SHOWN = 6;

interface ConfirmProps {
  check: TargetCheck;
  /** 取り込み先の半荘の呼び名。無ければ「この半荘」。 */
  label: string | null;
  heading: RefObject<HTMLHeadingElement | null>;
  headingId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 画面から読んだ局・点数が、取り込む結果と合わなかったときの確認（U-14）。保存の前に聞く。
 * 取り込んだ結果は、あとから入れ替えられないので、安全なほう（やめる）を主な操作にする。
 */
export function TargetConfirm({ check, label, heading, headingId, onConfirm, onCancel }: ConfirmProps) {
  const generated = useId();
  const id = headingId ?? generated;
  const shown = check.mismatches.slice(0, MISMATCH_SHOWN);
  const rest = check.mismatches.length - shown.length;
  return (
    <section className="panel inline-import" aria-labelledby={id}>
      <h2 id={id} ref={heading} tabIndex={-1}>
        <Icon name="alert" className="lead-icon" />
        画面から読んだ局・点数が、この結果と合いません
      </h2>
      <p>
        記録した画面から読めた {check.readable} 枚のうち、{check.mismatches.length} 枚の局か点数が、取り込む結果と合いません。
        別の半荘の結果を選んだかもしれません。
      </p>
      <ul className="mismatch" aria-label="結果と合わない画面">
        {shown.map((m) => (
          <li key={m.label}>
            <b>{m.label}</b>
            <span>{m.reading}</span>
          </li>
        ))}
        {rest > 0 && <li className="quiet">ほか {rest} 枚</li>}
      </ul>
      <p>
        {label === null ? 'この半荘' : `${label} の半荘`}
        に取り込むと、結果はあとから入れ替えられません。取り込みますか。
      </p>
      <div className="actions">
        <button type="button" className="btn primary wrap" onClick={onCancel}>
          やめる
        </button>
        <button type="button" className="btn wrap" onClick={onConfirm}>
          それでも取り込む
        </button>
      </div>
    </section>
  );
}


