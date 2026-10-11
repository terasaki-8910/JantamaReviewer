import type { BoardState, RiverTile, Seat, Tile as TileCode, Wind } from '@jantama/engine';
import type { CSSProperties } from 'react';

import { isDoraTile } from './dora';
import { layoutMeld, MELD_NAME } from './meldLayout';
import { BackTile, Tile } from './Tile';
import { tableExtent } from './steps';
import { tileName } from './tiles';

/** 盤面の外側の決まり（巡目を行き来しても変わらないもの）。 */
export interface BoardInfo {
  /** 本人の席（画面の下）。 */
  me: Seat;
  oya: Seat;
  /** 席ごとの自風。 */
  winds: readonly Wind[];
  /** 局の名前。例: 東4局。 */
  round: string;
  honba: number;
  /** 河の段の数（巡目を行き来しても、卓の大きさが変わらないようにそろえる）。 */
  rows: number;
  /** リーチ宣言牌（横向き）の分の余白を取るか。 */
  riichiAny: boolean;
}

const WIND_NAME: Readonly<Record<Wind, string>> = { E: '東', S: '南', W: '西', N: '北' };
const RELATION = { bottom: '自分', right: '下家', top: '対面', left: '上家' } as const;
type Position = keyof typeof RELATION;

/** 盤面の外側の決まりを作る。`steps` は、行き来する盤面すべて（卓の大きさをそろえるため）。 */
export function boardInfoOf(board: BoardState, steps: readonly BoardState[]): BoardInfo {
  const { rows, riichiAny } = tableExtent(steps);
  return {
    me: board.playerId,
    oya: board.oya,
    winds: board.seatWinds,
    round: `${WIND_NAME[board.roundWind]}${board.kyoku}局`,
    honba: board.honba,
    rows,
    riichiAny,
  };
}

function groupedNumber(value: number): string {
  return value.toLocaleString('ja-JP');
}

interface BoardProps {
  info: BoardInfo;
  /** 見せる盤面。 */
  step: BoardState;
  /** ドラ表示牌が指す牌の種類。設定が切のときは null（強調しない）。 */
  dora: ReadonlySet<number> | null;
  /** いま鳴ける牌（他家の打牌）を、その席の河の最後の牌に印する（鳴きの判断）。 */
  target?: Seat | null;
  /** 直前の打牌を、その席の河の最後の牌に印する（半荘を通して見る画面）。 */
  latest?: Seat | null;
}

function riverLabel(position: Position, info: BoardInfo, seat: Seat): string {
  return `${RELATION[position]}（${WIND_NAME[info.winds[seat] as Wind]}家）の河`;
}

function RiverItem({
  tile,
  dora,
  mark,
}: {
  tile: RiverTile;
  dora: ReadonlySet<number> | null;
  mark: 'target' | 'latest' | null;
}) {
  const called = tile.calledBy !== null;
  // 鳴かれて薄くなった牌には、ドラの強調を付けない（鳴いた副露の側が受け持つ）
  const isDora = !called && isDoraTile(tile.tile, dora);
  const classes = [
    tile.tsumogiri ? 'tg' : '',
    called ? 'called' : '',
    mark === 'target' ? 'target' : mark === 'latest' ? 'latest' : '',
  ]
    .filter((c) => c !== '')
    .join(' ');
  const alt =
    tileName(tile.tile) +
    (tile.tsumogiri ? '（ツモ切り）' : '') +
    (called ? '（鳴かれた牌）' : '') +
    (mark === 'target' ? '（鳴ける牌）' : mark === 'latest' ? '（直前の打牌）' : '') +
    (tile.riichi ? '（リーチ宣言牌）' : '');
  return (
    <li className={`rt${tile.riichi ? ' sw' : ''}`}>
      <Tile tile={tile.tile} className={classes} alt={alt} dora={isDora} />
    </li>
  );
}

/**
 * 副露 1 つ（雀魂と同じ並べ方）。盤面では `li`（副露の一覧の項目）、検討ログの行の手牌では、ボタンの中に置くので `span`。
 * 牌の大きさは、`--mw`（幅）と `--mh`（高さ）で決まる。
 */
export function Meld({
  meld,
  seat,
  dora,
  as: Wrapper = 'li',
}: {
  meld: BoardState['melds'][number][number];
  seat: Seat;
  dora: ReadonlySet<number> | null;
  as?: 'li' | 'span';
}) {
  const layout = layoutMeld(meld, seat);
  const face = (tile: TileCode) => <Tile tile={tile} dora={isDoraTile(tile, dora)} />;
  return (
    <Wrapper className="meld" data-kind={MELD_NAME[layout.kind]}>
      {layout.tiles.map((tile, index) => {
        const key = `${index}${tile}`;
        if (layout.kind === 'ankan') {
          const back = index === 0 || index === layout.tiles.length - 1;
          return (
            <span className="mt" key={key}>
              {back ? <BackTile /> : face(tile)}
            </span>
          );
        }
        if (index === layout.side) {
          if (layout.kind === 'kakan' && layout.added !== undefined) {
            return (
              <span className="mt stack" key={key}>
                <span className="sw1">{face(tile)}</span>
                <span className="sw1">{face(layout.added)}</span>
              </span>
            );
          }
          return (
            <span className="mt sw" key={key}>
              {face(tile)}
            </span>
          );
        }
        return (
          <span className="mt" key={key}>
            {face(tile)}
          </span>
        );
      })}
    </Wrapper>
  );
}

/** 卓の配置（雀魂と同じ並び。河を四方に置く。副露は持ち主の右手側の角）。 */
export function Board({ info, step, dora, target = null, latest = null }: BoardProps) {
  const me = info.me;
  const seatAt: Record<Position, Seat> = {
    bottom: me,
    right: ((me + 1) % 4) as Seat,
    top: ((me + 2) % 4) as Seat,
    left: ((me + 3) % 4) as Seat,
  };

  const zone = (position: Position) => {
    const seat = seatAt[position];
    const river = step.rivers[seat] ?? [];
    const last = river.length - 1;
    return (
      <div className={`zone ${position}`}>
        <ol className="river" aria-label={riverLabel(position, info, seat)}>
          {river.map((tile, index) => (
            <RiverItem
              key={`${index}${tile.tile}`}
              tile={tile}
              dora={dora}
              mark={index === last && target === seat ? 'target' : index === last && latest === seat ? 'latest' : null}
            />
          ))}
        </ol>
      </div>
    );
  };

  const corner = (position: Position, name: 'tl' | 'tr' | 'bl' | 'br') => {
    const seat = seatAt[position];
    const melds = step.melds[seat] ?? [];
    if (melds.length === 0) return <div className={`corner ${name}`} />;
    return (
      <div className={`corner ${name}`}>
        <ul className="melds" aria-label={`${RELATION[position]}の副露`}>
          {melds.map((meld, index) => (
            <Meld key={index} meld={meld} seat={seat} dora={dora} />
          ))}
        </ul>
      </div>
    );
  };

  const score = (position: Position) => {
    const seat = seatAt[position];
    const isOya = info.oya === seat;
    const riichi = (step.riichi[seat] ?? 'none') !== 'none';
    return (
      <div className={`score ${position}${position === 'bottom' ? ' me' : ''}`}>
        <span className="who">
          <span className={`wind${isOya ? ' oya' : ''}`}>
            {WIND_NAME[info.winds[seat] as Wind]}
            {isOya && <span className="sr-only">（親）</span>}
          </span>
          <span className="rel">{RELATION[position]}</span>
        </span>
        <span className="pts">{groupedNumber(step.scores[seat] ?? 0)}</span>
        {riichi && <span className="rch">リーチ</span>}
      </div>
    );
  };

  const honba = `${info.honba}本場${step.kyotaku > 0 ? ` · 供託${step.kyotaku}` : ''}`;
  const doraTiles = step.doraMarkers.map((marker, index) => <Tile key={`${index}${marker}`} tile={marker} />);
  const tableStyle = { '--rows': info.rows, '--ri': info.riichiAny ? 1 : 0 } as CSSProperties;

  return (
    <div className="table-wrap">
      {/* 狭いときは、局・本場・残り・ドラ表示牌を、中央の箱の外（卓の上）の 1 行にまとめる */}
      <div className="info-strip">
        <span className="is-round">{info.round}</span>
        <span>{honba}</span>
        <span>
          残り<b>{step.tilesLeft}</b>枚
        </span>
        <span className="is-dora-strip">ドラ表示牌{doraTiles}</span>
      </div>
      <div className="table" role="group" aria-label="卓（4人の河・副露・点数）" style={tableStyle}>
        {corner('top', 'tl')}
        {zone('top')}
        {corner('right', 'tr')}
        {zone('left')}
        <div className="center">
          {score('top')}
          {score('left')}
          <div className="info">
            <span className="round">{info.round}</span>
            <span className="honba">{honba}</span>
            <span className="rest">
              残り<b>{step.tilesLeft}</b>枚
            </span>
            <span className="dora">
              <span className="dora-l">ドラ表示牌</span>
              <span className="dora-t">{doraTiles}</span>
            </span>
          </div>
          <span className="round-s" aria-hidden="true">
            {info.round}
          </span>
          {score('right')}
          {score('bottom')}
        </div>
        {zone('right')}
        {corner('left', 'bl')}
        {zone('bottom')}
        {corner('bottom', 'br')}
      </div>
    </div>
  );
}

/** 凡例（盤面の見方）。 */
export function Legend({
  riichi,
  called,
  call,
  pastView,
  latest = false,
}: {
  riichi: boolean;
  called: boolean;
  /** 鳴ける牌の印を出すか（鳴きの判断）。 */
  call: boolean;
  /** 過去の盤面を見ているか（印を出す）。 */
  pastView: boolean;
  /** 直前の打牌の印を出すか（半荘を通して見る画面）。 */
  latest?: boolean;
}) {
  const face = <img src="/tiles/Chun.svg" alt="" draggable={false} />;
  return (
    <ul className="legend" aria-label="凡例">
      <li>
        <span className="tile tg">{face}</span>ツモ切り
      </li>
      {riichi && (
        <li>
          <span className="sw-demo">
            <span className="tile">{face}</span>
          </span>
          リーチ宣言牌
        </li>
      )}
      {called && (
        <li>
          <span className="tile called">{face}</span>鳴かれた牌
        </li>
      )}
      {latest && (
        <li>
          <span className="tile latest">{face}</span>直前の打牌
        </li>
      )}
      {call && (
        <li>
          <span className="tile target">{face}</span>鳴ける牌
        </li>
      )}
      <li className="lg-dora">
        <span className="tile is-dora">{face}</span>ドラ
      </li>
      {pastView && <li className="past-flag">過去の盤面</li>}
    </ul>
  );
}

/** 河のどこかに、鳴かれた牌があるか（凡例に出す）。 */
export function anyCalled(steps: readonly BoardState[]): boolean {
  return steps.some((step) => step.rivers.some((river) => river.some((tile) => tile.calledBy !== null)));
}
