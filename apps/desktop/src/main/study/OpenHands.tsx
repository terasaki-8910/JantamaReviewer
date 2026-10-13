/**
 * 他家の手牌（F14、E-40・E-43、U-34・U-35・U-38。R15-2・R15-5・R16-7）の部品。
 *
 * 手牌の牌は、盤面（Board.tsx の `OpponentHand`）に置く。他家のどれか 1 人の手牌を押すと 3 人分が開き、もう一度押すと閉じる。
 * ここは、開いているときに出す「他家の手牌」の欄（通して見る画面は右の欄の上、答えたあとの場面は答えの欄の上）と、局の結果の手（KyokuResult）の部品:
 * - `OpenHandsBlock`: 他家 3 人（下家・対面・上家）の行。席・風・親・リーチの札、聴牌になった巡目の 1 行と向聴数の折れ線（R16-7 の A）、
 *   聴牌している人の待ち（待ちの形・残り・その人が実際に付けている立直かダマで数えたロンの飜・符・点数。符は乗せる・選ぶと内訳）。
 *   牌の並びは出さない（盤面に出ている）。聴牌していない人は「聴牌していません」、切る前（ツモったあと・鳴いたあと）の手は「切る前の手です」。
 * - `OpenHandRow`・`OpenHandRows`: 人ごとの行。局の結果の手は、牌の並びつきで使う（`tiles`）
 * - `HandTiles`: 手牌・ツモ牌（または和了牌）・副露の 1 行。局の結果の手（KyokuResult）が使う
 * - `useKyokuTracks`・`useGameTracks`: 他家の手の進み（エンジンの `opponentTracksOf`。局ごとに 1 回だけ作る）。開いたときにだけ作る
 *
 * 他家の手牌は、開いたときにだけエンジン（`openHandsAt`）で組み立てる。盤面（BoardState）には入っていない。
 * 見た目は styles/open-hands.css（承認済みの見本の部品。色はトークンだけ）。
 */
import {
  opponentTracksOf,
  openHandsAt,
  type Fuuro,
  type ImportedGame,
  type KyokuTracks,
  type OpenSeat,
  type OpenWait,
  type Seat,
  type SeatTrack,
  type Tile as TileCode,
  type Wind,
} from '@jantama/engine';
import { useMemo, type ReactNode } from 'react';

import { InfoTip } from '../InfoTip';
import { ChartTipProvider } from '../week/ChartTip';
import { Meld, type BoardHands } from './Board';
import { isDoraTile } from './dora';
import { FuTip, waitContext } from './FuTip';
import { relationName } from './labels';
import { ShantenChart, type ShantenPoint } from './ShantenChart';
import { pointNameText, shantenValueText, tenpaiRiverMarks, trackLineText, trackNow } from './tenpaiText';
import { Tile } from './Tile';
import { tileName } from './tiles';
import { hanText, num } from './waitText';

type Dora = ReadonlySet<number> | null;

const WIND_NAME: Readonly<Record<Wind, string>> = { E: '東', S: '南', W: '西', N: '北' };

/** 「他家の手牌」の欄の、説明のアイコンの文（R16-7）。 */
export const OPEN_HINT =
  '手牌の牌は、盤面の、他家の河の外側に出ています（どれか 1 人の手牌を押すと、3 人とも閉じます）。待ちの「残り」は、全員の手牌を開いたうえで、場に見えていない枚数です。点数は、その人が実際に付けている立直（宣言済みなら）かダマで数え、裏ドラ・一発・海底などは数えません。符の数にマウスを乗せると、内訳が出ます。聴牌になった打牌は、河の枠（右上の三角つき）と、この欄の 1 行で示します。「N巡目」は、その人が何枚目の牌を切ったとき（河の左から数えた枚数）かです。折れ線は、その人が切るたびの向聴数で、▲ が聴牌になった打牌です。';

interface HandTilesProps {
  /** 閉じた手牌（並べ替え済み）。 */
  hand: readonly TileCode[];
  /** ツモってまだ切っていない牌（手牌から少し離す）。 */
  drawn?: TileCode | null;
  /** 和了牌（手牌から少し離し、accent の輪を付ける）。 */
  win?: TileCode | null;
  melds: readonly Fuuro[];
  /** 副露の向きを決める、持ち主の席。 */
  seat: Seat;
  dora: Dora;
  /** 読み上げ用の名前（例: 下家の手牌）。 */
  label: string;
}

/** 手牌・ツモ牌（または和了牌）・副露の 1 行。副露は盤面と同じ並べ方（Meld）。 */
export function HandTiles({ hand, drawn = null, win = null, melds, seat, dora, label }: HandTilesProps) {
  return (
    <div className="oh-hand" role="group" aria-label={label}>
      <span className="oh-tiles">
        {hand.map((tile, index) => (
          <Tile key={`${index}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
        ))}
      </span>
      {drawn !== null && (
        <span className="oh-tiles gap">
          <Tile tile={drawn} alt={`${tileName(drawn)}（ツモ牌）`} dora={isDoraTile(drawn, dora)} />
        </span>
      )}
      {win !== null && (
        <span className="oh-tiles gap">
          <Tile tile={win} className="win" alt={`${tileName(win)}（和了牌）`} dora={isDoraTile(win, dora)} />
        </span>
      )}
      {melds.length > 0 && (
        <span className="oh-melds">
          {melds.map((meld, index) => (
            <Meld key={index} as="span" meld={meld} seat={seat} dora={dora} />
          ))}
        </span>
      )}
    </div>
  );
}

/** 待ち 1 種類の 1 つ（牌と、形・残り・点）。`values` が false なら、点を出さない（局の結果の手では、和了の点を別に出す）。 */
function WaitItem({ wait, name, dora, values }: { wait: OpenWait; name: string; dora: Dora; values: boolean }) {
  const { ron } = wait;
  return (
    <span className="it">
      <Tile tile={wait.tile} dora={isDoraTile(wait.tile, dora)} />
      <small>
        {wait.shapes.join('／')}・残り{wait.remaining}
        {values && (
          <>
            ・
            {ron.none ? (
              '役なし'
            ) : (
              <>
                {hanText(ron)} <FuTip line={ron} context={waitContext(wait.tile, `${name} ${wait.stand === 'riichi' ? 'リーチ' : 'ダマ'} ロン`)} /> {num(ron.base)}
              </>
            )}
            {wait.furiten && '（フリテン）'}
          </>
        )}
      </small>
    </span>
  );
}

interface OpenHandRowProps {
  seat: OpenSeat;
  /** 本人の席（呼び名の基準）。 */
  me: Seat;
  dora: Dora;
  values?: boolean;
  /** 見出しに足す札（流局の「聴牌」「ノーテン」）。渡すと、聴牌していないときの「聴牌していません」の行は出さない（札が言っている）。 */
  status?: string;
  /** 聴牌になった巡目の 1 行・向聴数の折れ線など、人ごとの行に差し込むもの（手牌と待ちの間）。渡すと、「聴牌していません」の行は出さない（1 行が言っている）。 */
  extra?: ReactNode;
  /** 手牌の牌の並びを出すか（既定は出す。盤面に牌がある「他家の手牌」の欄は、出さない）。 */
  tiles?: boolean;
}

/** 他家 1 人の行。 */
export function OpenHandRow({ seat, me, dora, values = true, status, extra, tiles = true }: OpenHandRowProps) {
  const name = relationName(me, seat.seat);
  return (
    <li className="oh-row" data-seat={seat.seat}>
      <div className="oh-hd">
        <b>{name}</b>
        <span className="q-tag">{WIND_NAME[seat.wind]}家</span>
        {seat.dealer && <span className="q-tag">親</span>}
        {seat.riichi !== 'none' && <span className="q-tag riichi">リーチ</span>}
        {status !== undefined && <span className="q-tag">{status}</span>}
      </div>
      {tiles && <HandTiles hand={seat.hand} drawn={seat.drawn} melds={seat.melds} seat={seat.seat} dora={dora} label={`${name}の手牌`} />}
      {extra}
      {seat.pending ? (
        <p className="oh-no">切る前の手です</p>
      ) : seat.waits.length > 0 ? (
        <p className="oh-w">
          <span>待ち</span>
          {seat.waits.map((wait) => (
            <WaitItem key={wait.kind} wait={wait} name={name} dora={dora} values={values} />
          ))}
        </p>
      ) : (
        status === undefined && extra === undefined && <p className="oh-no">聴牌していません</p>
      )}
    </li>
  );
}

/** 他家 3 人の行（下家・対面・上家の順）。 */
export function OpenHandRows({
  seats,
  me,
  dora,
  values = true,
  label = '他家の手牌と待ち',
  status,
}: {
  seats: readonly OpenSeat[];
  me: Seat;
  dora: Dora;
  values?: boolean;
  /** 一覧の名前（読み上げ用）。 */
  label?: string;
  /** 席ごとの見出しの札（流局の「聴牌」「ノーテン」）。 */
  status?: (seat: OpenSeat) => string | undefined;
}) {
  return (
    <ul className="oh-list" aria-label={label}>
      {seats.map((seat) => (
        <OpenHandRow key={seat.seat} seat={seat} me={me} dora={dora} values={values} status={status?.(seat)} />
      ))}
    </ul>
  );
}

// ---- 他家の手の進み（聴牌になった巡目。R16-7 の A） ----

/** 半荘ごとの、局ごとの手の進み（局ごとに 1 回だけ作る。半荘が替われば捨てる）。 */
const TRACK_CACHE = new WeakMap<ImportedGame, Map<number, KyokuTracks>>();

function tracksOf(game: ImportedGame, kyokuPosition: number): KyokuTracks {
  let byKyoku = TRACK_CACHE.get(game);
  if (byKyoku === undefined) {
    byKyoku = new Map();
    TRACK_CACHE.set(game, byKyoku);
  }
  let found = byKyoku.get(kyokuPosition);
  if (found === undefined) {
    found = opponentTracksOf(game, kyokuPosition);
    byKyoku.set(kyokuPosition, found);
  }
  return found;
}

/** 局 `kyokuPosition` の、他家の手の進み。`enabled`（他家の手牌を開いているとき）でなければ作らない（null）。 */
export function useKyokuTracks(game: ImportedGame, kyokuPosition: number, enabled: boolean): KyokuTracks | null {
  return useMemo(() => (enabled ? tracksOf(game, kyokuPosition) : null), [game, kyokuPosition, enabled]);
}

/** 半荘の全部の局の、他家の手の進み（位置の帯の目盛りに使う）。`enabled` でなければ作らない（null）。 */
export function useGameTracks(game: ImportedGame, enabled: boolean): readonly KyokuTracks[] | null {
  return useMemo(() => (enabled ? game.kyokus.map((kyoku) => tracksOf(game, kyoku.position)) : null), [game, enabled]);
}

/** 1 人の、聴牌になった巡目の 1 行と、向聴数の折れ線（いまの手まで）。 */
function OpponentTrack({ track, name, eventIndex }: { track: SeatTrack; name: string; eventIndex: number }) {
  const now = useMemo(() => trackNow(track, eventIndex), [track, eventIndex]);
  const points = useMemo<ShantenPoint[]>(() => {
    const marked = new Set(now.marks.map((mark) => mark.n));
    return now.points.map((point) => ({
      n: point.n,
      shanten: point.shanten,
      value: shantenValueText(point.shanten),
      name: pointNameText(point),
      mark: marked.has(point.n),
    }));
  }, [now]);
  const tenpai = now.shanten === 0;
  return (
    <>
      <p className={`tp-line${tenpai ? '' : ' none'}`} data-tenpai={tenpai ? '1' : '0'}>
        {tenpai && <span className="tp-key" aria-hidden="true" />}
        <span>{trackLineText(now)}</span>
      </p>
      <ShantenChart label={`${name}の向聴数の推移`} points={points} />
    </>
  );
}

/** 他家の手牌の開け閉めの、画面の側の状態（呼ぶ側が持つ。画面を離れると閉じに戻る）。 */
export interface OpenHandsControl {
  open: boolean;
  onToggle: () => void;
}

/** 盤面と欄に渡すもの。 */
export interface OpenHandsView {
  /** 盤面の手牌（Board の `hands`）。 */
  hands: BoardHands;
  /** 聴牌になった打牌の枠（開いていて押せるときだけ）。 */
  tenpai: ReadonlyMap<number, ReadonlySet<number>> | undefined;
  /** 他家の手牌を、いま開いて見せているか（開いていて、押せるとき）。 */
  showing: boolean;
  /** 開いているときの、他家の手牌と、この局の手の進み。 */
  seats: readonly OpenSeat[] | null;
  tracks: KyokuTracks | null;
}

/**
 * 他家の手牌の開け閉めの状態から、盤面と欄に渡すものを作る。開いていて押せるときだけ、エンジンで他家の手牌と手の進みを組み立てる
 * （答える場面の答える前・出題の答える前は、`available` が false なので、作らない。U-1・U-35）。
 * `eventIndex` は、見せている盤面の、牌譜の位置（通して見る画面は `TimelineStep.eventIndex`、判断は `Decision.eventIndex`）。
 */
export function useOpenHandsView(
  game: ImportedGame,
  kyokuPosition: number,
  eventIndex: number,
  control: OpenHandsControl,
  available: boolean,
): OpenHandsView {
  const showing = control.open && available;
  const seats = useMemo(() => (showing ? openHandsAt(game, kyokuPosition, eventIndex) : null), [showing, game, kyokuPosition, eventIndex]);
  const tracks = useKyokuTracks(game, kyokuPosition, showing);
  const tenpai = useMemo(() => (tracks === null ? undefined : tenpaiRiverMarks(tracks, eventIndex)), [tracks, eventIndex]);
  return { hands: { open: control.open, available, seats, onToggle: control.onToggle }, tenpai, showing, seats, tracks };
}

interface BlockProps {
  /** 本人の席（呼び名の基準）。 */
  me: Seat;
  /** 他家 3 人の手牌（下家・対面・上家）。 */
  seats: readonly OpenSeat[];
  /** 牌譜の、いまの手の位置（折れ線・1 行を、いまの手までに絞る）。 */
  eventIndex: number;
  dora: Dora;
  /** この局の、他家の手の進み（無ければ、聴牌の 1 行と折れ線を出さない）。 */
  tracks: KyokuTracks | null;
}

/**
 * 他家の手牌を開いているときに出す「他家の手牌」の欄（R16-7）。通して見る画面は右の欄の上、答えたあとの場面は答えの欄の上。
 * 手を進めると、その手の他家に替わる。牌の並びは、盤面に出ているので、出さない。閉じているときは、描かない（呼ぶ側が決める）。
 */
export function OpenHandsBlock({ me, seats, eventIndex, dora, tracks }: BlockProps) {
  return (
    <section className="q-sec oh-panel" aria-label="他家の手牌" data-open-hands="block">
      <div className="sec-head">
        <h2 className="sec-title">他家の手牌</h2>
        <InfoTip label="他家の手牌の説明" id="oh-block-hint">
          {OPEN_HINT}
        </InfoTip>
      </div>
      <ChartTipProvider>
        <ul className="oh-list" aria-label="他家の聴牌と待ち">
          {seats.map((seat) => {
            const name = relationName(me, seat.seat);
            const track = tracks?.seats.find((candidate) => candidate.seat === seat.seat);
            return (
              <OpenHandRow
                key={seat.seat}
                seat={seat}
                me={me}
                dora={dora}
                tiles={false}
                extra={track === undefined ? undefined : <OpponentTrack track={track} name={name} eventIndex={eventIndex} />}
              />
            );
          })}
        </ul>
      </ChartTipProvider>
    </section>
  );
}
