import type { PaipuLink } from '@jantama/engine';

import { Icon } from './Icon';
import { paipuDateText } from './importFlow';

interface Props {
  link: PaipuLink;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * 「この半荘を取り込みますか」（F1、E-15）。雀魂で牌譜リンクをコピーして、この窓に戻ったとき、
 * 新しい牌譜リンクを見つけたら、一度だけ出す（同じ牌譜の ID は、もう出さない）。邪魔にならないよう、窓をふさがず、
 * ページの上に静かに置く。取り込みのページを開いているときは、ページ自身が同じ案内を出すので、これは出さない。
 */
export function ImportOffer({ link, onAccept, onDismiss }: Props) {
  const date = paipuDateText(link.paipuId);
  return (
    <div className="offer" role="status">
      <Icon name="link" className="lead-icon" />
      <span>
        {date === null ? '雀魂の牌譜リンクをコピーしました。' : `雀魂の牌譜リンク（${date}の半荘）をコピーしました。`}
        この半荘を取り込みますか
      </span>
      <span className="spacer" />
      <button type="button" className="btn primary sm" onClick={onAccept}>
        取り込む
      </button>
      <button type="button" className="btn sm" onClick={onDismiss}>
        あとで
      </button>
    </div>
  );
}
