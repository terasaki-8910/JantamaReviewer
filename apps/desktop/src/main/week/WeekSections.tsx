/**
 * 週の集計（U-30、R11-12）の各区画。承認済みの見本（11回目の week.js）の形と言葉を、そのまま React に移したもの。
 * 数は `weekModel.ts`（純粋な数え方）が出し、ここは並べるだけ。操作の説明の文は、説明のアイコン（InfoTip。R11-1）に載せる。
 * 区画: 今週の数・差の原因（横棒と、原因ごとの 8 週の小さな線）・局面の種類・局の評価（一致率と、結果ごとのずれ）・
 * 成績（手入力）・来週の重点。どの図にも、吹き出し（マウス・矢印キー）と「表で見る」。
 */
import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { WeekRecord } from '../../api/types';
import { InfoTip } from '../InfoTip';
import { useChartTip } from './ChartTip';
import { DataTable, Fig, LineChart, ScrollWrap, useRovingTip } from './WeekCharts';
import {
  CAUSES,
  RESULTS,
  loseMean,
  percentSparkRange,
  sharedCauseMax,
  slashText,
  valueSparkRange,
  weekNameText,
  type WeekSummary,
} from './weekModel';
import { STAT_FIELDS, parseFocus, parseStat, statText, withFocus, withStat, type StatField } from './weekRecords';

/** 週の呼び方: 今週は「今週」、ほかは「この週」。 */
export const thisWeekWord = (isCurrent: boolean): string => (isCurrent ? '今週' : 'この週');

/** マイナスは U+2212（見本の書き方）。 */
const fixed = (value: number, digits: number): string => value.toFixed(digits).replace('-', '−');

/** 見出しと、見出しのそばの説明のアイコン（任意）。 */
function SectionHead({ id, title, hint, children }: { id: string; title: string; hint?: { label: string; text: string } | null; children?: ReactNode }) {
  return (
    <div className="sec-head">
      <h2 className="sec-title" id={id}>
        {title}
      </h2>
      {hint !== null && hint !== undefined && <InfoTip label={hint.label}>{hint.text}</InfoTip>}
      {children}
    </div>
  );
}

interface WindowProps {
  /** 直近 8 週の月曜（古い順）。最後が、見ている週。 */
  weeks: readonly string[];
  /** 週の月曜 → 数。 */
  byWeek: ReadonlyMap<string, WeekSummary>;
  /** 見ている週の数。 */
  summary: WeekSummary;
  /** 見ている週が今週か。 */
  isCurrent: boolean;
}

/** 小さな図の左右の端の週の名前（8/17 と 10/5 のような）。 */
const edgeLabels = (weeks: readonly string[]): readonly [string, string] => [slashText(weeks[0] as string), slashText(weeks[weeks.length - 1] as string)];

// ---- 今週の数 ----

function Tile({ k, value, sub }: { k: string; value: ReactNode; sub: string }) {
  return (
    <li className="wk-tile">
      <span className="k">{k}</span>
      <span className="v">{value}</span>
      <span className="s">{sub}</span>
    </li>
  );
}

export function TilesSection({ summary: s, isCurrent }: Pick<WindowProps, 'summary' | 'isCurrent'>) {
  const id = useId();
  const title = isCurrent ? '今週の数' : 'この週の数';
  return (
    <section className="wk-sec" aria-labelledby={id}>
      <h2 className="sec-title" id={id}>
        {title}
      </h2>
      <ul className="wk-tiles" aria-label={title}>
        <Tile
          k="解いた問題"
          value={
            <>
              {s.answers}
              <small>問</small>
            </>
          }
          sub={`出題 ${s.quiz}・解き直し ${s.review}`}
        />
        <Tile
          k="正解率"
          value={
            s.correctPercent === null ? (
              '—'
            ) : (
              <>
                {s.correctPercent}
                <small>%</small>
              </>
            )
          }
          sub={s.answers === 0 ? 'まだ答えがありません' : `${s.correct} / ${s.answers}問`}
        />
        <Tile k="迷いマーク" value={s.marks} sub={s.marks === 0 ? '' : `うち答えたもの ${s.marksAnswered}`} />
        <Tile k="半荘" value={s.games} sub={s.games === 0 ? '' : '取り込んだ半荘'} />
      </ul>
    </section>
  );
}

// ---- 差の原因 ----

/** 原因ごとの割合の横棒。1 つの Tab の止まり場所で、矢印キーで棒を選ぶ。 */
function CauseBars({ summary, isCurrent, week }: Pick<WindowProps, 'summary' | 'isCurrent'> & { week: string }) {
  const tip = useChartTip();
  const items = useRef<Array<HTMLLIElement | null>>([]);
  const percents = summary.causePercents;
  const values = CAUSES.map((c) => ({
    ...c,
    percent: percents === null ? 0 : percents[c.id],
    count: summary.causeCounts[c.id],
  }));
  const text = (i: number): [string, string] => {
    const row = values[i];
    return [`${row?.percent}%（${row?.count}局面）`, `${row?.label}・${weekNameText(week)}`];
  };
  const { active, groupProps } = useRovingTip(
    CAUSES.length,
    '差の原因の割合',
    (i) => {
      const fill = items.current[i]?.querySelector('.wk-fill');
      const rect = fill?.getBoundingClientRect();
      if (rect === undefined) return;
      const [value, label] = text(i);
      tip.show(value, label, rect.right, rect.top + rect.height / 2, true);
    },
    tip.hide,
  );
  return (
    // 矢印キーで選ぶ入れ物は、リストの外側の div に置く（li の親の役割を変えないため）
    <div {...groupProps}>
      <ul className="wk-bars" aria-label={`${thisWeekWord(isCurrent)}の差の原因`}>
        {values.map((row, i) => (
          <li
            key={row.id}
            className="wk-bar"
            data-tip
            data-active={active === i ? 'true' : undefined}
            style={{ '--p': row.percent } as CSSProperties}
            ref={(element) => {
              items.current[i] = element;
            }}
            onPointerMove={(event) => {
              const [value, label] = text(i);
              tip.show(value, label, event.clientX, event.clientY - 4);
            }}
            onPointerLeave={tip.hide}
          >
            <span className="nm">{row.label}</span>
            <span className="wk-track" aria-hidden="true">
              <span className="wk-fill" />
            </span>
            <span className="val">
              <b>{row.percent}%</b>（{row.count}局面）
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 原因ごとの直近 8 週の小さな線（縦軸はどれも同じ）。 */
function CauseTrends({ weeks, byWeek, isCurrent }: Pick<WindowProps, 'weeks' | 'byWeek' | 'isCurrent'>) {
  const summaries = weeks.map((w) => byWeek.get(w) as WeekSummary);
  const top = sharedCauseMax(summaries);
  const ticks = [0, top / 2, top];
  const word = thisWeekWord(isCurrent);
  const xl = edgeLabels(weeks);
  const percentOf = (s: WeekSummary, id: (typeof CAUSES)[number]['id']): number | null => (s.causePercents === null ? null : s.causePercents[id]);
  return (
    <Fig
      id="multi"
      title="直近8週の推移"
      sub={`縦の目盛りは、どの図も 0〜${top}%。淡い帯が${word}です`}
      chart={
        <ul className="wk-multi" aria-label="原因ごとの直近8週の割合">
          {CAUSES.map((c) => {
            const values = summaries.map((s) => percentOf(s, c.id));
            const tips = summaries.map((s, k): readonly [string, string] => {
              const p = percentOf(s, c.id);
              return p === null
                ? ['データなし', `${c.label}・${weekNameText(weeks[k] as string)}`]
                : [`${p}%（${s.causeCounts[c.id]}局面）`, `${c.label}・${weekNameText(weeks[k] as string)}`];
            });
            const now = values[values.length - 1] ?? null;
            return (
              <li className="wk-small" key={c.id}>
                <div className="wk-smallh">
                  <span className="nm">{c.label}</span>
                  <span className="wk-now">
                    {word} <b>{now === null ? '—' : `${now}%`}</b>
                  </span>
                </div>
                <LineChart
                  label={`${c.label}の割合（直近8週）`}
                  values={values}
                  min={0}
                  max={top}
                  ticks={ticks}
                  tickLabel={(t) => `${t}%`}
                  height={76}
                  tips={tips}
                  xl={xl}
                />
              </li>
            );
          })}
        </ul>
      }
      table={
        <DataTable
          caption="原因ごとの直近8週の割合（かっこは局面の数）"
          head={['週', ...CAUSES.map((c) => c.label)]}
          rows={summaries.map((s, k) => [
            `${slashText(weeks[k] as string)}の週`,
            ...CAUSES.map((c) => {
              const p = percentOf(s, c.id);
              return p === null ? '—' : `${p}%（${s.causeCounts[c.id]}）`;
            }),
          ])}
          current={weeks.length - 1}
        />
      }
    />
  );
}

export function CausesSection(props: WindowProps & { week: string }) {
  const { summary: s, isCurrent, week } = props;
  const id = useId();
  const word = thisWeekWord(isCurrent);
  const rows = CAUSES.map((c) => [
    c.label,
    s.causePercents === null ? '—' : `${s.causePercents[c.id]}%`,
    `${s.causeCounts[c.id]}局面`,
  ]);
  return (
    <section className="wk-sec" aria-labelledby={id}>
      <SectionHead
        id={id}
        title="差の原因"
        hint={
          s.answers === 0
            ? null
            : {
                label: '差の原因の割合の説明',
                text: `${word}答えた ${s.answers}局面のうち、それぞれの原因が付いた局面の割合です。1つの局面に原因が2つ付くと両方に数えるので、合計は100%を超えます。`,
              }
        }
      />
      {s.answers === 0 ? (
        <p className="wk-empty">この週は、答えた問題がありません。</p>
      ) : (
        <Fig
          id="bars"
          title="原因ごとの割合"
          chart={<CauseBars summary={s} isCurrent={isCurrent} week={week} />}
          table={<DataTable caption="原因ごとの割合と局面の数" head={['原因', '割合', '局面の数']} rows={rows} />}
        />
      )}
      <CauseTrends weeks={props.weeks} byWeek={props.byWeek} isCurrent={isCurrent} />
    </section>
  );
}

// ---- 局面の種類 ----

/** 局面の種類の表。行の細い棒は、正解率（マウスを乗せると数字が出る。数字は、表の文字にもある）。 */
export function PhaseSection({ summary: s }: Pick<WindowProps, 'summary'>) {
  const id = useId();
  const tip = useChartTip();
  return (
    <section className="wk-sec" aria-labelledby={id}>
      <SectionHead
        id={id}
        title="局面の種類"
        hint={s.answers === 0 ? null : { label: '局面の種類の説明', text: '種類は重なります（1向聴の序盤の問題は、両方に数えます）。' }}
      />
      {s.answers === 0 ? (
        <p className="wk-empty">この週は、答えた問題がありません。</p>
      ) : (
        <ScrollWrap caption="局面の種類ごとの問題の数と正解率">
          <table className="wk-tbl">
            <caption className="sr-only">局面の種類ごとの問題の数と正解率</caption>
            <thead>
              <tr>
                <th scope="col">種類</th>
                <th scope="col" className="num">
                  問題の数
                </th>
                <th scope="col">正解率</th>
              </tr>
            </thead>
            <tbody>
              {s.phases.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.id}</th>
                  <td className="num">{row.n}問</td>
                  <td className="rate">
                    <div
                      className="wk-rate"
                      data-tip
                      style={{ '--p': row.rate ?? 0 } as CSSProperties}
                      onPointerMove={(event) => {
                        if (row.rate === null) return;
                        tip.show(`${row.rate}%（${row.n}問）`, `${row.id}・正解率`, event.clientX, event.clientY - 4);
                      }}
                      onPointerLeave={tip.hide}
                    >
                      <span className="wk-track" aria-hidden="true">
                        {row.rate !== null && <span className="wk-fill" />}
                      </span>
                      <span className="num">{row.rate === null ? '—' : `${row.rate}%`}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollWrap>
      )}
    </section>
  );
}

// ---- 局の評価 ----

/** 中央が 0 のずれの図の、左右の位置（%）。-2 から 2 に収める。 */
const dotX = (value: number): number => ((Math.max(-2, Math.min(2, value)) + 2) / 4) * 100;

function DotPlot({ summary: s }: Pick<WindowProps, 'summary'>) {
  const tip = useChartTip();
  const lanes = useRef<Array<HTMLDivElement | null>>([]);
  const textOf = (i: number): [string, string] => {
    const row = s.results[i];
    const value = row?.mean === null || row === undefined ? '—' : `平均 ${fixed(row.mean, 1)} 段階`;
    return [value, `${row?.label}・${row?.n}局`];
  };
  const { active, groupProps } = useRovingTip(
    RESULTS.length,
    '結果ごとのずれ',
    (i) => {
      const lane = lanes.current[i];
      if (lane === null || lane === undefined) return;
      const dot = lane.querySelector('.dot')?.getBoundingClientRect();
      const box = lane.getBoundingClientRect();
      const [value, label] = textOf(i);
      tip.show(value, label, dot === undefined ? box.left + box.width / 2 : dot.left + dot.width / 2, dot === undefined ? box.top : dot.top, true);
    },
    tip.hide,
  );
  const ticks = [-2, -1, 0, 1, 2];
  return (
    <div className="dp" {...groupProps}>
      <div className="dp-grid" aria-hidden="true">
        {ticks.map((t) => (
          <i key={t} className={t === 0 ? 'z' : undefined} style={{ left: `${dotX(t)}%` }} />
        ))}
      </div>
      {s.results.map((row, i) => {
        const left = row.mean === null ? 0 : dotX(row.mean);
        const [value, label] = textOf(i);
        return (
          <div className="dp-row" key={row.id}>
            <div className="dp-lbl">
              {row.label}
              <small className="dp-n">{row.n}局</small>
            </div>
            <div
              className="dp-lane"
              data-tip
              data-active={active === i ? 'true' : undefined}
              ref={(element) => {
                lanes.current[i] = element;
              }}
              onPointerMove={(event) => tip.show(value, label, event.clientX, event.clientY - 4)}
              onPointerLeave={tip.hide}
            >
              {row.mean !== null && (
                <>
                  <i className="dot" style={{ left: `${left}%` }} />
                  <span
                    className="dp-v"
                    style={
                      row.mean >= 0
                        ? { left: `calc(${left.toFixed(2)}% + 12px)` }
                        : { right: `calc(${(100 - left).toFixed(2)}% + 12px)` }
                    }
                  >
                    {fixed(row.mean, 1)}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="dp-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${dotX(t)}%` }}>
            {t > 0 ? '+' : t < 0 ? '−' : ''}
            {Math.abs(t)}
          </span>
        ))}
      </div>
      <div className="dp-dir">
        <span>AIより低く付けた ←</span> <span>→ AIより高く付けた</span>
      </div>
    </div>
  );
}

/** 一致率: 大きな数と、直近 8 週の小さな線。 */
function AgreeFig({ weeks, byWeek, summary: s }: Pick<WindowProps, 'weeks' | 'byWeek' | 'summary'>) {
  const summaries = weeks.map((w) => byWeek.get(w) as WeekSummary);
  const values = summaries.map((x) => x.agreePercent);
  const { min, max } = percentSparkRange(values);
  const tips = values.map((v, k): readonly [string, string] => [v === null ? 'データなし' : `${v}%`, `一致率・${weekNameText(weeks[k] as string)}`]);
  return (
    <Fig
      id="agree"
      title="一致率"
      className="wk-figbig"
      chart={
        <div className="wk-big">
          <span className="k">自分の〇△✕が AI 基準と合った割合</span>
          <span className="v">
            {s.agreePercent === null ? (
              '—'
            ) : (
              <>
                {s.agreePercent}
                <small>%</small>
              </>
            )}
          </span>
          <span className="s">{s.evaluated === 0 ? 'この週は評価を付けた局がありません' : `${s.evaluated}局のうち ${s.agreed}局が一致`}</span>
          <LineChart label="一致率（直近8週）" values={values} min={min} max={max} height={44} spark tips={tips} xl={edgeLabels(weeks)} />
        </div>
      }
      table={
        <DataTable
          caption="一致率の直近8週"
          head={['週', '一致率']}
          rows={summaries.map((x, k) => [`${slashText(weeks[k] as string)}の週`, x.agreePercent === null ? '—' : `${x.agreePercent}%`])}
          current={weeks.length - 1}
        />
      }
    />
  );
}

/** 「和了できなかった局を、AI より平均 0.8 段階低く付けています」の 1 文。比べた局が無ければ空。 */
export function loseSentence(s: WeekSummary): string {
  const lose = loseMean(s);
  if (lose === null) return '';
  const size = Math.round(Math.abs(lose.mean) * 10) / 10;
  if (size === 0) return '和了できなかった局（放銃・他家の和了）を、AI と同じくらいに付けています';
  return `和了できなかった局（放銃・他家の和了）を、AI より平均 ${size.toFixed(1)} 段階${lose.mean < 0 ? '低く' : '高く'}付けています`;
}

export function EvaluationSection({ weeks, byWeek, summary: s }: WindowProps) {
  const id = useId();
  const sentence = loseSentence(s);
  return (
    <section className="wk-sec" aria-labelledby={id}>
      <SectionHead
        id={id}
        title="局の評価"
        hint={{
          label: '一致率とずれの説明',
          text: '〇を3・△を2・✕を1として、自分の評価から AI 基準の評価を引いた平均です。0 は AI と同じ評価です。',
        }}
      />
      {s.evaluated === 0 ? (
        <>
          <p className="wk-empty">この週は、評価を付けた局がありません。</p>
          <AgreeFig weeks={weeks} byWeek={byWeek} summary={s} />
        </>
      ) : (
        <div className="wk-eval">
          <AgreeFig weeks={weeks} byWeek={byWeek} summary={s} />
          <div className="wk-evr">
            <Fig
              id="dots"
              title="結果ごとの、自分と AI 基準のずれ"
              chart={<DotPlot summary={s} />}
              table={
                <DataTable
                  caption="局の結果ごとの、自分の評価と AI 基準の差の平均（段階）"
                  head={['結果', '局数', '差の平均（段階）']}
                  rows={s.results.map((r) => [r.label, `${r.n}局`, r.mean === null ? '—' : fixed(r.mean, 1)])}
                />
              }
            />
            {sentence !== '' && (
              <p className="wk-note">
                <b>{sentence}</b>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---- 成績（手入力） ----

interface StatInputProps {
  field: StatField;
  stored: number | undefined;
  /** 入れた数（null は、消した）を保存する。できたら null、できなければ理由の文。 */
  onCommit: (value: number | null) => Promise<string | null>;
  /** 入力が始まった（「保存しました」を消す）。 */
  onEdit: () => void;
  spark: ReactNode;
}

function StatInput({ field, stored, onCommit, onEdit, spark }: StatInputProps) {
  const id = useId();
  const errorId = `${id}-err`;
  const storedText = statText(stored, field);
  const [draft, setDraft] = useState(storedText);
  const [error, setError] = useState<string | null>(null);
  // 保存してある値が替わったら（保存できた・ほかから替わった）、欄も合わせる（描いている途中で、値を合わせ直す。欄は作り直さない）
  const [synced, setSynced] = useState(storedText);
  if (synced !== storedText) {
    setSynced(storedText);
    setDraft(storedText);
    setError(null);
  }

  const commit = async () => {
    const parsed = parseStat(draft, field);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    if (parsed.value === (stored ?? null)) {
      setDraft(statText(stored, field));
      return;
    }
    const failure = await onCommit(parsed.value);
    if (failure !== null) setError(failure);
    else setDraft(statText(parsed.value ?? undefined, field));
  };

  return (
    <li className="wk-recc">
      <label htmlFor={id}>{field.label}</label>
      <div className="wk-in">
        <input
          className="input sm"
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={field.placeholder}
          value={draft}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setDraft(event.target.value);
            onEdit();
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              setDraft(statText(stored, field));
              setError(null);
            }
          }}
        />
        <span className="unit">{field.unit}</span>
      </div>
      {error !== null && (
        <p className="error wk-err" id={errorId} role="alert">
          {error}
        </p>
      )}
      {spark}
    </li>
  );
}

export function RecordSection({
  weeks,
  records,
  save,
}: {
  weeks: readonly string[];
  records: ReadonlyMap<string, WeekRecord>;
  save: (week: string, change: (current: WeekRecord | undefined) => WeekRecord) => Promise<string | null>;
}) {
  const id = useId();
  const week = weeks[weeks.length - 1] as string;
  // 「保存しました」を出している週（別の週を見たら、出さない。入力が始まったら、消す）
  const [savedWeek, setSavedWeek] = useState<string | null>(null);
  const saved = savedWeek === week;
  const xl = edgeLabels(weeks);
  return (
    <section className="wk-sec" aria-labelledby={id}>
      <SectionHead id={id} title="成績（手入力）" hint={{ label: '成績の入れ方の説明', text: '雀魂の成績の画面を見て入れます。' }}>
        {saved && (
          <p className="quiet" role="status">
            保存しました
          </p>
        )}
      </SectionHead>
      <Fig
        id="rec"
        title="週ごとの成績"
        sub="小さな線は直近8週"
        keepChart
        chart={(view) => (
          <ul className="wk-rec" aria-label="成績（手入力）">
            {STAT_FIELDS.map((field) => {
              const values = weeks.map((w) => records.get(w)?.stats[field.key] ?? null);
              const { min, max } = valueSparkRange(values, field.digits === 2 ? 0.05 : 1);
              const tips = values.map((v, k): readonly [string, string] => [
                v === null ? 'データなし' : `${fixed(v, field.digits)}${field.unit}`,
                `${field.label}・${weekNameText(weeks[k] as string)}`,
              ]);
              return (
                <StatInput
                  // 週を替えたら、入れかけの文字・エラーは、作り直して消す
                  key={`${week}:${field.key}`}
                  field={field}
                  stored={records.get(week)?.stats[field.key]}
                  onEdit={() => setSavedWeek(null)}
                  onCommit={async (value) => {
                    const failure = await save(week, (current) => withStat(current, week, field.key, value));
                    if (failure === null) setSavedWeek(week);
                    return failure;
                  }}
                  spark={
                    view === 'chart' ? (
                      <LineChart label={`${field.label}（直近8週）`} values={values} min={min} max={max} height={40} spark tips={tips} xl={xl} />
                    ) : null
                  }
                />
              );
            })}
          </ul>
        )}
        table={
          <DataTable
            caption="週ごとの成績（直近8週）"
            head={['週', ...STAT_FIELDS.map((f) => f.label)]}
            rows={weeks.map((w) => [
              `${slashText(w)}の週`,
              ...STAT_FIELDS.map((f) => {
                const v = records.get(w)?.stats[f.key];
                return v === undefined ? '—' : `${fixed(v, f.digits)}${f.unit}`;
              }),
            ])}
            current={weeks.length - 1}
          />
        }
      />
    </section>
  );
}

// ---- 来週の重点 ----

export function FocusSection({
  week,
  previous,
  stored,
  save,
}: {
  week: string;
  /** 先週に書いた重点（無ければ空）。 */
  previous: string;
  /** この週に書いた（来週の）重点。 */
  stored: string;
  save: (week: string, change: (current: WeekRecord | undefined) => WeekRecord) => Promise<string | null>;
}) {
  const headId = useId();
  const fieldId = useId();
  const errorId = `${fieldId}-err`;
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const [savedWeek, setSavedWeek] = useState<string | null>(null);
  const saved = savedWeek === week;
  // 週か保存してある重点が替わったら、欄も合わせる（描いている途中で、値を合わせ直す。欄は作り直さない）
  const syncKey = `${week}
${stored}`;
  const [synced, setSynced] = useState(syncKey);
  if (synced !== syncKey) {
    setSynced(syncKey);
    setDraft(stored);
    setError(null);
  }

  const commit = async () => {
    const parsed = parseFocus(draft);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    if (parsed.value === stored) {
      setDraft(stored);
      return;
    }
    const failure = await save(week, (current) => withFocus(current, week, parsed.value));
    if (failure !== null) setError(failure);
    else {
      setDraft(parsed.value);
      setSavedWeek(week);
    }
  };

  return (
    <section className="wk-sec" aria-labelledby={headId}>
      <SectionHead id={headId} title="来週の重点">
        {saved && (
          <p className="quiet" role="status">
            保存しました
          </p>
        )}
      </SectionHead>
      <div className="wk-focus">
        {previous !== '' && (
          <div className="wk-prev">
            <span className="k">先週に書いた重点</span>
            <p>{previous}</p>
          </div>
        )}
        <div className="field">
          <label htmlFor={fieldId}>来週の重点（任意。1〜3行）</label>
          <textarea
            className="input"
            id={fieldId}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder="例: 受け入れを数えてから切る"
            value={draft}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            onChange={(event) => {
              setDraft(event.target.value);
              setSavedWeek(null);
            }}
            onBlur={() => void commit()}
          />
        </div>
        {error !== null && (
          <p className="error wk-err" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
