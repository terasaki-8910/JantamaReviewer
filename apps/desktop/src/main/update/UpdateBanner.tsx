import { useId } from 'react';

import { Icon } from '../Icon';
import { useUpdate } from './UpdateProvider';
import {
  BANNER_LABEL,
  INSTALLING_TEXT,
  INSTALL_LABEL,
  LATER_LABEL,
  RECORDING_REASON,
  SKIP_LABEL,
  foundText,
} from './updateText';

interface Props {
  /** true のあいだは出さない（設定のページは、同じ案内を「更新」の欄に出すので、帯は出さない）。 */
  hidden?: boolean;
}

/**
 * 新しい版の知らせ（F21、U-51）。検討画面の上に、取り込みの誘い（`ImportOffer`）と同じ形の帯で出す。
 * 「新しい版 0.2.1 があります」と、「今すぐ入れ直す」「あとで」「この版は飛ばす」。ウィジェットには出さない（この部品はウィジェットに無い）。
 *
 * - 「あとで」: 起動し直すまで出さない（メモリの中だけ）。「この版は飛ばす」: 設定に覚え、同じ版では出さず、もっと新しい版では出す
 * - 「今すぐ入れ直す」を押すまで、ダウンロードも入れ直しもしない。入れている間は「新しい版を入れています…」を出し、ボタンを押せなくする
 * - 記録中は、「今すぐ入れ直す」を押せない（理由を、帯に書く）
 * - 領域（region）に名前を付け、ボタンは Tab で届く。出す・入れる間の文は、読み上げられる（role="status"）
 */
export function UpdateBanner({ hidden = false }: Props) {
  const update = useUpdate();
  const reasonId = useId();
  if (update === null || hidden || update.offer === null) return null;
  const { offer, installing, recording, error } = update;
  const blocked = recording && !installing;
  return (
    <section className="offer update-offer" aria-label={BANNER_LABEL}>
      <Icon name="download" className="lead-icon" />
      <span role="status">{installing ? INSTALLING_TEXT : foundText(offer)}</span>
      <span className="spacer" />
      <button
        type="button"
        className="btn primary sm"
        disabled={installing || recording}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => void update.install()}
      >
        {INSTALL_LABEL}
      </button>
      <button type="button" className="btn sm" disabled={installing} onClick={update.postpone}>
        {LATER_LABEL}
      </button>
      <button type="button" className="btn sm" disabled={installing} onClick={() => void update.skip()}>
        {SKIP_LABEL}
      </button>
      {blocked && (
        <p className="quiet update-note" id={reasonId}>
          {RECORDING_REASON}
        </p>
      )}
      {error !== null && (
        <p className="error update-note selectable" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
