/**
 * 答え合わせのタブ「待ちと打点」の中身（F14、E-36・E-37、U-34。R15-2・R15-3）。
 *
 * 聴牌になる行動（打牌・スルー・チー・ポン→打牌。リーチの判断は、聴牌になる切り方すべて）ごとに 1 つの表。待ち牌ごとの行に
 *   待ち（牌・残り枚数）・形（両面・嵌張・辺張・双碰・単騎）・どちらでも付く役・ダマとリーチ（門前だけ）のロンとツモの点数。
 * 手全体の形は見出しの札に 1 語（3 種類以上の待ちは「多面張」）。符は「40符」のように数だけ出し、乗せる・選ぶと内訳が重なって出る（FuTip）。
 * 説明の文は、見出しのそばの説明のアイコン（InfoTip。R11-1）に置く。見た目は styles/waits.css（承認済みの見本の部品。色はトークンだけ）。
 * AI の行動を含むので、答え合わせのあとにだけ描く（U-1。呼ぶ側が決める）。
 */
import { sortTiles, type AnswerOption, type WaitBox, type WaitLine, type WaitRow, type WaitSide, type WaitTable } from '@jantama/engine';

import { Fragment } from 'react';

import { InfoTip } from '../InfoTip';
import { isDoraTile } from './dora';
import { FuTip, waitContext } from './FuTip';
import { Tile } from './Tile';

type Dora = ReadonlySet<number> | null;

/** 説明のアイコンの文（承認された見本のとおり）。 */
export const WAIT_HINT =
  '裏ドラ・一発・海底などは数えていません（リーチの点は、立直の 1 飜と、ツモの門前清自摸和の 1 飜が付くだけ）。和了牌が赤のときの赤ドラも数えません。雀魂の規則（切り上げ満貫なし・喰いタンあり・赤ドラ各 1 枚）で計算しています。符の数にマウスを乗せると、内訳が出ます。';

const num = (n: number): string => Math.round(n).toLocaleString('en-US');
const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${num(Math.abs(n))}`;

function hanText(line: WaitLine): string {
  if (line.yakuman > 0) return line.yakuman >= 2 ? `${line.yakuman}倍役満` : '役満';
  return `${line.han}飜`;
}

/** ツモの言い方: 子のツモは「子・親」、親のツモは「オール」。 */
function tsumoText(line: WaitLine, dealer: boolean): string {
  if (line.tsumoPay === null) return '';
  return dealer ? `${num(line.tsumoPay.child)}オール` : `${num(line.tsumoPay.child)}・${num(line.tsumoPay.dealer)}`;
}

function RonLine({ line, furiten, context }: { line: WaitLine; furiten: boolean; context: string }) {
  if (line.none) {
    return (
      <p className="wt-p">
        <span className="wt-k">ロン</span> <span className="wt-none">役なし</span> <span className="wt-hf">（ロンできない）</span>
      </p>
    );
  }
  return (
    <p className="wt-p">
      <span className="wt-k">ロン</span> <b className="wt-n">{num(line.base)}</b>{' '}
      <span className="wt-hf">
        {hanText(line)} <FuTip line={line} context={`${context} ロン`} />
      </span>
      {line.limit !== null && <> <span className="wt-lim">{line.limit}</span></>}
      {furiten && <> <span className="wt-hf">（フリテン）</span></>}
    </p>
  );
}

function TsumoLine({ line, dealer, context }: { line: WaitLine; dealer: boolean; context: string }) {
  if (line.none) {
    return (
      <p className="wt-p">
        <span className="wt-k">ツモ</span> <span className="wt-none">役なし</span> <span className="wt-hf">（ツモできない）</span>
      </p>
    );
  }
  return (
    <p className="wt-p">
      <span className="wt-k">ツモ</span> <b className="wt-n">{tsumoText(line, dealer)}</b>{' '}
      <span className="wt-hf">
        {hanText(line)} <FuTip line={line} context={`${context} ツモ`} />
      </span>
      {line.limit !== null && <> <span className="wt-lim">{line.limit}</span></>}
    </p>
  );
}

function Side({ side, furiten, dealer, context, diffFrom }: { side: WaitSide; furiten: boolean; dealer: boolean; context: string; diffFrom?: WaitSide }) {
  let diff: string | null = null;
  if (diffFrom !== undefined) {
    const ron = diffFrom.ron.none ? 'ダマはロンできない' : `ロン ${signed(side.ron.base - diffFrom.ron.base)}`;
    diff = `ダマとの差: ${ron}・ツモ ${signed(side.tsumo.base - diffFrom.tsumo.base)}`;
  }
  return (
    <div className="wt-ev">
      <RonLine line={side.ron} furiten={furiten} context={context} />
      <TsumoLine line={side.tsumo} dealer={dealer} context={context} />
      {diff !== null && <p className="wt-diff">{diff}</p>}
    </div>
  );
}

/** 待ちの行の、どちらでも付く役の札。 */
function CommonYaku({ row }: { row: WaitRow }) {
  return (
    <p className="wt-y">
      {row.yaku.length === 0 && <span className="q-tag none">役なし</span>}
      {row.yaku.map((y) => (
        <Fragment key={y.name}>
          {' '}
          <span className="q-tag sure">{y.han === 0 ? y.name : `${y.name} ${y.han}飜`}</span>
        </Fragment>
      ))}
      {row.dora > 0 && <> <span className="q-tag">ドラ {row.dora}</span></>}
      {row.aka > 0 && <> <span className="q-tag">赤ドラ {row.aka}</span></>}
    </p>
  );
}

function Row({ row, table, dealer }: { row: WaitRow; table: WaitTable; dealer: boolean }) {
  return (
    <tr>
      <th scope="row">
        <span className="wt-wait">
          <Tile tile={row.tile} />
          <small>残り{row.remaining}枚</small>
        </span>
      </th>
      <td className="shape">
        <span className="wt-shape">{row.shapes.join('／')}</span>
      </td>
      <td className="yaku">
        <CommonYaku row={row} />
      </td>
      <td className="dama" data-label="ダマ">
        <Side side={row.dama} furiten={row.furiten} dealer={dealer} context={waitContext(row.tile, 'ダマ')} />
      </td>
      <td className="riichi" data-label="リーチ">
        {table.closed && row.riichi !== null ? (
          <Side side={row.riichi} furiten={row.furiten} dealer={dealer} context={waitContext(row.tile, 'リーチ')} diffFrom={row.dama} />
        ) : (
          <p className="wt-note">副露しているので、リーチはできません</p>
        )}
      </td>
    </tr>
  );
}

const kindOf = (tags: readonly string[]): string => (tags.includes('自分') ? 'you' : tags.includes('AI') ? 'top' : tags.includes('実戦') ? 'act' : 'other');

/**
 * 表の見出し（行動）: 打牌は「打」と牌、スルーはボタンの名前、チー・ポンはボタンの名前と鳴く牌に続けて「打」と牌。
 * 待ちも点も同じ打牌をまとめた表は、打牌を「・」で並べ、「（待ちも点も同じ）」と添える（承認された見本のとおり）。
 */
function Heading({ table, dora }: { table: WaitTable; dora: Dora }) {
  const option: AnswerOption | null = table.option;
  const meld = option !== null && (option.kind === 'chi' || option.kind === 'pon') ? sortTiles(option.called === null ? option.use : [...option.use, option.called]) : [];
  const merged = table.same.length > 0;
  const discards = table.discard === null ? [] : [{ discard: table.discard, tags: table.tags }, ...table.same];
  return (
    <div className="wt-h">
      {option !== null && (
        <span className="wt-disc">
          <b>{option.label}</b>{' '}
          {meld.map((tile, index) => (
            <Tile key={`${index}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
          ))}
          {table.discard !== null && <> <span className="wt-then">→</span> </>}
        </span>
      )}
      {discards.map(({ discard, tags }, index) => (
        <Fragment key={discard}>
          {index > 0 && <> <span className="wt-cnt">・</span> </>}
          <span className="wt-disc">
            打<Tile tile={discard} dora={isDoraTile(discard, dora)} />
          </span>{' '}
          {(!merged || tags.length > 0) && <span className={`wt-tags ${kindOf(tags)}`}>{tags.length > 0 ? tags.join('・') : '候補'}</span>}
        </Fragment>
      ))}
      {option !== null && table.discard === null && <span className={`wt-tags ${kindOf(table.tags)}`}>{table.tags.length > 0 ? table.tags.join('・') : '候補'}</span>}
      {merged && <> <span className="wt-cnt">（待ちも点も同じ）</span></>}{' '}
      <span className={`wt-shape${table.wide ? ' wide' : ''}`}>{table.shape}</span>{' '}
      <span className="wt-cnt">
        待ち{table.waits.length}種・残り{table.remaining}枚
      </span>
    </div>
  );
}

function captionOf(table: WaitTable): string {
  const discards = table.discard === null ? null : [table.discard, ...table.same.map((s) => s.discard)].map((d) => `打${d}`).join('・');
  const what = [table.option?.text ?? null, discards].filter((x) => x !== null).join(' → ');
  return `${what} の待ちごとの役と点数`;
}

function Table({ table, dealer, dora }: { table: WaitTable; dealer: boolean; dora: Dora }) {
  return (
    <div className="wt" data-ai="waits">
      <Heading table={table} dora={dora} />
      <table className="wt-tbl">
        <caption className="sr-only">{captionOf(table)}</caption>
        <colgroup>
          <col className="c-wait" />
          <col className="c-shape" />
          <col className="c-yaku" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">待ち</th>
            <th scope="col">形</th>
            <th scope="col">役（どちらでも付く）</th>
            <th scope="col">ダマ</th>
            <th scope="col">リーチ</th>
          </tr>
        </thead>
        <tbody>
          {table.waits.map((row) => (
            <Row row={row} table={table} dealer={dealer} key={row.kind} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface PanelProps {
  box: WaitBox;
  dora: Dora;
}

/** タブ「待ちと打点」の中身。 */
export function WaitsPanel({ box, dora }: PanelProps) {
  return (
    <div className="wt-panel" data-ai="waits-box">
      <div className="sec-head">
        <h2 className="sec-title">待ちと打点・待ちの形・符</h2>
        <InfoTip label="待ちと打点の説明" id="wt-hint">
          {WAIT_HINT}
        </InfoTip>
      </div>
      <div className="wt-list">
        {box.tables.map((table) => (
          <Table table={table} dealer={box.dealer} dora={dora} key={table.key} />
        ))}
      </div>
      {box.omitted > 0 && <p className="quiet">ほか {box.omitted} 通りの切り方は省略しています。</p>}
    </div>
  );
}
