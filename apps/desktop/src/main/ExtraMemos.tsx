import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { DecisionRef } from '@jantama/engine';

import { api, errorMessage } from '../api/tauri';
import type { ExtraMemo, MemoEntry, SessionRecord } from '../api/types';
import { decisionOptions, kyokuOptions } from './markCards';
import { Icon } from './Icon';
import { MemoFields } from './MemoFields';
import { extraMemoCommand } from './memoEdits';
import { EMPTY_MEMO, MEMO_CANDIDATES_MAX, MEMO_REASON_MAX, nextExtraId, normalizeMemo } from './memos';
import { MenuSelect } from './MenuSelect';
import { useUndo } from './undo/UndoProvider';

/**
 * 迷いマークの無い迷いのメモ（F4、U-28）: 迷いのカードの並びの下の、追加のメモのカードと、「迷いマークの無い迷いを足す」。
 *
 * 局・巡目は手で選ぶ（この半荘の判断から、局のメニュー → 判断のメニュー。判断の鍵で保存する）。判断の一覧は、結果を取り込んだ
 * 半荘にしか無いので、取り込む前の半荘には、足せないことを静かな 1 行で伝える。足す・書き直す・消すは、取り消せる（U-11）。
 * AI の候補・確率・順位は出さない（SPEC F3）。
 */

function PlusIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

interface ExtraMemosProps {
  session: SessionRecord;
  /** この半荘のすべての判断（結果を読めていなければ空）。 */
  decisions: readonly DecisionRef[];
  /** 保存したあとに、半荘の一覧を読み直す。 */
  reload: () => Promise<void>;
}

export function ExtraMemos({ session, decisions, reload }: ExtraMemosProps) {
  const undo = useUndo();
  const { extras } = session.memos;
  const [adding, setAdding] = useState(false);
  // 足した直後のカード（欄にキーボードの位置を移す）
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const refOf = useMemo(() => new Map(decisions.map((decision) => [decision.key, decision] as const)), [decisions]);
  const imported = session.report_path !== null;

  const add = async (decision: DecisionRef, memo: MemoEntry | undefined): Promise<void> => {
    const id = nextExtraId(extras);
    const after: ExtraMemo = { id, decision: decision.key, ...(memo ?? EMPTY_MEMO) };
    await undo.run(extraMemoCommand(api, reload, { sessionId: session.id, id, before: undefined, after }));
    setJustAdded(id);
    setAdding(false);
  };

  return (
    <>
      {extras.length > 0 && (
        <ul className="marks extras" aria-label="追加のメモの一覧">
          {extras.map((extra) => (
            <li key={extra.id}>
              <ExtraMemoCard
                sessionId={session.id}
                extra={extra}
                decision={refOf.get(extra.decision) ?? null}
                reload={reload}
                focusOnMount={justAdded === extra.id}
              />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <AddPanel
          decisions={decisions}
          onAdd={add}
          onCancel={() => {
            setAdding(false);
            // パネルが消えるので、キーボードの位置は、開いたボタンへ戻す
            window.requestAnimationFrame(() => addRef.current?.focus());
          }}
        />
      ) : decisions.length > 0 ? (
        <div className="memo-foot">
          <button type="button" className="btn sm" ref={addRef} onClick={() => setAdding(true)}>
            <PlusIcon />
            迷いマークの無い迷いを足す
          </button>
        </div>
      ) : (
        !imported && (
          <p className="quiet memo-foot">迷いマークの無い迷いは、検討結果を取り込んだあとに足せます。</p>
        )
      )}
    </>
  );
}

interface ExtraMemoCardProps {
  sessionId: string;
  extra: ExtraMemo;
  /** メモが結びつく判断（結果を読めていないときは null）。 */
  decision: DecisionRef | null;
  reload: () => Promise<void>;
  focusOnMount: boolean;
}

/** 追加のメモ 1 つのカード（画像の代わりに「迷いマークなし」の箱）。 */
function ExtraMemoCard({ sessionId, extra, decision, reload, focusOnMount }: ExtraMemoCardProps) {
  const undo = useUndo();
  const labelId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) firstRef.current?.focus({ preventScroll: false });
  }, [focusOnMount]);

  const asExtra = (memo: MemoEntry | undefined): ExtraMemo => ({ ...extra, ...(memo ?? EMPTY_MEMO) });
  const saved = useMemo(
    () => normalizeMemo({ candidates: extra.candidates, reason: extra.reason }),
    [extra.candidates, extra.reason],
  );

  return (
    <article className="mcard" aria-labelledby={labelId}>
      <div className="mthumb-empty">迷いマークなし</div>
      <div className="mbody">
        <div className="mtop">
          <h3 className="mlabel" id={labelId}>
            追加のメモ
          </h3>
          <span className="mclock">手で足した</span>
        </div>
        <p className="mwhat">{decision === null ? '局面を読み出せません' : decision.label}</p>
        <MemoFields
          name={`追加のメモ ${decision === null ? extra.decision : decision.label}`}
          saved={saved}
          firstRef={firstRef}
          onPersist={(after) => api.setExtraMemo(sessionId, extra.id, extra.decision, after ?? EMPTY_MEMO)}
          onCommit={(before, after) =>
            undo.run(
              extraMemoCommand(api, reload, {
                sessionId,
                id: extra.id,
                before: asExtra(before),
                after: asExtra(after),
              }),
            )
          }
        />
        <div className="mctl">
          <button
            type="button"
            className="link-btn"
            aria-label="追加のメモを消す"
            onClick={() => {
              void undo
                .run(extraMemoCommand(api, reload, { sessionId, id: extra.id, before: extra, after: undefined }))
                .catch(() => undefined);
            }}
          >
            消す
          </button>
        </div>
      </div>
    </article>
  );
}

interface AddPanelProps {
  decisions: readonly DecisionRef[];
  onAdd: (decision: DecisionRef, memo: MemoEntry | undefined) => Promise<void>;
  onCancel: () => void;
}

/** 「迷いマークの無い迷いを足す」: 局 → 判断（この半荘の判断から手で選ぶ）→ 候補・理由 →「足す」。 */
function AddPanel({ decisions, onAdd, onCancel }: AddPanelProps) {
  const headingId = useId();
  const candidatesId = useId();
  const reasonId = useId();
  const [kyoku, setKyoku] = useState<number | null>(null);
  const [decision, setDecision] = useState<DecisionRef | null>(null);
  const [candidates, setCandidates] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 開いたら、見出しにキーボードの位置を移す（押したボタンは消えるため）
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const kyokus = kyokuOptions(decisions);
  const kyokuLabel = kyokus.find((option) => option.position === kyoku)?.label ?? null;
  const options = kyoku === null ? [] : decisionOptions(decisions, kyoku);
  const decisionLabel = options.find((option) => option.key === decision?.key)?.label ?? null;

  const submit = () => {
    if (decision === null) return;
    setError(null);
    onAdd(decision, normalizeMemo({ candidates, reason })).catch((failure: unknown) => {
      setError(`メモを足せませんでした: ${errorMessage(failure)}`);
    });
  };

  return (
    <section className="panel inline-import memo-add" aria-labelledby={headingId}>
      <h3 className="mlabel" id={headingId} ref={headingRef} tabIndex={-1}>
        迷いマークの無い迷いを足す
      </h3>
      <p className="quiet">画像が無いので、局と巡目は手で選びます。</p>
      <div className="memo" role="group" aria-label="追加するメモ">
        <div className="field">
          <span className="lbl">局と巡目</span>
          <div className="where" role="group" aria-label="追加するメモの局と巡目">
            {/* 局を選び直したら、判断の選びは、その局の中のものではなくなるので、外す */}
            <MenuSelect
              className="sel-btn"
              label={kyokuLabel === null ? '追加するメモの局を選ぶ' : `追加するメモの局 ${kyokuLabel}`}
              menuLabel="追加するメモの局"
              items={kyokus.map((option) => ({
                key: String(option.position),
                label: option.label,
                checked: option.position === kyoku,
                onSelect: () => {
                  if (option.position !== kyoku) setDecision(null);
                  setKyoku(option.position);
                },
              }))}
            >
              <span className={kyokuLabel === null ? 'sel-v sel-ph' : 'sel-v'}>{kyokuLabel ?? '局'}</span>
              <Icon name="chevronDown" className="sel-ic" />
            </MenuSelect>
            <MenuSelect
              className="sel-btn"
              label={decisionLabel === null ? '追加するメモの巡目と判断を選ぶ' : `追加するメモの判断 ${decisionLabel}`}
              menuLabel="追加するメモの判断"
              disabled={kyoku === null}
              items={options.map((option) => ({
                key: option.key,
                label: option.label,
                checked: option.key === decision?.key,
                onSelect: () => setDecision(option.ref),
              }))}
            >
              <span className={decisionLabel === null ? 'sel-v sel-ph' : 'sel-v'}>{decisionLabel ?? '巡目と判断'}</span>
              <Icon name="chevronDown" className="sel-ic" />
            </MenuSelect>
          </div>
        </div>
        <div className="field">
          <label htmlFor={candidatesId}>候補</label>
          <input
            className="input sm"
            id={candidatesId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={MEMO_CANDIDATES_MAX}
            placeholder="例: 3m・6p"
            value={candidates}
            onChange={(event) => setCandidates(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={reasonId}>理由（1行）</label>
          <input
            className="input sm"
            id={reasonId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={MEMO_REASON_MAX}
            placeholder="考えたことを1行で"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      {error !== null && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn primary sm" disabled={decision === null} onClick={submit}>
          足す
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          やめる
        </button>
      </div>
    </section>
  );
}
