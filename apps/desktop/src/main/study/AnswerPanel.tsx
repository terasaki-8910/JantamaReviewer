/**
 * 答えの欄（出題・解き直し、あとで半荘を通して見る画面も使う）。
 *
 * 答える前: 打牌の判断は選んだ牌の表示、ほかの判断（鳴き・リーチ・和了・カン）は雀魂と同じ並びのボタン。理由（1 行・必須）。
 *   答えと理由がそろうまで「答え合わせ」は押せない（U-2）。この間、AI の候補・確率・順位は、DOM のどこにも出さない（U-1）。
 * 答え合わせのあと: 自分の答え・（解き直しは）正解か次の予定・AI の評価・受け入れ枚数（打牌の判断）・差の原因・学んだ原則・MAKA・次へ。
 *   AI の情報を持つ要素には `data-ai` を付ける（答える前の画面に無いことを、試験が確かめる）。
 */
import {
  CAUSE_CHOICES,
  choiceText,
  plainTile,
  recordMakaMove,
  tileKind,
  tileLabel,
  type AnswerOption,
  type Decision,
  type QuizChoice,
  type Tile as TileCode,
} from '@jantama/engine';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';

import type { AnswerMode, AnswerRow } from '../../api/types';
import { Icon } from '../Icon';
import type { ShownMemo } from '../memos';
import { isDoraTile } from './dora';
import { formatElapsed, formatMonthDay } from './labels';
import { MemoShown } from './MemoShown';
import { formatProbability, type RevealModel } from './reveal';
import { Tile } from './Tile';
import { tileName } from './tiles';
import { AnswerTabs, type TabSpec } from './AnswerTabs';
import { DEFAULT_TAB_LABEL, visibleRevealTabs } from './revealTabs';
import { UkeireSection } from './UkeireSection';
import { YakuSection } from './YakuSection';
import { useAnswerNotes } from './useAnswerNotes';
import type { QuizAnswer } from './useQuizAnswer';

export interface AnswerPanelProps {
  decision: Decision;
  mode: AnswerMode;
  quiz: QuizAnswer;
  /** 打牌の判断で、手牌から選んでいる牌。 */
  pickedTile: TileCode | null;
  /** 打牌以外の判断の、答えのボタン（雀魂と同じ並び）。 */
  options: readonly AnswerOption[];
  /** 他家の打牌への判断で、鳴く牌を打った人の呼び名（対面など）。 */
  calledFrom: string | null;
  dora: ReadonlySet<number> | null;
  /** 正解とする確率の下限（0.05 など）。 */
  threshold: number;
  nextLabel: string;
  onNext: () => void;
  /**
   * 答える前に出す、終局直後のメモの欄（半荘を通して見る画面の迷いの場面だけ。F4、U-28）。AI の情報は含まない。
   * 答えのフォーム（理由・答え合わせ）のあとに置く。答え合わせのあとは、`memoShown` に替わる。
   */
  memoEditor?: ReactNode;
  /** 答え合わせのあとに、自分の答えの下へ出す「終局直後のメモ」（無ければ出さない）。答える前は渡さない（DOM にも無い）。 */
  memoShown?: readonly ShownMemo[];
  /** 答えの欄の上に出す欄（他家の手牌を開いているときの「他家の手牌」の欄。答えたあとだけ渡す。R16-7）。 */
  above?: ReactNode;
}

/** 「答え合わせ」を押せない理由（何を選ぶと押せるか）。 */
function gateText(decision: Decision, options: readonly AnswerOption[], hasChoice: boolean, hasReason: boolean): string {
  let which = '切る牌を選';
  if (decision.kind !== 'discard') {
    const names = [...new Set(options.map((option) => option.label))];
    which = `${names.join('・')}${names.length > 2 ? 'のどれか' : 'のどちらか'}を選`;
  }
  if (!hasChoice && !hasReason) return `${which}び、理由を1行書くと押せます`;
  if (!hasChoice) return `${which}ぶと押せます`;
  if (!hasReason) return '理由を1行書くと押せます';
  return 'AIの評価が出ます。出したあとは答えを変えられません';
}

function PickedTile({ tile, dora }: { tile: TileCode | null; dora: ReadonlySet<number> | null }) {
  if (tile === null) return <span className="none">切る牌を選んでください</span>;
  return (
    <>
      <Tile tile={tile} dora={isDoraTile(tile, dora)} />
      <span className="pick-name">
        打<span className="mono">{tileLabel(tile)}</span>
      </span>
    </>
  );
}

interface OptionGroupProps {
  options: readonly AnswerOption[];
  choice: QuizChoice | null;
  calledFrom: string | null;
  dora: ReadonlySet<number> | null;
  onChoose: (id: string) => void;
}

/**
 * 答えのボタン（チー・ポン・カン・リーチ・ツモ／ロン・スルー）。1 つの選択（radiogroup）。
 * 矢印キーは、動かすだけ（選ぶのは、Space・Enter・クリック）。通り道で選んだことになって、選び直しの回数が増えないように。
 */
function OptionGroup({ options, choice, calledFrom, dora, onChoose }: OptionGroupProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = options.findIndex((option) => choice !== null && choice.type === 'option' && choice.id === option.id);
  const tabbable = checked >= 0 ? checked : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const { key } = event;
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(key)) return;
    // Alt+← → は画面の戻る・進む、Shift+矢印は通して見る画面の前・次の迷い・局。ここでは使わない
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    const last = options.length - 1;
    const forward = key === 'ArrowDown' || key === 'ArrowRight';
    const to = key === 'Home' ? 0 : key === 'End' ? last : (index + (forward ? 1 : -1) + options.length) % options.length;
    refs.current[to]?.focus();
  };

  return (
    <fieldset className="q-choices" role="radiogroup">
      <legend className="sec-title">自分の答え</legend>
      {options.map((option, index) => {
        const withTiles = option.use.length > 0 || option.called !== null;
        return (
          <button
            type="button"
            role="radio"
            className="q-choice"
            key={option.id}
            aria-checked={checked === index}
            aria-label={withTiles ? option.text : undefined}
            tabIndex={index === tabbable ? 0 : -1}
            data-option={option.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            onClick={() => onChoose(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="c-body">
              <span className="c-name">{option.label}</span>
              {withTiles ? (
                <span className="c-tiles">
                  {option.use.map((tile, at) => (
                    <Tile key={`${at}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
                  ))}
                  {option.called !== null && (
                    <>
                      {option.use.length > 0 && (
                        <span className="c-plus" aria-hidden="true">
                          ＋
                        </span>
                      )}
                      <Tile
                        tile={option.called}
                        className="target"
                        alt={`${tileName(option.called)}（${calledFrom ?? '他家'}の打牌）`}
                      />
                    </>
                  )}
                </span>
              ) : option.kind === 'pass' && option.label === 'スルー' ? (
                <span className="c-note">鳴かない</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

function AnsweringForm({ decision, quiz, pickedTile, options, calledFrom, dora }: AnswerPanelProps) {
  const submitRef = useRef<HTMLButtonElement>(null);
  // 保存できなかったときは、もう一度押せるよう、ボタンにキーボードの位置を戻す
  useEffect(() => {
    if (quiz.error !== null) submitRef.current?.focus();
  }, [quiz.error]);

  const hasChoice = quiz.choice !== null;
  const hasReason = quiz.reason.trim().length > 0;
  const message = quiz.error ?? gateText(decision, options, hasChoice, hasReason);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (quiz.canReveal) void quiz.reveal();
  };

  return (
    <form className="only-answering" id="answer-form" noValidate onSubmit={onSubmit}>
      {decision.kind === 'discard' ? (
        <>
          <h2 className="sec-title">自分の答え</h2>
          <div className="pick" aria-live="polite">
            <PickedTile tile={pickedTile} dora={dora} />
          </div>
        </>
      ) : (
        <OptionGroup
          options={options}
          choice={quiz.choice}
          calledFrom={calledFrom}
          dora={dora}
          onChoose={(id) => quiz.choose({ type: 'option', id })}
        />
      )}
      <div className="field">
        <div className="field-h">
          <label htmlFor="reason">理由（1行）</label>
          <span className="req">必須</span>
        </div>
        <input
          className="input"
          id="reason"
          name="reason"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          enterKeyHint="done"
          aria-describedby="gate"
          value={quiz.reason}
          onChange={(event) => quiz.setReason(event.target.value)}
        />
      </div>
      <div className="q-sec">
        <button
          className="btn primary lg block"
          id="submit"
          type="submit"
          disabled={!quiz.canReveal}
          aria-describedby="gate"
          ref={submitRef}
        >
          答え合わせ
        </button>
        <p className="quiet" id="gate" aria-live="polite">
          {message}
        </p>
      </div>
    </form>
  );
}

// ---- 答え合わせのあと ----

function OptionLabel({ option, dora }: { option: AnswerOption; dora: ReadonlySet<number> | null }) {
  return (
    <>
      <b>{option.label}</b>
      {option.use.map((tile, index) => (
        <Tile key={`${index}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
      ))}
    </>
  );
}

function Evaluation({ model, discard, dora }: { model: RevealModel; discard: boolean; dora: ReadonlySet<number> | null }) {
  return (
    <div className="q-sec" data-ai="eval">
      <h2 className="sec-title">AIの評価（Mortal）</h2>
      <ul className={`bars${discard ? '' : ' call'}`}>
        {model.bars.map((bar) => (
          <li className={bar.kind === 'other' ? 'bar' : `bar ${bar.kind}`} data-ai="candidate" key={bar.key}>
            <span className="btag">{bar.tags.join('・')}</span>
            <span className="lab">
              {bar.tile !== null ? (
                <Tile tile={bar.tile} dora={isDoraTile(bar.tile, dora)} />
              ) : bar.option !== null ? (
                <OptionLabel option={bar.option} dora={dora} />
              ) : null}
            </span>
            <span className="track" aria-hidden="true">
              <span className="fill" style={{ width: `${Math.max(bar.probability * 100, 0.6).toFixed(2)}%` }} />
            </span>
            <span className="v">{formatProbability(bar.probability)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 解き直しの結果（正解か・次の予定）。 */
function Verdict({ decision, quiz, model, threshold }: { decision: Decision; quiz: QuizAnswer; model: RevealModel; threshold: number }) {
  const verdict = quiz.verdict;
  if (verdict === null || quiz.choice === null) return null;
  const what = choiceText(decision, quiz.choice);
  const previous = verdict.previousDays ?? 1;
  let why: string;
  if (!verdict.correct) why = '間違えたので、間隔を 1日に戻します';
  else if (verdict.reselected) why = `答えを選び直したので、間隔は伸ばしません（${previous}日のまま）`;
  else why = `間隔 ${previous}日 → ${verdict.intervalDays}日`;
  const percent = Math.round(threshold * 1000) / 10;
  return (
    <div className="q-sec verdict" data-ai="verdict" data-result={verdict.correct ? 'ok' : 'ng'}>
      <p className="v-main">
        <span className="v-badge">
          <Icon name={verdict.correct ? 'check' : 'close'} />
          {verdict.correct ? '正解' : '不正解'}
        </span>
        <span className="v-text">
          {what} は AI が {formatProbability(model.probability)} の確率で選ぶ手です
          <span className="v-rule">{percent}%以上なら正解</span>
        </span>
      </p>
      <div className="v-next">
        <p className="v-line">
          次の解き直し <b>{verdict.intervalDays}日後</b>（{formatMonthDay(verdict.dueDate)}）
        </p>
        <p className="v-why">{why}</p>
      </div>
    </div>
  );
}

const MAKA_HINT = '入れなくても先へ進めます。MAKA は、自分の答えを出したあとに見てください。';

/** 手牌の牌の種類（赤五は普通の五として）。MAKA の推した打牌を選ぶ一覧。 */
function pickableTiles(decision: Decision): TileCode[] {
  const { hand, drawn } = decision.board;
  const tiles = drawn === null ? [...hand] : [...hand, drawn];
  const kinds = new Map<number, TileCode>();
  for (const tile of tiles) kinds.set(tileKind(tile), plainTile(tile));
  return [...kinds.entries()].sort((a, b) => a[0] - b[0]).map(([, tile]) => tile);
}

function Maka({ decision, model, move, onChange }: { decision: Decision; model: RevealModel; move: string | null; onChange: (move: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const pickable = pickableTiles(decision);
  const record = move === null ? null : recordMakaMove(decision.entry, move as TileCode);
  return (
    <details className="q-maka" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="chevronRight" className="chev" />
        MAKA の推した打牌<span className="opt">（任意）</span>
      </summary>
      <div className="maka-body">
        <div role="group" aria-label="MAKA の推した打牌">
          <ul className="maka-tiles">
            {pickable.map((tile) => (
              <li key={tile}>
                <button
                  type="button"
                  className="mk-btn"
                  aria-pressed={move === tile}
                  aria-label={tileName(tile)}
                  onClick={() => onChange(move === tile ? null : tile)}
                >
                  <Tile tile={tile} alt="" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <p className="maka-note" aria-live="polite">
          {move === null ? (
            MAKA_HINT
          ) : (
            <>
              MAKA：打<span className="mono">{tileLabel(move as TileCode)}</span>
              {record !== null && model.topTile !== null && record.equalsMortalTop !== null && (
                <span className="q-chip">
                  {record.equalsMortalTop ? 'Mortal の1位と同じ' : `Mortal の1位（打${tileLabel(model.topTile)}）と食い違い`}
                </span>
              )}
            </>
          )}
        </p>
      </div>
    </details>
  );
}

interface RevealProps extends AnswerPanelProps {
  model: RevealModel;
  row: AnswerRow;
  /** 答え合わせを押した直後か（見出しにキーボードの位置を移す）。保存してあった答えを開いたときは移さない。 */
  focusOnMount: boolean;
}

function Reveal({ decision, mode, quiz, model, row, dora, threshold, nextLabel, onNext, focusOnMount, memoShown }: RevealProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  const notes = useAnswerNotes(row);
  const discard = decision.kind === 'discard';
  const choice = quiz.choice;
  if (choice === null) return null;

  // 既定のタブ「受け入れ・役」の中身（受け入れ枚数の欄と役の欄）。足すタブが無い場面では、タブにせず、そのまま並べる
  const defaultSections = (
    <>
      {model.ukeire !== null && <UkeireSection box={model.ukeire} dora={dora} />}
      {model.yaku !== null && <YakuSection box={model.yaku} dora={dora} />}
    </>
  );
  const context = { decision, model, dora };
  const extraTabs = visibleRevealTabs(context);
  const tabs: TabSpec[] = [
    { id: 'default', label: DEFAULT_TAB_LABEL, panel: () => defaultSections },
    ...extraTabs.map((tab) => ({ id: tab.id, label: tab.label, panel: () => tab.panel(context) })),
  ];

  const next = async () => {
    if (await notes.commitPrinciple()) onNext();
  };

  return (
    <div className="only-revealed q-review" id="review">
      {mode === 'review' && <Verdict decision={decision} quiz={quiz} model={model} threshold={threshold} />}
      <div className="q-sec">
        <h2 className="sec-title sr-only" id="reveal-h" tabIndex={-1} ref={headingRef}>
          自分の答え
        </h2>
        <div className={`summary${discard ? '' : ' no-tile'}`}>
          {discard && choice.type === 'dahai' && (
            <span className="tiles">
              <Tile tile={choice.tile} dora={isDoraTile(choice.tile, dora)} />
            </span>
          )}
          <span className="what">
            <span className="who">自分</span>
            {choiceText(decision, choice)}
          </span>
          <p className="why">{row.reason}</p>
          <p className="meta">
            答えるまで {formatElapsed(quiz.elapsedSec ?? row.duration_ms / 1000)} · 選び直し {quiz.reselects}回
          </p>
        </div>
      </div>
      {memoShown !== undefined && <MemoShown memos={memoShown} />}
      <Evaluation model={model} discard={discard} dora={dora} />
      {extraTabs.length === 0 ? (
        defaultSections
      ) : (
        // 場面に関係のあるタブがあるときだけ、タブにする（既定は「受け入れ・役」。F14）。タブの枠は、ほかの欄と同じ区切りの欄に入れる
        <div className="q-sec">
          <AnswerTabs label="答え合わせの内容" tabs={tabs} />
        </div>
      )}
      <form className="q-sec learn" noValidate data-ai="learn" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="pills-set">
          <legend className="lbl">
            差の原因<span className="legend-note">（当てはまるものをいくつでも）</span>
          </legend>
          <div className="pills">
            {CAUSE_CHOICES.map((cause) => (
              <label className="pill multi" key={cause.id}>
                <input
                  type="checkbox"
                  name="cause"
                  value={cause.id}
                  checked={notes.causes.includes(cause.id)}
                  onChange={(event) => notes.toggleCause(cause.id, event.target.checked)}
                />
                <span>
                  <i className="bx" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </i>
                  {cause.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="principle">学んだ原則（1行）</label>
          <input
            className="input"
            id="principle"
            name="principle"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            value={notes.principle}
            onChange={(event) => notes.setPrinciple(event.target.value)}
            onBlur={() => void notes.commitPrinciple()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void notes.commitPrinciple();
              }
            }}
          />
          {notes.error !== null && (
            <p className="quiet" role="alert">
              {notes.error}
            </p>
          )}
        </div>
        {discard && <Maka decision={decision} model={model} move={notes.makaMove} onChange={notes.setMakaMove} />}
        <button type="button" className="btn primary lg block" id="next" onClick={() => void next()}>
          {nextLabel}
        </button>
      </form>
    </div>
  );
}

/** 答えの欄。答える前は答えるためのフォームだけ、答え合わせのあとは評価と、直す欄。 */
export function AnswerPanel(props: AnswerPanelProps) {
  const { quiz } = props;
  // 答え合わせを押して開いたときだけ、見出しへ移る（保存してあった答えを開いたときは、キーボードの位置を奪わない）
  const [startedAnswering] = useState(quiz.stage !== 'revealed');
  const revealed = quiz.stage === 'revealed' && quiz.model !== null && quiz.row !== null;
  return (
    <section className="answer" aria-label="答え" id="answer">
      {props.above}
      {quiz.stage !== 'revealed' && <AnsweringForm {...props} />}
      {/* 答えのフォームのあとに置く（手牌から Tab で、理由・答え合わせへ続く順を変えない）。答えを出す前なら、いつでも書ける・直せる */}
      {quiz.stage !== 'revealed' && props.memoEditor !== undefined && (
        <div className="q-sec memo-editor" data-memo="editor">
          <h2 className="sec-title">終局直後のメモ</h2>
          {props.memoEditor}
        </div>
      )}
      {revealed && quiz.model !== null && quiz.row !== null && (
        <Reveal {...props} model={quiz.model} row={quiz.row} focusOnMount={startedAnswering} />
      )}
    </section>
  );
}
