import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';

import { errorMessage } from '../api/tauri';
import type { MemoEntry } from '../api/types';
import { EMPTY_MEMO, MEMO_CANDIDATES_MAX, MEMO_REASON_MAX, normalizeMemo, sameMemo } from './memos';

/**
 * 終局直後のメモ（F4、U-28）の欄: 「候補」（短い文。例: 3m・6p）と「理由（1行）」。迷いのカードの中・追加のメモ・
 * 半荘を通して見る画面の迷いの場面（答える前）が、同じ部品を使う。AI の答えを見る前に、そのとき考えたことを書き留める欄なので、
 * AI の情報は、ここには出てこない（U-1）。
 *
 * 保存:
 * - 欄の外へ出たとき・Enter で、打った分を保存して、取り消せる命令にする（`onCommit`。U-11）。打っている途中は、欄そのものの取り消し
 *   （Ctrl+Z）が働く（アプリの取り消しは、文字を打つ欄の中では動かない）
 * - 打つのをやめて少し経ったら（`MEMO_DEBOUNCE_MS`）、取り消しの命令にはせずに、書き込んでおく（`onPersist`）。欄の外へ出ずに画面が替わっても、
 *   打った文が残るように。欄の外へ出たときの命令は、打ち始める前の値を「元の値」にする
 * - 「候補」も「理由」も空になったら、メモは無いものとして扱う（保存先でも、メモを消す）
 *
 * 保存してある値（`saved`）が、外から替わったとき（取り消し・やり直し・読み直し）は、打っている途中でなければ、欄をそれに合わせる。
 */

/** 打つのをやめてから、書き込んでおくまでの時間（ミリ秒）。 */
export const MEMO_DEBOUNCE_MS = 600;

interface MemoFieldsProps {
  /** 欄のまとまりの名前（読み上げ用）。例: 「迷い3のメモ」。 */
  name: string;
  /** 保存してあるメモ。無ければ undefined。 */
  saved: MemoEntry | undefined;
  /** 打ち終わった（欄の外へ出た・Enter）。取り消せる命令にして保存する。失敗したら例外。 */
  onCommit: (before: MemoEntry | undefined, after: MemoEntry | undefined) => Promise<void>;
  /** 打っている途中の書き込み（取り消しの命令にはしない）。失敗したら例外。 */
  onPersist: (after: MemoEntry | undefined) => Promise<void>;
  /** 最初の欄（「候補」）に、キーボードの位置を移すための参照。 */
  firstRef?: Ref<HTMLInputElement>;
  /**
   * 「理由」の欄の名前。既定は「理由（1行）」。出題と同じ画面（半荘を通して見る画面の場面）では、答えの理由の欄が「理由（1行）」なので、
   * 同じ名前の欄が 2 つ並ばないよう、「理由」にする。
   */
  reasonLabel?: string;
}

export function MemoFields({ name, saved, onCommit, onPersist, firstRef, reasonLabel = '理由（1行）' }: MemoFieldsProps) {
  const candidatesId = useId();
  const reasonId = useId();
  const [draft, setDraft] = useState<MemoEntry>(saved ?? EMPTY_MEMO);
  // 打っている途中か（途中は、保存してある値を欄に写さない）
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  // 打ち始める前の保存の値（欄の外へ出たときの命令の「元の値」）
  const baseline = useRef<MemoEntry | undefined>(saved);
  // 欄の外へ出て、いま保存したばかりの値（一覧が読み直されるまでの間、次に打ち始めるときの「元の値」にする）
  const committed = useRef<{ memo: MemoEntry | undefined } | null>(null);
  const timer = useRef<number | null>(null);
  // 画面が替わる（外す）ときに、書き込んでおくための、いちばん新しい値
  const pending = useRef<{ memo: MemoEntry | undefined; persist: MemoFieldsProps['onPersist'] } | null>(null);

  // 保存してある値が外から替わった（取り消し・やり直し・読み直し）。打っている途中でなければ、欄を合わせる
  if (!sameMemo(saved, seen)) {
    setSeen(saved);
    if (!editing) setDraft(saved ?? EMPTY_MEMO);
  }

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  // 外す（別の画面へ移る）とき、まだ書き込んでいない分を書き込む
  useEffect(
    () => () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
      const last = pending.current;
      if (last !== null) void last.persist(last.memo).catch(() => undefined);
    },
    [],
  );

  // 保存した値が読み直されたら、「いま保存した値」の控えは要らない（保存してある値そのものを使う）
  useEffect(() => {
    committed.current = null;
  }, [saved]);

  const change = (field: keyof MemoEntry, value: string) => {
    if (!editing) {
      // 打ち始める前の値。保存した直後で、まだ読み直されていないときは、いま保存した値
      baseline.current = committed.current === null ? saved : committed.current.memo;
      setEditing(true);
    }
    const next = { ...draft, [field]: value };
    setDraft(next);
    setError(null);
    clearTimer();
    const memo = normalizeMemo(next);
    pending.current = { memo, persist: onPersist };
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onPersist(memo).catch((failure: unknown) => setError(`メモを保存できませんでした: ${errorMessage(failure)}`));
    }, MEMO_DEBOUNCE_MS);
  };

  const commit = () => {
    clearTimer();
    if (!editing) return;
    setEditing(false);
    const before = baseline.current;
    const after = normalizeMemo(draft);
    if (sameMemo(before, after)) {
      // 打ち直して元に戻った。途中で書き込んでいたら、元の値へ書き戻す
      if (pending.current !== null && !sameMemo(pending.current.memo, before)) {
        onPersist(before).catch((failure: unknown) => setError(`メモを保存できませんでした: ${errorMessage(failure)}`));
      }
      pending.current = null;
      return;
    }
    pending.current = null;
    committed.current = { memo: after };
    onCommit(before, after).catch((failure: unknown) => {
      committed.current = null;
      setError(`メモを保存できませんでした: ${errorMessage(failure)}`);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    commit();
  };

  return (
    <div className="memo" role="group" aria-label={name}>
      <div className="field">
        <label htmlFor={candidatesId}>候補</label>
        <input
          className="input sm"
          id={candidatesId}
          ref={firstRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={MEMO_CANDIDATES_MAX}
          enterKeyHint="done"
          placeholder="例: 3m・6p"
          value={draft.candidates}
          onChange={(event) => change('candidates', event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="field">
        <label htmlFor={reasonId}>{reasonLabel}</label>
        <input
          className="input sm"
          id={reasonId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={MEMO_REASON_MAX}
          enterKeyHint="done"
          placeholder="考えたことを1行で"
          value={draft.reason}
          onChange={(event) => change('reason', event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </div>
      {error !== null && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
