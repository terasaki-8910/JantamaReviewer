/**
 * 役の欄（答え合わせの、受け入れ枚数の欄の下。F13・U-33。R14-1）。
 *
 * 比べる行動（自分・実戦・AI。鳴きの判断はチー・ポン・スルー）ごとに 1 つのかたまりで、その行動のあとの手の
 *   - 確定している役（聴牌なら、どの待ちでも付く役。札は accent の淡い塗り）
 *   - 一部の待ちだけで付く役（札は破線の枠）
 *   - 近い役（あと 3 枚以内。札は枠だけ。足りない牌・切る牌の説明つき）
 *   - 役無しの警告（副露した手。札「役無し」は濃い枠、文は太字。色だけに頼らない）と、薄い字の注（門前の一言・ダマだと役が無い待ち・切れば聴牌になる切り方）
 * を出す。行動の中身が全部同じなら、1 つにまとめて出す。AI の行動を含むので、答え合わせのあとにだけ描く（U-1。呼ぶ側が決める）。
 * 説明の文は、見出しのそばの説明のアイコン（InfoTip。R11-1）に置く。見た目は styles/yaku.css（承認済みの見本の部品。色はトークンだけ）。
 */
import { sortTiles, tileLabel, type YakuBlock, type YakuBox, type YakuPart, type YakuSummary } from '@jantama/engine';
import { Fragment, type ReactNode } from 'react';

import { InfoTip } from '../InfoTip';
import { isDoraTile } from './dora';
import { Tile } from './Tile';

type Dora = ReadonlySet<number> | null;

/** 言い方の部品（文字と、牌の並び）。 */
function Parts({ parts, dora }: { parts: readonly YakuPart[]; dora: Dora }) {
  return (
    <>
      {parts.map((part, index) =>
        'text' in part ? (
          <span className="yk-t" key={index}>
            {part.text}
          </span>
        ) : (
          <span className="yk-tiles" key={index}>
            {part.tiles.map((tile, at) => (
              <Tile key={`${at}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
            ))}
          </span>
        ),
      )}
    </>
  );
}

/** 行動の見出し: 打牌は「打」と牌、鳴きなどはボタンの名前（チー・ポンは、できる面子の牌）。 */
function ActionLabel({ block, dora }: { block: YakuBlock; dora: Dora }) {
  if (block.tile !== null) {
    return (
      <>
        打<Tile tile={block.tile} dora={isDoraTile(block.tile, dora)} />
      </>
    );
  }
  const option = block.option;
  if (option === null) return null;
  const meld = option.kind === 'chi' || option.kind === 'pon' ? sortTiles(option.called === null ? option.use : [...option.use, option.called]) : [];
  return (
    <>
      <b>{option.label}</b>
      {meld.map((tile, index) => (
        <Tile key={`${index}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
      ))}
    </>
  );
}

/** 行動のあとの手の見出し（右寄せ）: 向聴数。聴牌なら待ち（役が付かない待ちは「（役無し）」を添える）。 */
function Summary({ summary }: { summary: YakuSummary }) {
  if (summary.discardFirst) return <>{summary.shanten <= 0 ? '切れば聴牌' : `切って${summary.shanten}向聴`}</>;
  if (summary.shanten > 0) return <>{summary.shanten}向聴</>;
  return (
    <>
      聴牌（
      <span className="yk-waits">
        {summary.waits.map((wait, index) => (
          <Fragment key={wait.tile}>
            {index > 0 && '・'}
            <span className={wait.dead ? 'dead' : undefined}>
              {tileLabel(wait.tile)}
              {wait.dead ? '（役無し）' : ''}
            </span>
          </Fragment>
        ))}
      </span>
      {summary.waits.length > 0 ? ' 待ち）' : '）'}
    </>
  );
}

/** 切る前の手（鳴いた直後）で、切れば聴牌になる切り方（先頭 3 つまで）。 */
function AfterDiscardNote({ block }: { block: YakuBlock }) {
  const shown = block.afterDiscard.slice(0, 3);
  return (
    <span className="yk-note-line">
      聴牌になる切り方:{' '}
      {shown.map((after, index) => (
        <Fragment key={after.tile}>
          {index > 0 && '、'}打{tileLabel(after.tile)}（
          {after.waits.map((wait, at) => (
            <Fragment key={wait.tile}>
              {at > 0 && '・'}
              {tileLabel(wait.tile)}
              {wait.dead ? '×' : ''}
            </Fragment>
          ))}{' '}
          待ち）
        </Fragment>
      ))}
      {block.afterDiscard.length > 3 ? ` ほか${block.afterDiscard.length - 3}通り` : ''}（×は役が付かない待ち）
    </span>
  );
}

function Notes({ block, dora }: { block: YakuBlock; dora: Dora }) {
  const { text } = block;
  const lines: ReactNode[] = [];
  if (text.warning !== null && text.warning.level !== 'danger') {
    lines.push(
      <span className="yk-note-line" key="warning">
        <Parts parts={text.warning.parts} dora={dora} />
      </span>,
    );
  }
  const note = text.openNote ?? text.closedNote;
  if (note !== null) {
    lines.push(
      <span className="yk-note-line" key="note">
        {note}
      </span>,
    );
  }
  if (block.summary.discardFirst && block.afterDiscard.length > 0) lines.push(<AfterDiscardNote block={block} key="after" />);
  if (lines.length === 0) return null;
  return <p className="yk-note">{lines}</p>;
}

/** 行動 1 つ（まとめたときは、見出しが「どの行動でも同じ」）の、確定・一部の待ち・近い役・警告・注。 */
function Row({ block, merged, dora }: { block: YakuBlock; merged: boolean; dora: Dora }) {
  const { text } = block;
  const danger = text.warning !== null && text.warning.level === 'danger' ? text.warning : null;
  // まとめた行は、どの行動のものでもないので、名札の色を付けない
  const kind = merged ? 'other' : block.tags.includes('自分') ? 'you' : block.tags.includes('AI') ? 'top' : block.tags.includes('実戦') ? 'act' : 'other';
  const chip = block.state === 'open-partial' ? '役無しの待ちあり' : '役無し';
  const settledEmpty = text.settled.length === 0 && danger === null;
  return (
    <li className={`yk-row ${kind}`} data-ai="yaku">
      <div className="yk-top">
        {merged ? (
          <span className="yk-tags same">どの行動でも同じ</span>
        ) : (
          <>
            <span className="yk-tags">{block.tags.length > 0 ? block.tags.join('・') : '候補'}</span>
            <span className="yk-dis">
              <ActionLabel block={block} dora={dora} />
            </span>
            <span className="yk-sh">
              <Summary summary={block.summary} />
            </span>
          </>
        )}
      </div>
      <dl className="yk-dl">
        <div className={`yk-g${settledEmpty ? ' none' : ''}`}>
          <dt>確定している役</dt>
          {settledEmpty ? (
            <dd className="yk-none">なし</dd>
          ) : (
            <dd>
              {text.settled.map((line) => (
                <div className="yk-item" key={line.id}>
                  <span className="q-tag sure">{line.name}</span>
                  <span className="yk-d">
                    <span className="yk-t">
                      {line.han}飜{block.closed ? '' : '（副露）'}
                    </span>
                  </span>
                </div>
              ))}
              {danger !== null && (
                <div className="yk-item">
                  <span className="q-tag none">{chip}</span>
                  <span className="yk-d strong">
                    <Parts parts={danger.parts} dora={dora} />
                  </span>
                </div>
              )}
            </dd>
          )}
        </div>
        {text.partial.length > 0 && (
          <div className="yk-g">
            <dt>一部の待ちだけ</dt>
            <dd>
              {text.partial.map((line) => (
                <div className="yk-item" key={line.id}>
                  <span className="q-tag partial">{line.name}</span>
                  <span className="yk-d">
                    <Parts parts={line.parts} dora={dora} />
                  </span>
                </div>
              ))}
            </dd>
          </div>
        )}
        <div className={`yk-g${text.near.length > 0 ? '' : ' none'}`}>
          <dt>近い役</dt>
          {text.near.length > 0 ? (
            <dd>
              {text.near.map((line) => (
                <div className="yk-item" key={line.id}>
                  <span className="q-tag">{line.name}</span>
                  <span className="yk-d">
                    <Parts parts={line.parts} dora={dora} />
                  </span>
                </div>
              ))}
            </dd>
          ) : (
            <dd className="yk-none">なし</dd>
          )}
        </div>
      </dl>
      <Notes block={block} dora={dora} />
    </li>
  );
}

interface SectionProps {
  box: YakuBox;
  dora: Dora;
}

/** 役の欄。 */
export function YakuSection({ box, dora }: SectionProps) {
  const blocks = box.merged ? box.blocks.slice(0, 1) : box.blocks;
  return (
    <div className="q-sec" data-ai="yaku-box">
      <div className="sec-head">
        <h2 className="sec-title">役</h2>
        <InfoTip label="役の欄の説明" id="yk-hint">
          確定している役は、その行動のあとの手が、どう和了っても付く役です（聴牌なら、どの待ちでも付く役）。近い役は、あと3枚以内で付く役です。立直・門前清自摸和・ドラは数えません。
        </InfoTip>
      </div>
      <ul className="yk">
        {blocks.map((block) => (
          <Row block={block} merged={box.merged} dora={dora} key={block.key} />
        ))}
      </ul>
    </div>
  );
}
