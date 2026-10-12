import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { kyokuLabel, type DecisionRef } from '@jantama/engine';

import { api, errorMessage } from '../api/tauri';
import type { ExtraMemo, ExtraMemoPlace, MemoEntry, MemoPosition, SessionRecord } from '../api/types';
import { decisionOptions, kyokuOptions } from './markCards';
import { Icon } from './Icon';
import { MemoFields } from './MemoFields';
import { extraMemoCommand } from './memoEdits';
import {
  EMPTY_MEMO,
  MEMO_CANDIDATES_MAX,
  MEMO_HONBA_MAX,
  MEMO_JUNME_MAX,
  MEMO_JUNME_MIN,
  MEMO_KYOKU_CHOICES,
  MEMO_REASON_MAX,
  autoLinkTarget,
  decisionsNearPosition,
  nextExtraId,
  normalizeMemo,
  parseWhole,
  placeOf,
  placePickLabels,
  positionText,
  type NearDecisions,
} from './memos';
import { MenuSelect } from './MenuSelect';
import { useUndo } from './undo/UndoProvider';

/**
 * 迷いマークの無い迷いのメモ（F4、U-28）: 迷いのカードの並びの下の、追加のメモのカードと、「迷いマークの無い迷いを足す」。
 *
 * 足し方は、半荘に判断の一覧があるかで変わる:
 * - 結果を取り込む前（判断の一覧が無い）: 局のメニューと、本場・巡目の数を手で入れる。判断の鍵は持たず、位置（局・本場・巡目）で保存する
 * - 結果を取り込んだあと: 局のメニュー → 判断のメニューで、この半荘の判断から選ぶ。判断の鍵で保存する
 * 取り込む前に足した位置だけのメモは、取り込んだあと、その位置に自分の判断がちょうど 1 つあれば、自動でその判断の鍵を足す
 * （位置は残す。`autoLinkTarget`）。そうでなければ、そのメモのカードに「局面を選んでください」と、その巡目（無ければ局）の判断を出して、
 * 選んでもらう（AI の候補・確率・順位は出さない。SPEC F3）。答え合わせのあとの「終局直後のメモ」には、判断の鍵が付いたメモと、位置にある判断が
 * ちょうど 1 つの位置だけのメモ（このページを開く前でも。`memosForDecision`。出すだけで保存しない）が出る。判断が 2 つ以上の位置だけのメモは、選ばれるまで出ない。
 * 足す・書き直す・局面を選ぶ・消すは、取り消せる（U-11）。
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
  // 判断の一覧があれば、判断から選んで足す。取り込む前（一覧が無い）なら、位置を手で選んで足す。
  // 取り込み済みで、結果をまだ読んでいる間・読めなかったときは、足せない（読み込みが済むまで、足すボタンも出さない）
  const mode = decisions.length > 0 ? 'decision' : imported ? 'none' : 'position';

  // 位置だけのメモに、位置にある判断がちょうど 1 つあれば、判断の鍵を足す（取り消しの履歴には載せない。利用者の操作ではない）。
  // 保存中の名前は重ねて保存せず、保存できなかったものは、この画面の間は、もう試さない
  const linking = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  useEffect(() => {
    for (const extra of extras) {
      const target = autoLinkTarget(extra, decisions);
      if (target === null) continue;
      const mark = `${extra.id}:${target.key}`;
      if (linking.current.has(extra.id) || failed.current.has(mark)) continue;
      linking.current.add(extra.id);
      void api
        .setExtraMemo(session.id, extra.id, { ...placeOf(extra), decision: target.key }, { candidates: extra.candidates, reason: extra.reason })
        .then(reload)
        .catch(() => failed.current.add(mark))
        .finally(() => linking.current.delete(extra.id));
    }
  }, [extras, decisions, session.id, reload]);

  const add = async (place: ExtraMemoPlace, memo: MemoEntry | undefined): Promise<void> => {
    const id = nextExtraId(extras);
    const after: ExtraMemo = { id, ...place, ...(memo ?? EMPTY_MEMO) };
    await undo.run(extraMemoCommand(api, reload, { sessionId: session.id, id, before: undefined, after }));
    setJustAdded(id);
    setAdding(false);
  };

  const closePanel = () => {
    setAdding(false);
    // パネルが消えるので、キーボードの位置は、開いたボタンへ戻す
    window.requestAnimationFrame(() => addRef.current?.focus());
  };

  return (
    <>
      {extras.length > 0 && (
        <ul className="marks extras" aria-label="追加のメモの一覧">
          {extras.map((extra) => {
            // 保存した判断の鍵の判断。位置だけのメモは、位置にある判断がちょうど 1 つなら、保存し終わるまでの間も、その判断として出す
            const decision = extra.decision === undefined ? autoLinkTarget(extra, decisions) : (refOf.get(extra.decision) ?? null);
            const near =
              decision === null && extra.decision === undefined && extra.position !== undefined && decisions.length > 0
                ? decisionsNearPosition(extra.position, decisions)
                : null;
            return (
              <li key={extra.id}>
                <ExtraMemoCard
                  sessionId={session.id}
                  extra={extra}
                  decision={decision}
                  near={near}
                  reload={reload}
                  focusOnMount={justAdded === extra.id}
                />
              </li>
            );
          })}
        </ul>
      )}
      {adding && mode === 'decision' && (
        <AddPanel decisions={decisions} onAdd={(decision, memo) => add({ decision: decision.key }, memo)} onCancel={closePanel} />
      )}
      {adding && mode === 'position' && (
        <PositionPanel onAdd={(position, memo) => add({ position }, memo)} onCancel={closePanel} />
      )}
      {!adding && mode !== 'none' && (
        <div className="memo-foot">
          <button type="button" className="btn sm" ref={addRef} onClick={() => setAdding(true)}>
            <PlusIcon />
            迷いマークの無い迷いを足す
          </button>
        </div>
      )}
    </>
  );
}

interface ExtraMemoCardProps {
  sessionId: string;
  extra: ExtraMemo;
  /** メモが結びつく判断（無ければ null）。 */
  decision: DecisionRef | null;
  /** 判断が決まっていない位置だけのメモの、位置の近くの判断（選んでもらう物）。それ以外は null。 */
  near: NearDecisions | null;
  reload: () => Promise<void>;
  focusOnMount: boolean;
}

/** 追加のメモ 1 つのカード（画像の代わりに「迷いマークなし」の箱）。 */
function ExtraMemoCard({ sessionId, extra, decision, near, reload, focusOnMount }: ExtraMemoCardProps) {
  const undo = useUndo();
  const labelId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) firstRef.current?.focus({ preventScroll: false });
  }, [focusOnMount]);

  // 打っている途中の書き込みや、欄の外へ出たときの命令は、そのときのメモ全体（局面を含む）を書き直す。局面が、自動の結びつけや
  // 選んだことで、打っている間に替わっても、古い局面で上書きしないよう、いちばん新しいメモを見る
  const latest = useRef(extra);
  useEffect(() => {
    latest.current = extra;
  }, [extra]);
  const asExtra = (memo: MemoEntry | undefined): ExtraMemo => ({ ...latest.current, ...(memo ?? EMPTY_MEMO) });
  const saved = useMemo(
    () => normalizeMemo({ candidates: extra.candidates, reason: extra.reason }),
    [extra.candidates, extra.reason],
  );

  // 局面の呼び名: 判断が決まっていれば、その判断。無ければ位置。どちらも読み出せなければ、そう伝える
  const where = decision !== null ? decision.label : extra.position !== undefined ? positionText(extra.position) : '局面を読み出せません';

  const link = (ref: DecisionRef): void => {
    const current = latest.current;
    void undo
      .run(
        extraMemoCommand(api, reload, {
          sessionId,
          id: current.id,
          before: current,
          after: { ...current, decision: ref.key },
          link: `${ref.kyokuLabel} ${ref.junme}巡目`,
        }),
      )
      // 選んだら、この選びのボタンは無くなる。キーボードの位置は、次に書く「候補」へ移す
      .then(() => firstRef.current?.focus())
      .catch(() => undefined);
  };

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
        <p className="mwhat">{where}</p>
        {near !== null && <PickDecision near={near} onPick={link} />}
        <MemoFields
          name={`追加のメモ ${where}`}
          saved={saved}
          firstRef={firstRef}
          onPersist={(after) => api.setExtraMemo(sessionId, extra.id, placeOf(latest.current), after ?? EMPTY_MEMO)}
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
                .run(extraMemoCommand(api, reload, { sessionId, id: extra.id, before: latest.current, after: undefined }))
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

/**
 * 位置だけのメモの「局面を選んでください」: 位置の近くの判断（その巡目。無ければ、その局・本場。それも無ければ、その局）から選ぶ。
 * 判断の名前は、自分が実際にした行動だけで、AI の答えは出さない。判断がどこにも無いときは、そう伝える。
 */
function PickDecision({ near, onPick }: { near: NearDecisions; onPick: (ref: DecisionRef) => void }) {
  if (near.options.length === 0) return <p className="mread">この局には、自分の判断がありません。</p>;
  const labels = placePickLabels(near.options);
  return (
    <div className="where">
      <MenuSelect
        className="sel-btn"
        label="追加のメモの局面を選んでください"
        menuLabel="追加のメモの局面"
        items={near.options.map((option, i) => ({
          key: option.key,
          label: labels[i] ?? option.label,
          checked: false,
          onSelect: () => onPick(option),
        }))}
      >
        <span className="sel-v sel-ph">局面を選んでください</span>
        <Icon name="chevronDown" className="sel-ic" />
      </MenuSelect>
    </div>
  );
}

interface AddPanelProps {
  decisions: readonly DecisionRef[];
  onAdd: (decision: DecisionRef, memo: MemoEntry | undefined) => Promise<void>;
  onCancel: () => void;
}

/** 「迷いマークの無い迷いを足す」（取り込んだあと）: 局 → 判断（この半荘の判断から手で選ぶ）→ 候補・理由 →「足す」。 */
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
  const kyokuLabelText = kyokus.find((option) => option.position === kyoku)?.label ?? null;
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
              label={kyokuLabelText === null ? '追加するメモの局を選ぶ' : `追加するメモの局 ${kyokuLabelText}`}
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
              <span className={kyokuLabelText === null ? 'sel-v sel-ph' : 'sel-v'}>{kyokuLabelText ?? '局'}</span>
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

interface PositionPanelProps {
  onAdd: (position: MemoPosition, memo: MemoEntry | undefined) => Promise<void>;
  onCancel: () => void;
}

/**
 * 「迷いマークの無い迷いを足す」（取り込む前）: 局のメニュー（東1局〜西4局）・本場（既定 0）・巡目（1〜30）→ 候補・理由 →「足す」。
 * 判断の一覧が無いので、局・本場・巡目を手で入れる。局のメニューは、結果を見ずに決められないので、西1局〜西4局までを常に並べる
 * （取り込む前の半荘には、西入したかどうかを決める材料が無い）。
 */
function PositionPanel({ onAdd, onCancel }: PositionPanelProps) {
  const headingId = useId();
  const candidatesId = useId();
  const reasonId = useId();
  const honbaHintId = useId();
  const junmeHintId = useId();
  const [kyoku, setKyoku] = useState<number | null>(null);
  const [honba, setHonba] = useState('0');
  const [junme, setJunme] = useState('');
  const [candidates, setCandidates] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 開いたら、見出しにキーボードの位置を移す（押したボタンは消えるため）
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const honbaValue = parseWhole(honba, 0, MEMO_HONBA_MAX);
  const junmeValue = parseWhole(junme, MEMO_JUNME_MIN, MEMO_JUNME_MAX);
  // 入れたのに範囲の外（空は、まだ入れていないだけなので、言わない）
  const honbaBad = honba.trim() !== '' && honbaValue === null;
  const junmeBad = junme.trim() !== '' && junmeValue === null;
  const ready = kyoku !== null && honbaValue !== null && junmeValue !== null;
  const kyokuText = kyoku === null ? null : kyokuLabel(kyoku, 0);

  const submit = () => {
    if (kyoku === null || honbaValue === null || junmeValue === null) return;
    setError(null);
    onAdd({ kyoku, honba: honbaValue, junme: junmeValue }, normalizeMemo({ candidates, reason })).catch((failure: unknown) => {
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
            <MenuSelect
              className="sel-btn"
              label={kyokuText === null ? '追加するメモの局を選ぶ' : `追加するメモの局 ${kyokuText}`}
              menuLabel="追加するメモの局"
              items={MEMO_KYOKU_CHOICES.map((number) => ({
                key: String(number),
                label: kyokuLabel(number, 0),
                checked: number === kyoku,
                onSelect: () => setKyoku(number),
              }))}
            >
              <span className={kyokuText === null ? 'sel-v sel-ph' : 'sel-v'}>{kyokuText ?? '局'}</span>
              <Icon name="chevronDown" className="sel-ic" />
            </MenuSelect>
            <input
              className="input sm num"
              type="number"
              inputMode="numeric"
              min={0}
              max={MEMO_HONBA_MAX}
              aria-label="本場"
              aria-invalid={honbaBad}
              aria-describedby={honbaBad ? honbaHintId : undefined}
              placeholder="0"
              value={honba}
              onChange={(event) => setHonba(event.target.value)}
            />
            <span className="unit" aria-hidden="true">
              本場
            </span>
            <input
              className="input sm num"
              type="number"
              inputMode="numeric"
              min={MEMO_JUNME_MIN}
              max={MEMO_JUNME_MAX}
              aria-label="巡目"
              aria-invalid={junmeBad}
              aria-describedby={junmeBad ? junmeHintId : undefined}
              placeholder="6"
              value={junme}
              onChange={(event) => setJunme(event.target.value)}
            />
            <span className="unit" aria-hidden="true">
              巡目
            </span>
          </div>
          {honbaBad && (
            <p className="quiet" id={honbaHintId}>
              本場は 0〜{MEMO_HONBA_MAX} で入れてください。
            </p>
          )}
          {junmeBad && (
            <p className="quiet" id={junmeHintId}>
              巡目は {MEMO_JUNME_MIN}〜{MEMO_JUNME_MAX} で入れてください。
            </p>
          )}
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
        <button type="button" className="btn primary sm" disabled={!ready} onClick={submit}>
          足す
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          やめる
        </button>
      </div>
    </section>
  );
}
