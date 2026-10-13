/**
 * 他家の手牌（F14、E-40、U-34・U-35。R15-2・R15-5。提案 5）の部品。
 *
 * - `OpenHandRows`: 他家 3 人（下家・対面・上家）の行。席の名前・風・親・リーチの札、手牌（ツモ牌は少し離す）・副露、
 *   聴牌している人の待ち（待ちの形・残り・その人が実際に付けている立直かダマで数えたロンの飜・符・点数。符は乗せる・選ぶと内訳）。
 *   聴牌していない人は「聴牌していません」、切る前（ツモったあと・鳴いたあと）の手は「切る前の手です」。
 *   人ごとの行は 1 つの部品（`OpenHandRow`）で、あとから、聴牌した巡目の印や向聴数の折れ線を差し込める（R15-8 の次の見本で決める）。
 * - `OpenHandsPanel`: 答え合わせのタブ「他家の手牌」の中身。答えたあとにだけ描く（呼ぶ側が決める。U-1・U-35）。
 * - `OpenHandsBlock`: 半荘を通して見る画面の「他家の手牌を開く」で出す欄（答える場面でない手と、答えたあとの場面）。
 * - `HandTiles`: 手牌・ツモ牌（または和了牌）・副露の 1 行。局の結果の手（KyokuResult）も使う。
 *
 * 他家の手牌は、開いたときにだけエンジン（`openHandsAt`）で組み立てる。盤面（BoardState）には入っていない。
 * 見た目は styles/open-hands.css（承認済みの見本の部品。色はトークンだけ）。
 */
import { openHandsAt, type Fuuro, type ImportedGame, type OpenSeat, type OpenWait, type Seat, type Tile as TileCode, type Wind } from '@jantama/engine';
import { useMemo, type ReactNode } from 'react';

import { InfoTip } from '../InfoTip';
import { Meld } from './Board';
import { isDoraTile } from './dora';
import { FuTip, waitContext } from './FuTip';
import { relationName } from './labels';
import { Tile } from './Tile';
import { tileName } from './tiles';
import { hanText, num } from './waitText';

type Dora = ReadonlySet<number> | null;

const WIND_NAME: Readonly<Record<Wind, string>> = { E: '東', S: '南', W: '西', N: '北' };

/** 説明のアイコンの文（タブ「他家の手牌」と、通して見る画面の「他家の手牌を開く」の欄）。 */
export const OPEN_HINT =
  '他家 3 人の閉じた手牌と副露です。待ちの「残り」は、全員の手牌を開いたうえで、場に見えていない枚数です。点数は、その人が実際に付けている立直（宣言済みなら）かダマで数え、裏ドラ・一発・海底などは数えません。符の数にマウスを乗せると、内訳が出ます。';

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
  /** 聴牌の印・向聴数の折れ線など、人ごとの行に差し込むもの（手牌と待ちの間）。 */
  extra?: ReactNode;
}

/** 他家 1 人の行。 */
export function OpenHandRow({ seat, me, dora, values = true, status, extra }: OpenHandRowProps) {
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
      <HandTiles hand={seat.hand} drawn={seat.drawn} melds={seat.melds} seat={seat.seat} dora={dora} label={`${name}の手牌`} />
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
        status === undefined && <p className="oh-no">聴牌していません</p>
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

/** 局 `kyokuPosition` の、牌譜の `eventIndex` の時点の他家の手牌（開いたときにだけ作る）。 */
export function useOpenSeats(game: ImportedGame, kyokuPosition: number, eventIndex: number): OpenSeat[] {
  return useMemo(() => openHandsAt(game, kyokuPosition, eventIndex), [game, kyokuPosition, eventIndex]);
}

interface PanelProps {
  game: ImportedGame;
  kyokuPosition: number;
  eventIndex: number;
  dora: Dora;
}

/** タブ「他家の手牌」の中身。答えたあとにだけ描く。 */
export function OpenHandsPanel({ game, kyokuPosition, eventIndex, dora }: PanelProps) {
  const seats = useOpenSeats(game, kyokuPosition, eventIndex);
  return (
    <div className="oh-panel" data-ai="open-hands">
      <div className="sec-head">
        <h2 className="sec-title">他家の手牌</h2>
        <InfoTip label="他家の手牌の説明" id="oh-hint">
          {OPEN_HINT}
        </InfoTip>
      </div>
      <OpenHandRows seats={seats} me={game.playerId} dora={dora} />
    </div>
  );
}

/** 半荘を通して見る画面で、「他家の手牌を開く」を押したときに出す欄。手を進めると、その手の手牌に替わる。 */
export function OpenHandsBlock({ game, kyokuPosition, eventIndex, dora }: PanelProps) {
  const seats = useOpenSeats(game, kyokuPosition, eventIndex);
  return (
    <section className="q-sec oh-panel" aria-label="他家の手牌" data-open-hands="block">
      <div className="sec-head">
        <h2 className="sec-title">他家の手牌</h2>
        <InfoTip label="他家の手牌の説明" id="oh-block-hint">
          {OPEN_HINT}
        </InfoTip>
      </div>
      <OpenHandRows seats={seats} me={game.playerId} dora={dora} />
    </section>
  );
}
