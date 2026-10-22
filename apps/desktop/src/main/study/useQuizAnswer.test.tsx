import { findDecisionByKey, type Decision, type QuizChoice } from '@jantama/engine';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerRow, gameOf } from '../../../tests/fake-study';
import type { AnswerMode, AnswerRow, NewAnswer } from '../../api/types';
import { useQuizAnswer } from './useQuizAnswer';

const fx1a = gameOf('fx1a');
const fx4 = gameOf('fx4');
// f9da 東4局 13巡目（実戦 打3m、AI の 1 位 打7s）
const discard = findDecisionByKey(fx1a, 'k3h0e15') as Decision;
// FX-4 東2局1本場 8巡目の鳴き（東をポン / スルー）
const call = fx4.decisions.find((d) => d.kind === 'call' && d.kyokuLabel === '東2局1本場' && d.junme === 8) as Decision;

const dahai = (tile: string): QuizChoice => ({ type: 'dahai', tile: tile as never });

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付だけ動かす）。 */
const START = new Date(2026, 9, 9, 22, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

interface Options {
  decision?: Decision;
  mode?: AnswerMode;
  previousIntervalDays?: number | null;
  existing?: AnswerRow | null;
  record?: (answer: NewAnswer) => Promise<AnswerRow>;
  threshold?: number;
}

function setup(options: Options = {}) {
  const recorded: NewAnswer[] = [];
  const record =
    options.record ??
    (async (answer: NewAnswer) => {
      recorded.push(answer);
      return answerRow({ ...answer, id: 5, causes: [], principle: '', maka_move: null });
    });
  const view = renderHook(() =>
    useQuizAnswer({
      decision: options.decision ?? discard,
      sessionId: 'sess',
      mode: options.mode ?? 'quiz',
      threshold: options.threshold ?? 0.05,
      previousIntervalDays: options.previousIntervalDays ?? null,
      existing: options.existing ?? null,
      record,
    }),
  );
  return { ...view, recorded };
}

function later(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

describe('U-2 答え合わせは、答えを選ぶまで押せない（理由は任意）', () => {
  it('答えを選ぶと、理由が空または空白だけでも押せる。答えを外すと押せない', () => {
    const { result } = setup();
    expect(result.current.canReveal).toBe(false);
    act(() => result.current.choose(dahai('1s')));
    expect(result.current.canReveal).toBe(true);
    act(() => result.current.setReason('   '));
    expect(result.current.canReveal).toBe(true);
    act(() => result.current.setReason('孤立牌を切る'));
    expect(result.current.canReveal).toBe(true);
    // 答えを外すと、また押せない
    act(() => result.current.choose(null));
    expect(result.current.canReveal).toBe(false);
  });

  it('空白だけの理由は、空文字にして保存する', async () => {
    const { result, recorded } = setup();
    act(() => result.current.choose(dahai('1s')));
    act(() => result.current.setReason('   '));
    await act(async () => {
      await result.current.reveal();
    });
    expect(recorded[0]?.reason).toBe('');
    expect(result.current.stage).toBe('revealed');
  });

  it('押せないときに答え合わせを呼んでも、何も保存しない', async () => {
    const { result, recorded } = setup();
    let ok = true;
    await act(async () => {
      ok = await result.current.reveal();
    });
    expect(ok).toBe(false);
    expect(recorded).toEqual([]);
    expect(result.current.stage).toBe('answering');
  });
});

describe('R8-6 選び直した回数', () => {
  it('一度選んだものを別のものに変えたら 1 回。選び外しと、同じ種類の牌どうし（赤五と普通の五を含む）は数えない', () => {
    const { result } = setup();
    act(() => result.current.choose(dahai('3m')));
    act(() => result.current.choose(dahai('3m')));
    expect(result.current.reselects).toBe(0);
    act(() => result.current.choose(null));
    act(() => result.current.choose(dahai('3m')));
    expect(result.current.reselects).toBe(0);
    act(() => result.current.choose(dahai('1s')));
    expect(result.current.reselects).toBe(1);
    act(() => result.current.choose(null));
    act(() => result.current.choose(dahai('7s')));
    expect(result.current.reselects).toBe(2);
    act(() => result.current.choose(dahai('7s')));
    expect(result.current.reselects).toBe(2);
  });

  it('赤五と普通の五は、同じ種類（選び直しに数えない）', () => {
    const { result } = setup();
    act(() => result.current.choose(dahai('5p')));
    act(() => result.current.choose(dahai('5pr')));
    expect(result.current.reselects).toBe(0);
  });

  it('鳴きの答えのボタンも、別のボタンに変えたら 1 回ずつ（ポン → スルー → ポン で 2 回）', () => {
    const { result } = setup({ decision: call });
    act(() => result.current.choose({ type: 'option', id: 'pon' }));
    act(() => result.current.choose({ type: 'option', id: 'pass' }));
    act(() => result.current.choose({ type: 'option', id: 'pon' }));
    expect(result.current.reselects).toBe(2);
  });
});

describe('U-16 答えの保存', () => {
  it('答え合わせで、答え・理由・時刻・答えるまでの時間・選び直した回数・正解か・次の予定を保存する（出題は、1 日後）', async () => {
    const { result, recorded } = setup();
    act(() => result.current.choose(dahai('1s')));
    act(() => result.current.choose(dahai('7s')));
    act(() => result.current.setReason('  受け入れを広く  '));
    later(38_000);
    await act(async () => {
      await result.current.reveal();
    });
    const shown = START.getTime();
    expect(recorded).toEqual([
      {
        session_id: 'sess',
        decision_key: 'k3h0e15',
        mode: 'quiz',
        shown_at: shown,
        answered_at: shown + 38_000,
        choice: dahai('7s'),
        reason: '受け入れを広く',
        duration_ms: 38_000,
        reselect_count: 1,
        // 打7s は AI の 1 位
        correct: true,
        causes: [],
        principle: '',
        maka_move: null,
        interval_days: 1,
        due_date: '2026-10-10',
      },
    ]);
    expect(result.current.stage).toBe('revealed');
    expect(result.current.elapsedSec).toBe(38);
    expect(result.current.model?.correct).toBe(true);
    expect(result.current.row?.id).toBe(5);
    expect(result.current.verdict).toBeNull();
  });

  it('間違えた出題の答えも、次の予定は 1 日後。「今日」は午前 4 時まで前の日（深夜 3 時の答えは、その前の日の分）', async () => {
    vi.setSystemTime(new Date(2026, 9, 10, 3, 30, 0));
    const { result, recorded } = setup();
    act(() => result.current.choose(dahai('9p')));
    act(() => result.current.setReason('試験'));
    await act(async () => {
      await result.current.reveal();
    });
    expect(recorded[0]?.correct).toBe(false);
    expect(recorded[0]?.interval_days).toBe(1);
    // 10 月 10 日の 3 時半 = 10 月 9 日の続き。次の予定は 10 月 10 日
    expect(recorded[0]?.due_date).toBe('2026-10-10');
  });

  it('保存できなかったら、答える前の画面に戻して理由を出す。AI の内容は出さず、もう一度押せる', async () => {
    const record = vi.fn<(answer: NewAnswer) => Promise<AnswerRow>>(async () => {
      throw new Error('ディスクがいっぱいです');
    });
    const { result } = setup({ record });
    act(() => result.current.choose(dahai('1s')));
    act(() => result.current.setReason('試験'));
    let ok = true;
    await act(async () => {
      ok = await result.current.reveal();
    });
    expect(ok).toBe(false);
    expect(result.current.stage).toBe('answering');
    expect(result.current.error).toBe('答えを保存できませんでした: ディスクがいっぱいです');
    expect(result.current.model).toBeNull();
    expect(result.current.row).toBeNull();
    expect(result.current.canReveal).toBe(true);
    // 直して押し直すと、エラーは消える
    record.mockImplementationOnce(async () => answerRow({ session_id: 'sess', decision_key: 'k3h0e15', id: 9 }));
    await act(async () => {
      await result.current.reveal();
    });
    expect(result.current.stage).toBe('revealed');
    expect(result.current.error).toBeNull();
  });

  it('答え合わせを押すまで、答え合わせの内容（AI の評価）は持たない（U-1）', () => {
    const { result } = setup();
    expect(result.current.model).toBeNull();
    act(() => result.current.choose(dahai('1s')));
    act(() => result.current.setReason('試験'));
    expect(result.current.model).toBeNull();
  });
});

describe('E-5 解き直しの結果と次の予定', () => {
  async function review(previous: number | null, pick: string, extra: () => void = () => undefined) {
    const { result, recorded } = setup({ mode: 'review', previousIntervalDays: previous });
    act(() => result.current.choose(dahai('9p')));
    extra();
    act(() => result.current.choose(dahai(pick)));
    act(() => result.current.setReason('試験'));
    await act(async () => {
      await result.current.reveal();
    });
    return { result, answer: recorded[0] as NewAnswer };
  }

  it('正解でも、答えを選び直したら、間隔は伸ばさない（3日のまま。R8-6）。結果は「正解」', async () => {
    const { result, answer } = await review(3, '7s', () => undefined);
    // 9p → 7s は選び直し 1 回
    expect(answer.reselect_count).toBe(1);
    expect(answer.interval_days).toBe(3);
    expect(result.current.verdict).toEqual({
      correct: true,
      intervalDays: 3,
      dueDate: '2026-10-12',
      previousDays: 3,
      reselected: true,
    });
  });

  it('選び直さずに正解なら、間隔が伸びる（3日 → 7日。10 月 9 日の 7 日後 = 10 月 16 日）', async () => {
    const { result, recorded } = setup({ mode: 'review', previousIntervalDays: 3 });
    act(() => result.current.choose(dahai('7s')));
    act(() => result.current.setReason('試験'));
    await act(async () => {
      await result.current.reveal();
    });
    expect(recorded[0]?.interval_days).toBe(7);
    expect(recorded[0]?.due_date).toBe('2026-10-16');
    expect(result.current.verdict).toMatchObject({ correct: true, intervalDays: 7, dueDate: '2026-10-16', reselected: false });
  });

  it('間違えたら、間隔は 1 日に戻る', async () => {
    const { result, recorded } = setup({ mode: 'review', previousIntervalDays: 14 });
    act(() => result.current.choose(dahai('9p')));
    act(() => result.current.setReason('試験'));
    await act(async () => {
      await result.current.reveal();
    });
    expect(recorded[0]?.interval_days).toBe(1);
    expect(recorded[0]?.due_date).toBe('2026-10-10');
    expect(result.current.verdict).toMatchObject({ correct: false, intervalDays: 1, previousDays: 14 });
  });
});

describe('すでに答えた問題を開く', () => {
  it('保存してある答えから、答え合わせのあとの形で始める（答え・理由・時間・選び直しの回数）', () => {
    const existing = answerRow({
      id: 3,
      session_id: 'sess',
      decision_key: 'k3h0e15',
      choice: dahai('7s'),
      reason: '前に書いた理由',
      duration_ms: 42_000,
      reselect_count: 2,
      correct: true,
    });
    const { result } = setup({ existing });
    expect(result.current.stage).toBe('revealed');
    expect(result.current.choice).toEqual(dahai('7s'));
    expect(result.current.reason).toBe('前に書いた理由');
    expect(result.current.reselects).toBe(2);
    expect(result.current.elapsedSec).toBe(42);
    expect(result.current.row?.id).toBe(3);
    expect(result.current.model?.correct).toBe(true);
    expect(result.current.canReveal).toBe(false);
  });
});
