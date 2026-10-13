/**
 * 答え合わせのタブ「守備」の中身（F14、E-39、U-34。R15-2・R15-4。提案 3）。
 *
 * 他家のリーチがある場面で、自分が切れる牌 1 種類ずつに、リーチした人ごとの分類を 1 語（現物・スジ・壁・字牌・無スジ）と短い補足で出す。
 * 形式的な分類で、AI の確率ではない（見出しと説明のアイコンに書く）。リーチした人が 2 人以上のときは、人ごとに 1 つの欄を、宣言した順に並べる。
 * 欄の頭の 1 行は、リーチした人・比べる打牌（自分・実戦・AI）の分類・現物の牌。そのあとに、その人の河（太い枠がリーチ宣言牌）と、牌ごとの行。
 * リーチしていない他家のうち、副露が 2 つ以上の人か、染め手の気配の人には、牌ごとの分類を出さず、気配の 1 行だけを、リーチの人の欄のあとに出す
 * （R16-6 の B。「下家: 2副露・索子の染め手の気配・役牌の刻子（發）」）。リーチの人がいなければ、この 1 行（と断り）だけの欄になる。
 * 分類の中身はエンジン（danger.ts・open-sign.ts）が決める。ここは並べるだけ。見た目は styles/danger.css（承認済みの見本の部品。色はトークンだけ）。
 * AI の行動の印を含むので、答え合わせのあとにだけ描く（U-1。呼ぶ側が決める）。
 */
import { plainTile, tileLabel, type DangerBox, type DangerClass, type DangerRow, type DangerSection, type OpenSignLine, type RiverTile, type YakuMark } from '@jantama/engine';

import { Fragment } from 'react';

import { InfoTip } from '../InfoTip';
import { isDoraTile } from './dora';
import { Tile } from './Tile';
import { tileName } from './tiles';

type Dora = ReadonlySet<number> | null;

/** 見出しの、形式的な分類であることの断り（仕様 F14 の文）。 */
export const DANGER_CAPTION = '形式的な分類です。AI の確率ではありません';

/** 副露の気配の行の下に出す断り（R16-6 の B）。 */
export const SIGN_NOTE = '副露の人は、牌ごとの分類を出さず、気配の 1 行だけです。';

/**
 * 説明のアイコンの文: 断りと、5 つの分類の説明（承認された見本の文に、仕様の断りを頭に足した）。
 * 牌ごとの分類を出すのはリーチした人だけ。副露の人は、1 行だけ（R16-6）。
 */
export const DANGER_HINT = `${DANGER_CAPTION}。リーチした人の河（現物）と、場に見えている牌の数だけで、切れる牌を 5 つに分けています。現物: その人の河にある牌と、その人のリーチのあとに通った牌。スジ: 両面で待たれる形が、現物のスジで消えている牌（嵌張・辺張・単騎・双碰は残ります）。壁: 両面の形に要る牌が 4 枚見えている牌。字牌: 現物でない字牌（見えている枚数つき）。無スジ: 両面で待たれる形が残っている牌。リーチしていない人のうち、副露が 2 つ以上の人と、染め手の気配（副露がすべて同じ色か字牌で、河にその色が 1 枚以下）の人には、気配の 1 行だけを出します。ドラ待ち・巡目は見ていません。`;

/** リーチの人がいないときの、説明のアイコンの文（行だけの欄）。 */
export const SIGN_HINT = '副露が 2 つ以上の人と、染め手の気配（副露がすべて同じ色か字牌で、河にその色が 1 枚以下）の人を、1 行で出します。牌ごとの分類は、リーチした人にだけ出します。AI の判断ではなく、副露から読んだ気配です。ドラ・巡目は見ていません。';

/** 印の色の種類（自分・AI・実戦）。 */
const markKind = (tags: readonly YakuMark[]): string => (tags.includes('自分') ? 'you' : tags.includes('AI') ? 'top' : tags.includes('実戦') ? 'act' : 'other');

/** 分類の札の見た目: 現物は塗り、無スジは濃い枠、そのほか（スジ・壁・字牌）は薄い枠。 */
const classKind = (cls: DangerClass): string => (cls === '現物' ? 'safe' : cls === '無スジ' ? 'risky' : 'mid');

/** 牌の呼び名（数牌は 5p、字牌は漢字。赤五は普通の五）。 */
const tileText = (tile: string): string => tileLabel(plainTile(tile));

function RiverTiles({ section, dora }: { section: DangerSection; dora: Dora }) {
  return (
    <span className="dg-river" role="group" aria-label={`${section.who}の河`}>
      {section.river.map((entry: RiverTile, index) => {
        const called = entry.calledBy !== null;
        const classes = [called ? 'called' : '', entry.tsumogiri ? 'tg' : '', entry.riichi ? 'dg-riichi' : ''].filter((c) => c !== '').join(' ');
        const alt = tileName(entry.tile) + (entry.tsumogiri ? '（ツモ切り）' : '') + (called ? '（鳴かれた牌）' : '') + (entry.riichi ? '（リーチ宣言牌）' : '');
        return <Tile key={`${index}${entry.tile}`} tile={entry.tile} className={classes} alt={alt} dora={!called && isDoraTile(entry.tile, dora)} />;
      })}
    </span>
  );
}

/** 欄の頭の 1 行: リーチした人・比べる打牌の分類・現物の牌。 */
function SummaryLine({ section }: { section: DangerSection }) {
  return (
    <p className="dg-line">
      <span>{section.who}がリーチ</span>{' '}
      {section.compared.map((row) => (
        <Fragment key={row.kind}>
          <span>
            <b>
              {row.tags.join('・')} 打{tileText(row.tile)}
            </b>{' '}
            {row.cls}（{row.note}）
          </span>{' '}
        </Fragment>
      ))}
      <span>現物: {section.genbutsu.length === 0 ? 'なし' : section.genbutsu.map(tileText).join('・')}</span>
    </p>
  );
}

function Row({ row, dora }: { row: DangerRow; dora: Dora }) {
  return (
    <li className={`dg-row${row.tags.length > 0 ? ' picked' : ''}`}>
      <Tile tile={row.tile} dora={isDoraTile(row.tile, dora)} />{' '}
      <span className={`dg-c ${classKind(row.cls)}`}>{row.cls}</span>{' '}
      <span className="nt">
        {row.note}
        {row.tags.length > 0 && (
          <>
            {' '}
            <span className={`mk ${markKind(row.tags)}`}>{row.tags.join('・')}</span>
          </>
        )}
      </span>
    </li>
  );
}

function Section({ section, dora }: { section: DangerSection; dora: Dora }) {
  return (
    <div className="dg-sec" role="group" aria-label={`${section.who}のリーチに対する、切る牌ごとの守備の目安`}>
      <SummaryLine section={section} />
      <div className="dg-opp">
        <span className="nm">{section.who}がリーチ（河。太い枠がリーチ宣言牌）</span>
        <RiverTiles section={section} dora={dora} />
      </div>
      <ul className="dg-list" aria-label={`${section.who}に対する、切る牌ごとの守備の目安`}>
        {section.rows.map((row) => (
          <Row row={row} dora={dora} key={row.kind} />
        ))}
      </ul>
    </div>
  );
}

/** 副露の気配の行（リーチしていない対象の人）。 */
function SignLines({ signs }: { signs: readonly OpenSignLine[] }) {
  return (
    <div className="dg-signs">
      <ul className="dg-sign-list" aria-label="副露の気配">
        {signs.map((line) => (
          <li key={line.seat} data-seat={line.seat}>
            {line.text}
          </li>
        ))}
      </ul>
      <p className="dg-sign-note">{SIGN_NOTE}</p>
    </div>
  );
}

interface PanelProps {
  box: DangerBox;
  dora: Dora;
}

/** タブ「守備」の中身。 */
export function DangerPanel({ box, dora }: PanelProps) {
  const classified = box.sections.length > 0;
  return (
    <div className="dg-panel" data-ai="danger-box">
      <div className="sec-head">
        {classified ? (
          <>
            <h2 className="sec-title">守備の目安（{DANGER_CAPTION}）</h2>
            <InfoTip label="守備の目安の説明" id="dg-hint">
              {DANGER_HINT}
            </InfoTip>
          </>
        ) : (
          <>
            <h2 className="sec-title">守備の目安（副露の気配）</h2>
            <InfoTip label="守備の目安の説明" id="dg-hint">
              {SIGN_HINT}
            </InfoTip>
          </>
        )}
      </div>
      {classified && box.afterCall && <p className="dg-after">鳴いたあとに切れる牌の分類です。</p>}
      {classified && (
        <div className="dg-secs">
          {box.sections.map((section) => (
            <Section section={section} dora={dora} key={section.seat} />
          ))}
        </div>
      )}
      {box.signs.length > 0 && <SignLines signs={box.signs} />}
    </div>
  );
}
