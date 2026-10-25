/**
 * 自分の向聴数の推移（F14、E-41、U-36。R15-6 の A「表はいまのまま、行を開くと全部」。提案 7）。局の評価の表の行を開いたとき、局の結果の手の下に出す
 * （`HandTable` の `detailBelow`）。
 *
 * 折れ線は、他家の向聴数の推移（盤面の「他家の手牌」の欄）と同じ部品（`ShantenChart`）。横軸は自分の巡目（0 は配牌。記録のまま）、縦軸は場面の向聴数
 * （E-21 と同じ数え方。迷いのカードの「1向聴」と同じ）。迷いは点を囲む輪、悪手は点の右の菱形、聴牌になった打牌は三角。
 * 形だけに頼らないよう、凡例（この局に無い印は「この局は無し」）と、吹き出し・「表で見る」の表に、同じ内容を文字で出す。
 * 図は 1 つの止まり場所（Tab）。矢印キーで点（印のある点を含む）を選ぶと、吹き出しが出る。
 *
 * 結果の牌譜を、開いたときに初めて取り込み直して（半荘ごとに 1 回）、その局を追う。開いていない行は、何も描かない（表の形は変わらない）。
 * 迷い・不一致は、通して見る画面と同じ場面の一覧（`listReplayScenes`）から。AI の候補・確率・順位は出さない（SPEC F3）。
 * 見た目は styles/hanchan.css の `.hx-*`・styles/open-hands.css の `.shchart-*`（承認済みの見本の部品。色はトークンだけ）。
 */
import {
  buildReplayTimeline,
  importParsedReport,
  listReplayScenes,
  myTrackOf,
  type ImportedGame,
  type MortalReport,
  type ReplayTimeline,
} from '@jantama/engine';
import { Fragment, useId, useMemo, useState } from 'react';

import { Icon } from './Icon';
import { InfoTip } from './InfoTip';
import { trackRowsOf, type TrackRow } from './myTrackRows';
import { ShantenChart, type ShantenPoint } from './study/ShantenChart';
import { ChartTipProvider } from './week/ChartTip';

/** 見出しの説明のアイコンの文。 */
export const MY_TRACK_HINT =
  '自分が切るたびの、場面の向聴数です（迷いのカードの「1向聴」と同じ数え方。ツモったあとの手から、いちばん進む打牌のあとの数）。線が上がるほど、聴牌に近づいています。丸は迷い、菱形は悪手、三角は聴牌になった打牌です。矢印キーで点を選ぶ（マウスを乗せる）と、内容が出ます。';

/** 取り込んだ結果の牌譜を再生して作る、半荘ごとのもの（開いたときに 1 回だけ作る）。 */
interface GameModel {
  game: ImportedGame;
  timeline: ReplayTimeline;
}

const MODEL_CACHE = new WeakMap<MortalReport, GameModel | null>();

function modelOf(report: MortalReport): GameModel | null {
  if (MODEL_CACHE.has(report)) return MODEL_CACHE.get(report) ?? null;
  let model: GameModel | null = null;
  try {
    const imported = importParsedReport(report);
    if (imported.ok) model = { game: imported.value, timeline: buildReplayTimeline(imported.value) };
  } catch {
    // 牌譜を再生できない半荘は、折れ線を出さない（局の結果の手は、別の部品がそのまま出す）
  }
  MODEL_CACHE.set(report, model);
  return model;
}

interface MyShantenTrackProps {
  report: MortalReport;
  /** 何番目の局か（0 から）。 */
  position: number;
  /** 局の名前（図の名前）。例: 東3局。 */
  label: string;
  /** 迷いマークごとに、結びつけた判断の鍵（結びつけが決まっていないものは null。迷いの番号は、並びの位置 + 1）。 */
  markKeys: ReadonlyArray<string | null>;
}

export function MyShantenTrack({ report, position, label, markKeys }: MyShantenTrackProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const rows = useMemo<TrackRow[] | null>(() => {
    const model = modelOf(report);
    if (model === null) return null;
    try {
      const scenes = listReplayScenes(model.timeline, model.game.decisions, { markKeys });
      return trackRowsOf(myTrackOf(model.game, position, scenes));
    } catch {
      return null;
    }
  }, [report, position, markKeys]);
  const points = useMemo<ShantenPoint[]>(
    () =>
      (rows ?? []).map((row) => ({
        n: row.n,
        shanten: row.shanten,
        value: row.tip,
        name: row.name,
        mark: row.tenpai,
        doubt: row.doubt,
        big: row.big,
      })),
    [rows],
  );
  // 1 枚も切らずに終わった局は、配牌の点だけ（折れ線にならない）ので、何も出さない
  if (rows === null || rows.length < 2) return null;
  const tableId = `${id}-table`;
  const has = {
    doubt: rows.some((row) => row.doubt),
    big: rows.some((row) => row.big),
    tenpai: rows.some((row) => row.tenpai),
  };
  const none = '（この局は無し）';
  return (
    <div className="hx-blk hx-trk" data-my-track={position}>
      <div className="sec-head">
        <h4>向聴数の推移</h4>
        <InfoTip label="向聴数の推移の説明" id={`${id}-hint`}>
          {MY_TRACK_HINT}
        </InfoTip>
      </div>
      <ChartTipProvider>
        <ShantenChart label={`${label}の向聴数の推移`} points={points} xTitle="横軸: 巡目" />
      </ChartTipProvider>
      <ul className="hx-leg" aria-label="図の印">
        <li data-kind="doubt" data-none={has.doubt ? undefined : '1'}>
          <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <circle className="dbt" cx="7" cy="7" r="5" />
          </svg>
          迷い{has.doubt ? '' : none}
        </li>
        <li data-kind="big" data-none={has.big ? undefined : '1'}>
          <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <path className="bgm" d="M7 1 13 7 7 13 1 7Z" />
          </svg>
          悪手{has.big ? '' : none}
        </li>
        <li data-kind="tenpai" data-none={has.tenpai ? undefined : '1'}>
          <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <path className="tpm" d="M7 1.5 13 12H1Z" />
          </svg>
          聴牌になった打牌{has.tenpai ? '' : none}
        </li>
      </ul>
      <button type="button" className="hx-tgl" aria-expanded={shown} aria-controls={shown ? tableId : undefined} onClick={() => setShown((value) => !value)}>
        <Icon name="chevronRight" className="hx-chev" />
        表で見る
      </button>
      {shown && <TrackTable id={tableId} label={label} rows={rows} />}
    </div>
  );
}

/**
 * 「表で見る」の表: 図と同じ点を、巡目・打牌・向聴数・印で並べる。
 * 局の評価の表（`.tbl`）の中に入る表なので、`<table>` ではなく、表の役割（role）を付けた箱で作る（`.tbl` の th・td の規則が、中の表に及ばないように）。
 */
function TrackTable({ id, label, rows }: { id: string; label: string; rows: readonly TrackRow[] }) {
  return (
    <div className="hx-sptbl" id={id} role="table" aria-label={`${label}の向聴数の推移（表）`}>
      <div role="row">
        <span role="columnheader">巡目</span>
        <span role="columnheader">打牌</span>
        <span role="columnheader">向聴数</span>
        <span role="columnheader">印</span>
      </div>
      {rows.map((row) => (
        <div role="row" key={row.n}>
          <span role="rowheader">{row.turn}</span>
          <span role="cell">{row.discard ?? '—'}</span>
          <span role="cell">{row.shantenText}</span>
          <span role="cell">
            {row.marks.length === 0
              ? '—'
              : row.marks.map((mark, index) => (
                  <Fragment key={index}>
                    {index > 0 && '・'}
                    <span className="hx-mk">{mark}</span>
                  </Fragment>
                ))}
          </span>
        </div>
      ))}
    </div>
  );
}


