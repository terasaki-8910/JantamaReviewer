import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';

import type { DecisionRef } from '@jantama/engine';

import type { MarkRecord } from '../api/types';
import { formatClock } from './format';
import { Icon } from './Icon';
import {
  ESTIMATE_TAG,
  alternativesOf,
  chipLabels,
  decisionOptions,
  farChipLabels,
  farLine,
  isEstimated,
  kyokuChoices,
  kyokuOptions,
  markHeading,
  readingLine,
  type ResolvedMark,
} from './markCards';
import { MenuSelect } from './MenuSelect';
import { ReplayIcon } from './replay/ReplayIcons';

/**
 * 迷いマーク 1 つのカード（F9、U-13）。画像（押すと大きく表示。R7-4）・「迷いN」と時刻・結びつけの欄。
 *
 * どの状態も、同じ構成で書く（取り込み前、または結果を読めていないときは、画像と時刻だけ）:
 * 1 行目「迷いN」と時刻 / 2 行目 局面（「東2局1本場 6巡目 · 打牌の迷い」） / 静かな 1 行 スクショから読んだ値
 * （「スクショ: 東2局・残り47・15,100点」か「スクショを読めませんでした」。崩れた部分は「読めず」） /
 * 局をどう決めたかの 1 文（読み取りが崩れていた・前後の評価と迷いの時刻から決めたものだけ） / 状態ごとの欄:
 * - 推定（自動で、1 位の判断に結びつけた）: 「推定」の印・「自分：打南」（自分が実際にした行動だけ）・小さな「選び直す」。
 *   近い判断があれば、その下に「ほかの候補」の札（押すと、その判断に替わる。取り消せる）
 * - 利用者が選んだ: 「推定」の印は無い。「自分：打南」と「選び直す」。選んだ判断が、スクショから読んだ値から離れている
 *   （推定にもほかの候補にも入らない。E-27）ときは、その下に、警告のアイコンつきの 1 行（「スクショの値（残り38）と離れています。
 *   選んだ局面は残り29です。」）と、「ほかの候補」の札（推定には「（推定）」を足す。押すと、その判断に替わる。取り消せる）
 * - 局だけ分かった（残り枚数が読めない・読めないが前後の評価と迷いから局が分かる。E-30、U-24）: 2 行目は「東4局 · 巡目は決まっていません」。
 *   局をどう決めたかの 1 文の下に、「手で選ぶ」（局のメニュー → 判断のメニュー）。選び肢は、局の幅の中の判断だけ
 *   （局が 1 つなら、局は選んである）
 * - 手で選ぶ（読めない・合う局が無い）: 「手で選ぶ」（局のメニュー → 判断のメニュー。半荘のすべての判断から）
 * 結びつけの欄の下に、終局直後のメモの欄（`memo`。「候補」「理由（1行）」。F4、U-28）。取り込む前の半荘のカードにも出る。
 * 判断が決まっているカードには、下端に「この局面を解く」を置く（押すと、半荘を通して見る画面を、その局面で開く。F9・F12）。
 * 局面が決まっていない（手で選ぶ）カードには、置かない。
 *
 * 局の評価の表の「迷い」の札を押すと、このカードへ移る（U-27）。そのため、カードは、キーボードの位置を受けられ（`tabIndex=-1`）、
 * 移ったあとの少しの間は、目立たせる（`flash`）。
 * AI の候補・確率・順位は出さない（SPEC F3。答えを書くまで隠す）。
 *
 * 選んだ瞬間に保存する（`onChoose`。取り消せる）。選んだあとは、「選び直す」にキーボードの位置を移す
 * （選ぶのに使ったボタンは、決まると消えるため）。
 */

/** 迷いのカードの要素の名前（局の評価の表の札から移る先。画面に 1 つの半荘だけなので、番号で足りる）。 */
export function markCardId(number: number): string {
  return `mark-card-${number}`;
}

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
  /** 「この局面を解く」（結びついた判断の鍵で、半荘を通して見る画面を開く）。渡さなければ、ボタンは出さない。 */
  onSolve?: (decisionKey: string) => void;
  /** 終局直後のメモの欄（結びつけの欄の下に出す）。 */
  memo?: ReactNode;
  /** 局の評価の表の札から移ってきた直後で、目立たせているか。 */
  flash?: boolean;
  /** カード自身（札から移るときに、キーボードの位置を移す先）。 */
  cardRef?: Ref<HTMLElement>;
}

export function MarkCard({ mark, number, resolved, decisions, onOpenImage, onChoose, onSolve, memo, flash = false, cardRef }: MarkCardProps) {
  const clock = formatClock(mark.t_ms);
  const labelId = useId();
  return (
    <article
      className={flash ? 'mcard is-flash' : 'mcard'}
      id={markCardId(number)}
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={labelId}
    >
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
        {memo}
        {resolved !== null && resolved.resolution.kind === 'linked' && onSolve !== undefined && (
          <div className="msolve">
            <button
              type="button"
              className="btn tonal solve"
              aria-label={`この局面を解く（迷い${number}）`}
              onClick={() => onSolve(resolved.resolution.kind === 'linked' ? resolved.resolution.ref.key : '')}
            >
              <ReplayIcon name="play" />
              この局面を解く
            </button>
          </div>
        )}
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

/**
 * カードの下の欄の、いまの見せ方。決まっていて、選び直していないとき `view`。それ以外は、選び直しの札（`chips`）か、
 * 手で選ぶ欄（`pick`）。`mode` が `auto` のときは、結びつけの状態に任せる（決まっていれば `view`、決まっていなければ `pick`）。
 */
function viewOf(mode: Mode, hasCandidates: boolean, resolution: ResolvedMark['resolution']): 'view' | 'chips' | 'pick' {
  if (mode === 'chips' && hasCandidates) return 'chips';
  if (mode === 'pick') return 'pick';
  return resolution.kind === 'linked' ? 'view' : 'pick';
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
  // 離れているとき（E-27）は、札の先頭（推定）に「（推定）」を足す（「選び直す」の札にも、同じ文字を使う）。
  const farText = farLine(resolved);
  const labels = farText === null ? chipLabels(autoCandidates) : farChipLabels(autoCandidates);
  const estimated = isEstimated(resolved);
  const alternatives = alternativesOf(resolved);
  const view = viewOf(mode, hasCandidates, resolution);
  // 局だけ分かった迷いは、局の幅の中の判断だけから選ぶ。局が 1 つに決まっていれば、局は選んである
  const kyokuOnly = resolution.kind === 'kyoku';
  const pickable = kyokuOnly ? kyokuChoices(resolved) : decisions;
  const onlyKyoku = kyokuOnly ? (kyokuOptions(pickable).length === 1 ? (kyokuOptions(pickable)[0]?.position ?? null) : null) : null;

  // 決まって「選び直す」が出たら、選ぶのに使ったボタンの代わりに、キーボードの位置をそこへ移す
  // （候補の札を押して、推定から選んだ状態に替わったときは、見せ方は `view` のままなので、決まった判断が変わったときにも移す）。
  const linkedKey = linked?.ref.key;
  const linkedSaved = linked?.saved;
  useEffect(() => {
    if (view === 'view' && focusRechoose.current) {
      focusRechoose.current = false;
      rechooseRef.current?.focus();
    }
  }, [view, linkedKey, linkedSaved]);

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
      <p className="mread">{readingLine(resolved)}</p>
      {resolved.howText !== null && <p className="mhow">{resolved.howText}</p>}
      {view === 'view' && linked !== null && (
        <>
          <p className="msub">
            <span className="mact">
              {estimated && <span className="tag est">{ESTIMATE_TAG}</span>}
              <span>自分：{linked.ref.actionLabel}</span>
            </span>
            <button type="button" className="link-btn" ref={rechooseRef} aria-label={`迷い${number}を選び直す`} onClick={startRechoose}>
              選び直す
            </button>
          </p>
          {estimated && alternatives.length > 0 && (
            <div className="malt">
              <span className="malt-lbl" aria-hidden="true">
                ほかの候補
              </span>
              <fieldset className="chips">
                <legend className="sr-only">迷い{number}のほかの候補</legend>
                {alternatives.map((candidate, i) => (
                  <button key={candidate.key} type="button" className="chip" aria-pressed={false} onClick={() => void choose(candidate)}>
                    {labels[i + 1]}
                  </button>
                ))}
              </fieldset>
            </div>
          )}
          {farText !== null && (
            <>
              <p className="mfar">
                <Icon name="alert" className="mfar-ic" />
                <span>{farText}</span>
              </p>
              <div className="malt">
                <span className="malt-lbl" aria-hidden="true">
                  ほかの候補
                </span>
                <fieldset className="chips">
                  <legend className="sr-only">迷い{number}のほかの候補</legend>
                  {autoCandidates.map((candidate, i) => (
                    <button key={candidate.key} type="button" className="chip" aria-pressed={false} onClick={() => void choose(candidate)}>
                      {labels[i]}
                    </button>
                  ))}
                </fieldset>
              </div>
            </>
          )}
        </>
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
            <button type="button" className="link-btn" aria-label={`迷い${number}の選び直しをやめる`} onClick={cancel}>
              やめる
            </button>
          )}
        </div>
      )}
      {view === 'pick' && (
        <PickArea
          number={number}
          decisions={pickable}
          kyoku={pickedKyoku ?? linked?.ref.kyokuPosition ?? onlyKyoku}
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

/** 「手で選ぶ」: 局のメニュー → 判断のメニュー（選んだ瞬間に決まる）。 */
function PickArea({ number, decisions, kyoku, current, onKyoku, onDecision, onBackToChips, onCancel }: PickAreaProps) {
  const kyokus = kyokuOptions(decisions);
  const kyokuLabel = kyokus.find((option) => option.position === kyoku)?.label ?? null;
  const options = kyoku === null ? [] : decisionOptions(decisions, kyoku);
  const currentOption = options.find((option) => option.key === current?.key) ?? null;
  return (
    <div className="mctl">
      <span className="mpick-lbl">手で選ぶ</span>
      <MenuSelect
        className="sel-btn"
        label={kyokuLabel === null ? `迷い${number}の局を選ぶ` : `迷い${number}の局 ${kyokuLabel}`}
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
        label={currentOption === null ? `迷い${number}の判断を選ぶ` : `迷い${number}の判断 ${currentOption.label}`}
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
        <button type="button" className="link-btn" aria-label={`迷い${number}の候補から選ぶ`} onClick={onBackToChips}>
          候補から選ぶ
        </button>
      )}
      {onCancel !== null && (
        <button type="button" className="link-btn" aria-label={`迷い${number}の選び直しをやめる`} onClick={onCancel}>
          やめる
        </button>
      )}
    </div>
  );
}
