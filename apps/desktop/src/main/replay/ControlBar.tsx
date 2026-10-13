/**
 * 半荘を通して見る画面の操作の段（F12）。
 * 1 段目: 局の選択（迷いと不一致の数つき）・局の頭・前の巡目・1手戻る・「手 34 / 48」・1手進む・次の巡目・局の終わり・キーの一覧のアイコン
 * 2 段目: 前・次の不一致（あと何か所）・前・次の迷い（あと何か所）
 * 3 段目: 位置の帯
 * 1 段目の右に、「他家の手牌を開く / 閉じる」（F14、R15-5）。答える場面（迷い・不一致）では、答えるまで押せない（U-35）
 * 押したボタンが端で押せなくなったとき、キーボードの位置が消えないよう、対のボタン（それも押せなければ位置の帯）へ移す。
 */
import type { ReplayScene, ReplayTimeline } from '@jantama/engine';
import { useEffect, useRef, type ReactNode } from 'react';

import type { ReplayKeys } from '../../api/types';
import { Icon } from '../Icon';
import { InfoTip } from '../InfoTip';
import { MenuSelect } from '../MenuSelect';
import { KeyHelp } from './KeyHelp';
import { formatChord, type ReplayAction } from './keys';
import { kyokuCounts, turnLabel, type ReplayNav } from './replayModel';
import { ReplayIcon } from './ReplayIcons';
import { Strip } from './Strip';

interface ControlBarProps {
  timeline: ReplayTimeline;
  /** いまの手の通し番号。 */
  g: number;
  scenes: readonly ReplayScene[];
  nav: ReplayNav;
  keys: ReplayKeys;
  /** 「AI の1位と違う判断も、不一致として出す」が入か（不一致の行の名前が変わる）。 */
  showAll: boolean;
  answered: ReadonlySet<string>;
  currentKey: string | null;
  go: (g: number) => void;
  onChangeKeys: (next: ReplayKeys) => Promise<string | null>;
  /** 「他家の手牌を開く」（F14）。`available` は、いまの手で開けるか（答える場面は、答えたあとだけ）。 */
  openHands: { open: boolean; available: boolean; onToggle: () => void };
}

/** 「他家の手牌を開く」の説明のアイコンの文。 */
export const OPEN_HANDS_HINT =
  '他家 3 人の手牌と待ちを、右の欄に出します。手を進めても開いたままなので、他家の手の進み方を、河と一緒に見られます。迷い・不一致の場面では、答えを出すまで開けません（手牌は画面にも出しません）。';

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

export function ControlBar({ timeline, g, scenes, nav, keys, showAll, answered, currentKey, go, onChangeKeys, openHands }: ControlBarProps) {
  const step = timeline.steps[g];
  const kyoku = step === undefined ? undefined : timeline.kyokus[step.kyokuPosition];
  const buttons = useRef(new Map<ReplayAction, HTMLButtonElement>());
  const pressed = useRef<ReplayAction | null>(null);
  const trackFallback = useRef<HTMLDivElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  // 「他家の手牌を開く」にキーボードの位置があるまま、答える場面へ進んで押せなくなったとき、位置が消えないよう、位置の帯へ移す
  const openFocused = useRef(false);
  const { available: openAvailable } = openHands;
  useEffect(() => {
    if (openAvailable || !openFocused.current) return;
    openFocused.current = false;
    trackFallback.current?.querySelector<HTMLElement>('.tl-track')?.focus();
  }, [openAvailable]);

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

  const mismatchTotal = scenes.filter((scene) => scene.mismatch !== null).length;
  const doubtTotal = scenes.filter((scene) => scene.doubts.length > 0).length;

  const jump = (kind: 'mismatch' | 'doubt') => {
    const mis = kind === 'mismatch';
    const total = mis ? mismatchTotal : doubtTotal;
    const ahead = mis ? nav.mismatchesAhead : nav.doubtsAhead;
    const prev: ReplayAction = mis ? 'prev_mismatch' : 'prev_doubt';
    const next: ReplayAction = mis ? 'next_mismatch' : 'next_doubt';
    const noun = mis ? '不一致' : '迷い';
    const name = mis ? (showAll ? '不一致' : '大きな不一致') : '自分の迷い';
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
        <div className="pb-open">
          <button
            type="button"
            className="btn sm"
            id="b-openhands"
            ref={openButton}
            data-open={openHands.open && openAvailable ? '1' : undefined}
            disabled={!openAvailable}
            aria-describedby="oh-ctl-hint"
            onFocus={() => {
              openFocused.current = true;
            }}
            onBlur={(event) => {
              if (!event.currentTarget.disabled) openFocused.current = false;
            }}
            onClick={openHands.onToggle}
          >
            <Icon name="eye" />
            <span className="lbl">{openHands.open && openAvailable ? '他家の手牌を閉じる' : '他家の手牌を開く'}</span>
          </button>
          <InfoTip label="他家の手牌を開くの説明" id="oh-ctl-hint">
            {OPEN_HANDS_HINT}
          </InfoTip>
        </div>
        <KeyHelp keys={keys} onChange={onChangeKeys} />
      </div>
      <div className="pb-jumps">
        {jump('mismatch')}
        {jump('doubt')}
      </div>
      <div ref={trackFallback}>
        <Strip timeline={timeline} g={g} scenes={scenes} answered={answered} currentKey={currentKey} go={go} />
      </div>
      <p className="sr-only" aria-live="polite">
        {step === undefined || kyoku === undefined ? '' : `${kyoku.label} ${turnLabel(step.junme)}`}
      </p>
    </div>
  );
}
