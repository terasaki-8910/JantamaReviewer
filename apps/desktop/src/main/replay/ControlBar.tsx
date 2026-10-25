/**
 * 半荘を通して見る画面の操作の段（F12）。
 * 1 段目: 局の選択（迷いと悪手の数つき）・局の頭・前の巡目・1手戻る・「手 34 / 48」・1手進む・次の巡目・局の終わり・
 *   NAGA の結果を開くリンク（URL を保存してあるときだけ。F22 段 2）・キーの一覧のアイコン
 * 2 段目: 前・次の悪手（あと何か所）・前・次の迷い（あと何か所。「細かいミスだけ」の切り替えつき）
 * 解決した場面（F16）は、飛ぶ先にも、数にも入れない。
 * 3 段目: 位置の帯
 * 3 段目の位置の帯には、他家の手牌を開いているときだけ、他家が聴牌になった手の目盛りが付く（F14、R16-7 の A）。
 * 他家の手牌の開け閉めは、盤面の手牌のボタン（Board.tsx）。ここには無い（R16-7）。
 * 押したボタンが端で押せなくなったとき、キーボードの位置が消えないよう、対のボタン（それも押せなければ位置の帯）へ移す。
 */
import type { ReplayScene, ReplayTimeline } from '@jantama/engine';
import { useEffect, useRef, type ReactNode } from 'react';

import type { ReplayKeys } from '../../api/types';
import { Icon } from '../Icon';
import { MenuSelect } from '../MenuSelect';
import { NAGA_OPEN_LABEL } from '../naga';
import { KeyHelp } from './KeyHelp';
import { formatChord, type ReplayAction } from './keys';
import { kyokuCounts, turnLabel, type ReplayNav } from './replayModel';
import { ReplayIcon } from './ReplayIcons';
import { Strip, type StripTick } from './Strip';

interface ControlBarProps {
  timeline: ReplayTimeline;
  /** いまの手の通し番号。 */
  g: number;
  scenes: readonly ReplayScene[];
  nav: ReplayNav;
  keys: ReplayKeys;
  answered: ReadonlySet<string>;
  currentKey: string | null;
  go: (g: number) => void;
  onChangeKeys: (next: ReplayKeys) => Promise<string | null>;
  /** 他家が聴牌になった手の目盛り（他家の手牌を開いているときだけ渡す。F14、R16-7）。 */
  ticks?: readonly StripTick[];
  /** 「細かいミスだけ」を入れているか（迷いの段の切り替え。F17）。 */
  fineMissOnly: boolean;
  onFineMissOnly: (on: boolean) => void;
  /** 半荘に保存した NAGA の結果の URL（F22 段 2）。あれば、1 段目のキーの一覧のアイコンの左に、いつものブラウザで開くリンクを出す。 */
  nagaUrl?: string | null;
}

/** 「飛ぶ」段ごとの、前・次の操作と、場面の呼び名。 */
const JUMP_ACTIONS = {
  mismatch: { prev: 'prev_mismatch', next: 'next_mismatch', noun: '悪手' },
  doubt: { prev: 'prev_doubt', next: 'next_doubt', noun: '迷い' },
} as const satisfies Record<string, { prev: ReplayAction; next: ReplayAction; noun: string }>;

/** 押したボタンが押せなくなったとき、キーボードの位置を移す先（対のボタン）。 */
const PAIR: Partial<Record<ReplayAction, ReplayAction>> = {
  step_back: 'step_forward',
  step_forward: 'step_back',
  prev_turn: 'next_turn',
  next_turn: 'prev_turn',
  kyoku_start: 'kyoku_end',
  kyoku_end: 'kyoku_start',
  prev_mismatch: 'next_mismatch',
  next_mismatch: 'prev_mismatch',
  prev_doubt: 'next_doubt',
  next_doubt: 'prev_doubt',
};

export function ControlBar({ timeline, g, scenes, nav, keys, answered, currentKey, go, onChangeKeys, ticks, fineMissOnly, onFineMissOnly, nagaUrl = null }: ControlBarProps) {
  const step = timeline.steps[g];
  const kyoku = step === undefined ? undefined : timeline.kyokus[step.kyokuPosition];
  const buttons = useRef(new Map<ReplayAction, HTMLButtonElement>());
  const pressed = useRef<ReplayAction | null>(null);
  const trackFallback = useRef<HTMLDivElement>(null);

  // 押したボタンが端で押せなくなったとき、対のボタン（それも押せなければ位置の帯）へ、キーボードの位置を移す
  useEffect(() => {
    const action = pressed.current;
    if (action === null) return;
    pressed.current = null;
    const button = buttons.current.get(action);
    if (button === undefined || !button.disabled) return;
    const pair = PAIR[action];
    const other = pair === undefined ? undefined : buttons.current.get(pair);
    if (other !== undefined && !other.disabled) other.focus();
    else trackFallback.current?.querySelector<HTMLElement>('.tl-track')?.focus();
  }, [g]);

  const bind = (action: ReplayAction) => (element: HTMLButtonElement | null) => {
    if (element === null) buttons.current.delete(action);
    else buttons.current.set(action, element);
  };
  const press = (action: ReplayAction) => {
    const to = nav[action];
    pressed.current = action;
    if (to !== null) go(to);
  };
  const hint = (label: string, action: ReplayAction) => {
    const chord = keys[action] ?? null;
    return chord === null ? label : `${label}（${formatChord(chord)}）`;
  };

  const stepButton = (action: ReplayAction, label: string, content: ReactNode, id: string) => (
    <button
      type="button"
      className="btn sm"
      id={id}
      ref={bind(action)}
      aria-label={label}
      title={hint(label, action)}
      disabled={nav[action] === null}
      onClick={() => press(action)}
    >
      {content}
    </button>
  );

  const kyokuItems =
    kyoku === undefined
      ? []
      : timeline.kyokus.map((item) => {
          const counts = kyokuCounts(timeline, scenes, item.position);
          return {
            key: String(item.position),
            label: item.label,
            hint: counts === '' ? undefined : counts,
            checked: item.position === kyoku.position,
            onSelect: () => go(item.first),
          };
        });

  const jump = (kind: 'mismatch' | 'doubt') => {
    const { prev, next, noun } = JUMP_ACTIONS[kind];
    // 場面の数は、解決した場面を除いたもの（「細かいミスだけ」を入れているときは、迷いは細かいミスだけ。nav が数える）
    const total = { mismatch: nav.mismatchTotal, doubt: nav.doubtTotal }[kind];
    const ahead = { mismatch: nav.mismatchesAhead, doubt: nav.doubtsAhead }[kind];
    const name = { mismatch: '悪手', doubt: '自分の迷い' }[kind];
    return (
      <div className="jump" data-kind={kind} role="group" aria-label={`${name}の場面へ飛ぶ`}>
        <span className="jump-l">
          <span className="shape" aria-hidden="true" />
          <span className="jl-t">
            {name} <b>{total}</b>か所
          </span>
        </span>
        <button
          type="button"
          className="btn sm jprev"
          id={`j-${kind}-prev`}
          ref={bind(prev)}
          aria-label={`前の${noun}へ`}
          title={hint(`前の${noun}へ`, prev)}
          disabled={nav[prev] === null}
          onClick={() => press(prev)}
        >
          <ReplayIcon name="prev" />
        </button>
        <button
          type="button"
          className="btn sm jnext"
          id={`j-${kind}-next`}
          ref={bind(next)}
          title={ahead > 0 ? hint(`次の${noun}へ（あと${ahead}か所）`, next) : `これ以降の${noun}はありません`}
          disabled={nav[next] === null}
          onClick={() => press(next)}
        >
          次の{noun}へ
          <ReplayIcon name="next" />
          <span className="jc" aria-label={`あと${ahead}か所`}>
            {ahead}
          </span>
        </button>
        {kind === 'doubt' && (
          <button
            type="button"
            className={`btn sm fm-toggle${fineMissOnly ? ' on' : ''}`}
            id="j-fine-miss"
            aria-pressed={fineMissOnly}
            title="入れると、前・次の迷いと迷いの数が、細かいミス（迷ったうえで実戦が AI の1位と違った場面）だけになります"
            onClick={() => onFineMissOnly(!fineMissOnly)}
          >
            {fineMissOnly && <Icon name="check" />}
            細かいミスだけ
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="pbar" role="region" aria-label="半荘を進める">
      <div className="pb-row top">
        {kyoku !== undefined && (
          <MenuSelect
            className="btn sm kyoku-btn"
            label={`局を選ぶ：${kyoku.label}`}
            menuLabel="局を選ぶ"
            items={kyokuItems}
          >
            <span id="kyoku-name">{kyoku.label}</span>
            <Icon name="chevronDown" className="stage-ic" />
          </MenuSelect>
        )}
        <div className="pb-steps" role="group" aria-label="進める・戻る">
          {stepButton('kyoku_start', '局の頭へ', (
            <>
              <ReplayIcon name="kstart" />
              <span className="lbl">局の頭</span>
            </>
          ), 'b-kstart')}
          {stepButton('prev_turn', '前の巡目へ', (
            <>
              <ReplayIcon name="pturn" />
              <span className="lbl">前の巡目</span>
            </>
          ), 'b-pturn')}
          {stepButton('step_back', '1手戻る', (
            <>
              <ReplayIcon name="prev" />
              <span className="lbl">1手</span>
            </>
          ), 'b-prev')}
          <span className="pos" id="pos">
            {step !== undefined && kyoku !== undefined && (
              <>
                手 <b>{step.position + 1}</b> / {kyoku.steps.length}
              </>
            )}
          </span>
          {stepButton('step_forward', '1手進む', (
            <>
              <span className="lbl">1手</span>
              <ReplayIcon name="next" />
            </>
          ), 'b-next')}
          {stepButton('next_turn', '次の巡目へ', (
            <>
              <span className="lbl">次の巡目</span>
              <ReplayIcon name="nturn" />
            </>
          ), 'b-nturn')}
          {stepButton('kyoku_end', '局の終わりへ', (
            <>
              <span className="lbl">局の終わり</span>
              <ReplayIcon name="kend" />
            </>
          ), 'b-kend')}
        </div>
        {nagaUrl !== null && (
          <a
            className="icon-btn naga-btn"
            href={nagaUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={NAGA_OPEN_LABEL}
            title={NAGA_OPEN_LABEL}
          >
            <Icon name="external" />
          </a>
        )}
        <KeyHelp keys={keys} onChange={onChangeKeys} />
      </div>
      <div className="pb-jumps">
        {jump('mismatch')}
        {jump('doubt')}
      </div>
      <div ref={trackFallback}>
        <Strip timeline={timeline} g={g} scenes={scenes} answered={answered} currentKey={currentKey} go={go} ticks={ticks} />
      </div>
      <p className="sr-only" aria-live="polite">
        {step === undefined || kyoku === undefined ? '' : `${kyoku.label} ${turnLabel(step.junme)}`}
      </p>
    </div>
  );
}
