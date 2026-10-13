/**
 * 局の結果の手（F14、E-40、U-36 の局の結果の手の部分。R15-6 の A「表はいまのまま、行を開くと全部」。提案 4）。
 * 局の評価の表の行を開いたときに出す。和了の局は、和了者・ツモ／ロン（だれから）・手牌（副露・和了牌つき）・役・飜・符（乗せる・選ぶと内訳）・点数・
 * 点の増減。他家のツモ・ロンの局も同じ（ダブロンは和了ごとに）。放銃した局は、相手の手牌と待ち（和了牌を除いた手の待ち）。
 * 流局は、「流局」と、荒牌平局なら 4 人の手牌と聴牌・ノーテン。
 * 役・符・点数は、Mortal の結果には入っていないので、牌譜から手を組み立てて計算し直したもの（エンジンの `kyokuResultOf`）。
 * 見た目は styles/hanchan.css の `.hx-*`（承認済みの見本の部品。色はトークンだけ）。
 */
import { kyokuResultOf, type KyokuWinView, type MortalReport, type Seat, type Wind } from '@jantama/engine';
import { useMemo } from 'react';

import { FuTip } from './study/FuTip';
import { relationName } from './study/labels';
import { HandTiles, OpenHandRows } from './study/OpenHands';
import { Tile } from './study/Tile';
import { hanText, num, tsumoText } from './study/waitText';
import { pointText } from './handRows';

const WIND_NAME: Readonly<Record<Wind, string>> = { E: '東', S: '南', W: '西', N: '北' };

/** 点の増減（本人から、自分・下家・対面・上家の順）。例: 自分 −12,000・下家 0・対面 +12,000・上家 0。 */
export function deltasText(deltas: readonly number[], me: Seat): string {
  return [0, 1, 2, 3].map((offset) => `${relationName(me, ((me + offset) % 4) as Seat)} ${pointText(deltas[(me + offset) % 4] ?? 0)}`).join('・');
}

/** 本場・供託の言い方。例: 1本場（+300）・供託 2本（+2,000）。無ければ空。 */
function bonusText(win: KyokuWinView): string {
  const parts: string[] = [];
  if (win.honba > 0) parts.push(`${win.honba}本場（+${num(win.honba * 300)}）`);
  if (win.kyotaku > 0) parts.push(`供託 ${win.kyotaku}本（+${num(win.kyotaku * 1000)}）`);
  return parts.join('・');
}

function WinBlock({ win, me }: { win: KyokuWinView; me: Seat }) {
  const who = `${relationName(me, win.winner)}${win.dealer ? '（親）' : ''}`;
  const how = win.tsumo ? 'ツモ' : `${relationName(me, win.target)}から ロン`;
  const { line } = win;
  const points = win.tsumo && line.tsumoPay !== null ? tsumoText(line, win.dealer) : num(line.base);
  const bonus = bonusText(win);
  const context = `${relationName(me, win.winner)} ${win.tsumo ? 'ツモ' : 'ロン'}`;
  return (
    <div className="hx-win" data-winner={win.winner}>
      <p className="hx-who">
        <b>{who}</b>{' '}
        <span>
          {WIND_NAME[win.wind]}家が {how}
        </span>
      </p>
      <HandTiles hand={win.closed} win={win.winTile} melds={win.melds} seat={win.winner} dora={null} label={`${relationName(me, win.winner)}の和了の手牌`} />
      <p className="hx-yk">
        {win.yaku.map((y) => (
          <span className="q-tag sure" key={y.name}>
            {y.han === 0 ? y.name : `${y.name} ${y.han}飜`}
          </span>
        ))}
        {win.dora.dora > 0 && <span className="q-tag">ドラ {win.dora.dora}</span>}
        {win.dora.aka > 0 && <span className="q-tag">赤ドラ {win.dora.aka}</span>}
        {win.dora.ura > 0 && <span className="q-tag">裏ドラ {win.dora.ura}</span>}
      </p>
      <p className="hx-pts">
        <span className="n">{points}</span>{' '}
        <span>
          {line.limit !== null && line.yakuman === 0 && <b>{line.limit} </b>}
          {hanText(line)} <FuTip line={line} context={context} />
        </span>
      </p>
      <p className="hx-bonus">
        {bonus !== '' && `${bonus}。 `}点の増減: {deltasText(win.deltas, me)}
      </p>
      {!win.tsumo && win.target === me && win.waits.length > 0 && (
        <p className="oh-w hx-waits">
          <span>待ち</span>
          {win.waits.map((wait) => (
            <span className="it" key={wait.kind}>
              <Tile tile={wait.tile} />
              <small>
                {wait.shapes.join('／')}・残り{wait.remaining}
              </small>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

interface KyokuResultProps {
  report: MortalReport;
  /** 何番目の局か（0 から）。 */
  position: number;
}

/** 局の結果の手（行を開いたときだけ描く。牌譜を再生して組み立てるので、開いたときに初めて計算する）。 */
export function KyokuResult({ report, position }: KyokuResultProps) {
  const result = useMemo(() => kyokuResultOf(report, position), [report, position]);
  const me = report.player_id;
  return (
    <div className="hx-blk" data-kyoku-result={result?.kind ?? 'none'}>
      <h4>局の結果の手</h4>
      {result === null && <p className="hx-none">この局の結果の手を、牌譜から作れませんでした。</p>}
      {result?.kind === 'win' && result.wins.map((win) => <WinBlock win={win} me={me} key={`${win.winner}-${win.target}`} />)}
      {result?.kind === 'draw' && (
        <>
          <p className="hx-none">{result.exhaustive ? '流局です（牌山を取り切りました）。' : '途中で流局しました。'}</p>
          <OpenHandRows
            seats={result.seats}
            me={me}
            dora={null}
            values={false}
            label="4 人の手牌"
            status={result.exhaustive ? (seat) => (seat.waits.length > 0 ? '聴牌' : 'ノーテン') : undefined}
          />
          {result.deltas.some((delta) => delta !== 0) && <p className="hx-bonus">点の増減: {deltasText(result.deltas, me)}</p>}
        </>
      )}
    </div>
  );
}
