/**
 * 週の集計の「取り込んだ半荘から数えた値（参考）」（F14、E-42、U-37。R15-7 の B）。承認済みの見本（15回目の feature-6-week.html の B）の形:
 * 成績（手入力）のカードはそのまま、その下に別の表を置く。項目・値・もとの数の 3 列と、「半荘ごとに見る」の開閉（半荘ごとの表）。
 * 数えるのは取り込んだ半荘の記録だけ（雀魂の成績の画面は読まない。R14-4）。数え方はエンジンの `hanchanStatOf`（importedStats.ts が組み立てる）。
 * 手入力の成績の値は、ここからは書き換えない（この区画は、保存した成績にも手入力の欄にも触れない）。
 * 取り込んだ半荘が無い週は、表を出さず、1 行だけ。
 * 表の最後の 3 行と、半荘ごとの表の最後の 3 列は、AI 一致率・類似度・悪手率（F18、U-48。数え方はエンジンの `aiMetricsOf`・`totalAiMetrics`）。
 * 週の「一致率」（自分の〇△✕ と AI 基準の一致）とは別の数なので、呼び名は「AI 一致率」。
 */
import { formatRatePercent, formatSimilarity, type AiMetrics, type HanchanStatTotals } from '@jantama/engine';
import { useId, useState } from 'react';

import { groupedNumber } from '../format';
import { Icon } from '../Icon';
import { InfoTip } from '../InfoTip';
import type { ImportedHanchanRow, ImportedWeekStats } from './importedStats';
import { ScrollWrap } from './WeekCharts';

const HINT =
  '取り込んだ半荘の記録だけから数えた値です。雀魂の成績の画面は読みません。対局の数が少ないうえ、数え方も雀魂と同じとは限らないので、雀魂の成績の数字とは合いません。手入力の成績は、そのまま残ります。';

const NONE = '—';
const percent = (value: number | null): string => (value === null ? NONE : `${value.toFixed(1)}%`);
const rankText = (value: number | null): string => (value === null ? NONE : `${value.toFixed(2)}位`);
const pointsText = (value: number | null): string => (value === null ? NONE : `${groupedNumber(Math.round(value))}点`);
/** AI 一致率・悪手率（0 から 1）。 */
const rateText = (value: number | null): string => (value === null ? NONE : formatRatePercent(value));
/** 類似度（0 から 1。Rating と同じ書き方）。 */
const similarityText = (value: number | null): string => (value === null ? NONE : formatSimilarity(value));

interface Item {
  key: string;
  label: string;
  value: string;
  base: string;
}

/** 表の行: 項目・値・もとの数（見本のとおりの書き方）。 */
function itemsOf(t: HanchanStatTotals, ai: AiMetrics): Item[] {
  const games = `${t.hanchanCount}半荘`;
  const kyokus = `${t.kyokuCount}局`;
  const decisions = `${ai.decisions}判断`;
  return [
    { key: 'fourth', label: '4位率', value: percent(t.fourthRate), base: `${t.fourthCount}半荘 / ${games}` },
    { key: 'dealIn', label: '放銃率', value: percent(t.dealInRate), base: `${t.dealInCount}局 / ${kyokus}` },
    { key: 'rank', label: '平均順位', value: rankText(t.averageRank), base: `順位の合計 ${t.rankSum} / ${games}` },
    { key: 'win', label: '和了率', value: percent(t.winRate), base: `${t.winCount}局 / ${kyokus}` },
    { key: 'fulou', label: '副露率', value: percent(t.fulouRate), base: `${t.fulouCount}局 / ${kyokus}` },
    { key: 'riichi', label: '立直率', value: percent(t.riichiRate), base: `${t.riichiCount}局 / ${kyokus}` },
    { key: 'points', label: '平均和了点', value: pointsText(t.averageWinPoints), base: `和了 ${t.winCount}回の点数の合計 ${groupedNumber(t.winPointsSum)}` },
    { key: 'aiMatch', label: 'AI 一致率', value: rateText(ai.matchRate), base: `${ai.matches}判断 / ${decisions}` },
    { key: 'similarity', label: '類似度', value: similarityText(ai.similarity), base: decisions },
    { key: 'badMove', label: '悪手率', value: rateText(ai.badMoveRate), base: `${ai.badMoves}判断 / ${decisions}（確率 5% 未満）` },
  ];
}

/** 半荘ごとの表（「半荘ごとに見る」を開いたとき）。 */
function GameRows({ rows }: { rows: readonly ImportedHanchanRow[] }) {
  return (
    <ScrollWrap caption="半荘ごとの成績">
      <table className="wk-table wk-imp-games">
        <caption className="sr-only">取り込んだ半荘ごとの成績</caption>
        <thead>
          <tr>
            <th scope="col">半荘</th>
            <th scope="col">順位</th>
            <th scope="col">局数</th>
            <th scope="col">和了</th>
            <th scope="col">放銃</th>
            <th scope="col">立直</th>
            <th scope="col">副露</th>
            <th scope="col">平均和了点</th>
            <th scope="col">AI 一致率</th>
            <th scope="col">類似度</th>
            <th scope="col">悪手率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                {row.label}
                {row.room !== null && (
                  <>
                    {' '}
                    <small>{row.room}</small>
                  </>
                )}
              </th>
              <td>{row.stat.rank}位</td>
              <td>{row.stat.kyokuCount}</td>
              <td>{row.stat.winCount}</td>
              <td>{row.stat.dealInCount}</td>
              <td>{row.stat.riichiCount}</td>
              <td>{row.stat.fulouCount}</td>
              <td>{row.averageWinPoints === null ? NONE : groupedNumber(Math.round(row.averageWinPoints))}</td>
              <td>{rateText(row.ai.matchRate)}</td>
              <td>{similarityText(row.ai.similarity)}</td>
              <td>{rateText(row.ai.badMoveRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollWrap>
  );
}

export function ImportedStatsSection({ stats }: { stats: ImportedWeekStats }) {
  const id = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const counted = stats.rows.length;
  return (
    <section className="wk-sec wk-imp" aria-labelledby={id}>
      <div className="sec-head">
        <h2 className="sec-title" id={id}>
          取り込んだ半荘から数えた値（参考）
        </h2>
        <InfoTip label="取り込んだ半荘からの成績の説明">{HINT}</InfoTip>
      </div>
      {stats.imported === 0 ? (
        <p className="wk-empty">この週に取り込んだ半荘はありません。</p>
      ) : counted === 0 ? (
        <p className="wk-empty">{stats.loading > 0 ? '半荘を読み込んでいます。' : 'この週の半荘は、牌譜を読み取れず、数えられませんでした。'}</p>
      ) : (
        <>
          <ScrollWrap caption="取り込んだ半荘から数えた値">
            <table className="wk-imp-tbl">
              <caption className="sr-only">取り込んだ半荘から数えた値（項目ごとの値ともとの数）</caption>
              <thead>
                <tr>
                  <th scope="col">項目</th>
                  <th scope="col" className="num">
                    値
                  </th>
                  <th scope="col">もとの数</th>
                </tr>
              </thead>
              <tbody>
                {itemsOf(stats.totals, stats.ai).map((item) => (
                  <tr key={item.key}>
                    <th scope="row">{item.label}</th>
                    <td className="num">{item.value}</td>
                    <td>
                      <small>{item.base}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollWrap>
          {stats.loading > 0 && <p className="wk-imp-note">読み込み中の半荘が{stats.loading}件あります。読み込めた分だけを数えています。</p>}
          {stats.unreadable > 0 && <p className="wk-imp-note">牌譜を読み取れず、数えなかった半荘が{stats.unreadable}件あります。</p>}
          <div className="wk-games">
            <button type="button" className="wk-games-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
              <Icon name="chevronRight" className="chev" />
              半荘ごとに見る（{counted}半荘）
            </button>
            <div id={listId} hidden={!open}>
              {open && <GameRows rows={stats.rows} />}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
