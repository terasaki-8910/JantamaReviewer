import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useId, useRef, useState } from 'react';

import type { DecisionRef } from '@jantama/engine';

import type { MarkRecord } from '../api/types';
import { formatClock } from './format';
import { Icon } from './Icon';
import { chipLabels, decisionOptions, kyokuOptions, markHeading, type ResolvedMark } from './markCards';
import { MenuSelect } from './MenuSelect';

/**
 * 迷いマーク 1 つのカード（F9）。画像（押すと大きく表示。R7-4）・「迷いN」と時刻・結びつけの 1 行目と 2 行目。
 *
 * 結びつけの状態（取り込み前、または結果を読めていないときは、画像と時刻だけ）:
 * - 決まっている: 「東2局1本場 6巡目 · 打牌の迷い」と「自分：打南」（自分が実際にした行動だけ）と、小さな「選び直す」
 * - 候補が複数: 「東2局 11巡目 · 候補が2つ」と、候補の札（実戦の行動）と「選んでください」
 * - 手で選ぶ（読み取れなかった）: 「読み取れませんでした」と「局面を手で選ぶ」（局のメニュー → 判断のメニュー）
 * AI の候補・確率・順位は出さない（SPEC F3。答えを書くまで隠す）。
 *
 * 選んだ瞬間に保存する（`onChoose`。取り消せる）。選んだあとは、「選び直す」にキーボードの位置を移す
 * （選ぶのに使ったボタンは、決まると消えるため）。
 */

/** カードの下の欄の見せ方。`auto` は、結びつけの状態に任せる。 */
type Mode = 'auto' | 'chips' | 'pick';

interface MarkCardProps {
  mark: MarkRecord;
  /** 画面に出す番号（1 から）。 */
  number: number;
  /** 結びつけの状態。取り込み前・結果を読めていないときは null。 */
  resolved: ResolvedMark | null;
  /** 半荘のすべての判断（「局面を手で選ぶ」の選択肢）。 */
  decisions: readonly DecisionRef[];
  /** 画像を大きく表示する。`opener` は、閉じたときにキーボードの位置を戻す先。 */
  onOpenImage: (opener: HTMLElement) => void;
  /** 判断を選んだ（保存して、取り消せる命令にする）。 */
  onChoose: (resolved: ResolvedMark, ref: DecisionRef) => Promise<void>;
}

export function MarkCard({ mark, number, resolved, decisions, onOpenImage, onChoose }: MarkCardProps) {
  const clock = formatClock(mark.t_ms);
  const labelId = useId();
  return (
    <article className="mcard" aria-labelledby={labelId}>
      {mark.screenshot_path ? (
        <button
          type="button"
          className="mthumb"
          aria-label={`迷い${number}の画像を大きく見る`}
          onClick={(event) => onOpenImage(event.currentTarget)}
        >
          <img
            className="thumb"
            src={convertFileSrc(mark.screenshot_path)}
            alt={`迷い${number}のスクリーンショット`}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
          <span className="zoom" aria-hidden="true">
            <Icon name="expand" />
          </span>
        </button>
      ) : (
        <div className="mthumb-empty" title={mark.capture_error ?? undefined}>
          画像なし
        </div>
      )}
      <div className="mbody">
        <div className="mtop">
          <h3 className="mlabel" id={labelId}>
            迷い{number}
          </h3>
          <span className="mclock">{clock}</span>
        </div>
        {resolved !== null && <LinkArea number={number} resolved={resolved} decisions={decisions} onChoose={onChoose} />}
      </div>
    </article>
  );
}

interface LinkAreaProps {
  number: number;
  resolved: ResolvedMark;
  decisions: readonly DecisionRef[];
  onChoose: (resolved: ResolvedMark, ref: DecisionRef) => Promise<void>;
}

/** カードの下の、結びつけの欄。 */
function LinkArea({ number, resolved, decisions, onChoose }: LinkAreaProps) {
  const { resolution, autoCandidates } = resolved;
  const [mode, setMode] = useState<Mode>('auto');
  const [pickedKyoku, setPickedKyoku] = useState<number | null>(null);
  const promptId = useId();
  const rechooseRef = useRef<HTMLButtonElement>(null);
  const focusRechoose = useRef(false);

  const linked = resolution.kind === 'linked' ? resolution : null;
  const hasCandidates = autoCandidates.length >= 2;
  const labels = chipLabels(autoCandidates);
  // いまの見せ方: 決まっていて選び直していないとき `view`。それ以外は、札か、手で選ぶ欄。
  const view: 'view' | 'chips' | 'pick' =
    mode === 'chips' && hasCandidates
      ? 'chips'
      : mode === 'pick'
        ? 'pick'
        : linked !== null
          ? 'view'
          : resolution.kind === 'candidates'
            ? 'chips'
            : 'pick';

  // 決まって「選び直す」が出たら、選ぶのに使ったボタンの代わりに、キーボードの位置をそこへ移す。
  useEffect(() => {
    if (view === 'view' && focusRechoose.current) {
      focusRechoose.current = false;
      rechooseRef.current?.focus();
    }
  }, [view]);

  const choose = async (ref: DecisionRef) => {
    if (linked?.saved && linked.ref.key === ref.key) {
      // 同じ判断を選んだだけ。保存し直さず、閉じる。
      setMode('auto');
      setPickedKyoku(null);
      focusRechoose.current = true;
      return;
    }
    // 決まって「選び直す」が出たら、そこへキーボードの位置を移す（保存と描き直しが、先に終わることがあるので、先に印を付ける）。
    focusRechoose.current = true;
    try {
      await onChoose(resolved, ref);
    } catch {
      // 失敗の理由は、取り消しの積み重ねの知らせが通知に出す。この欄は、選ぶ前のまま。
      focusRechoose.current = false;
      return;
    }
    setMode('auto');
    setPickedKyoku(null);
  };

  const startRechoose = () => {
    setPickedKyoku(null);
    setMode(hasCandidates ? 'chips' : 'pick');
  };
  const cancel = () => {
    setMode('auto');
    setPickedKyoku(null);
    focusRechoose.current = true;
  };

  return (
    <>
      <p className="mwhat">{markHeading(resolved)}</p>
      {view === 'view' && linked !== null && (
        <p className="msub">
          <span>自分：{linked.ref.actionLabel}</span>
          <button type="button" className="link-btn" ref={rechooseRef} aria-label={`迷い${number}を選び直す`} onClick={startRechoose}>
            選び直す
          </button>
        </p>
      )}
      {view === 'chips' && (
        <div className="mctl">
          <fieldset className="chips" aria-describedby={promptId}>
            <legend className="sr-only">迷い{number}の候補</legend>
            {autoCandidates.map((candidate, i) => (
              <button
                key={candidate.key}
                type="button"
                className="chip"
                aria-pressed={linked?.ref.key === candidate.key}
                onClick={() => void choose(candidate)}
              >
                {labels[i]}
              </button>
            ))}
          </fieldset>
          <span className="mprompt" id={promptId}>
            選んでください
          </span>
          <button type="button" className="link-btn" aria-label={`迷い${number}の局面を手で選ぶ`} onClick={() => setMode('pick')}>
            手で選ぶ
          </button>
          {linked !== null && (
            <button type="button" className="link-btn" onClick={cancel}>
              やめる
            </button>
          )}
        </div>
      )}
      {view === 'pick' && (
        <PickArea
          number={number}
          decisions={decisions}
          kyoku={pickedKyoku ?? linked?.ref.kyokuPosition ?? null}
          current={linked?.ref ?? null}
          onKyoku={setPickedKyoku}
          onDecision={(ref) => void choose(ref)}
          onBackToChips={hasCandidates ? () => setMode('chips') : null}
          onCancel={linked !== null ? cancel : null}
        />
      )}
    </>
  );
}

interface PickAreaProps {
  number: number;
  decisions: readonly DecisionRef[];
  /** 選んである局（review.kyokus の添字）。無ければ null。 */
  kyoku: number | null;
  /** いま結びついている判断（選び直すとき）。 */
  current: DecisionRef | null;
  onKyoku: (position: number) => void;
  onDecision: (ref: DecisionRef) => void;
  onBackToChips: (() => void) | null;
  onCancel: (() => void) | null;
}

/** 「局面を手で選ぶ」: 局のメニュー → 判断のメニュー（選んだ瞬間に決まる）。 */
function PickArea({ number, decisions, kyoku, current, onKyoku, onDecision, onBackToChips, onCancel }: PickAreaProps) {
  const kyokus = kyokuOptions(decisions);
  const kyokuLabel = kyokus.find((option) => option.position === kyoku)?.label ?? null;
  const options = kyoku === null ? [] : decisionOptions(decisions, kyoku);
  const currentOption = options.find((option) => option.key === current?.key) ?? null;
  return (
    <div className="mctl">
      <span className="mpick-lbl">局面を手で選ぶ</span>
      <MenuSelect
        className="sel-btn"
        label={`迷い${number}の局${kyokuLabel === null ? '（未選択）' : `（${kyokuLabel}）`}`}
        menuLabel={`迷い${number}の局`}
        items={kyokus.map((option) => ({
          key: String(option.position),
          label: option.label,
          checked: option.position === kyoku,
          onSelect: () => onKyoku(option.position),
        }))}
      >
        <span className={kyokuLabel === null ? 'sel-v sel-ph' : 'sel-v'}>{kyokuLabel ?? '局'}</span>
        <Icon name="chevronDown" className="sel-ic" />
      </MenuSelect>
      <MenuSelect
        className="sel-btn"
        label={`迷い${number}の判断${currentOption === null ? '' : `（${currentOption.label}）`}`}
        menuLabel={`迷い${number}の判断`}
        disabled={kyoku === null}
        items={options.map((option) => ({
          key: option.key,
          label: option.label,
          checked: option.key === current?.key,
          onSelect: () => onDecision(option.ref),
        }))}
      >
        <span className={currentOption === null ? 'sel-v sel-ph' : 'sel-v'}>{currentOption?.label ?? '判断'}</span>
        <Icon name="chevronDown" className="sel-ic" />
      </MenuSelect>
      {onBackToChips !== null && (
        <button type="button" className="link-btn" onClick={onBackToChips}>
          候補から選ぶ
        </button>
      )}
      {onCancel !== null && (
        <button type="button" className="link-btn" onClick={onCancel}>
          やめる
        </button>
      )}
    </div>
  );
}
