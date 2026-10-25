/**
 * 自分の向聴数の推移（F14、E-41・U-36。提案 7）の言い方。計算はエンジン（`myTrackOf`）、ここは、図の点・吹き出し・「表で見る」の表に出す文にするだけ。
 *
 * - 点 1 つが 1 行: 巡目（配牌・N巡目）・打牌・向聴数・印。図の吹き出しと表は、同じ行から作る（数字が食い違わない）
 * - 「N巡目」は、自分の巡目（記録のまま。迷いのカードの「6巡目」と同じ数え方。自分のツモとチー・ポンで 1 つずつ増える）
 * - 印の文は、迷い（迷い3）・悪手・聴牌になった打牌。迷い・悪手の判断が、打牌以外（リーチ・鳴き・カン・和了）のときは、
 *   その行動を添える（例: 迷い4（東をポン））。打牌のときは、行の打牌と同じなので添えない
 * - AI の候補・確率・順位は出さない（SPEC F3）。出すのは、自分が実際にした行動だけ
 */
import { actionLabel, tileLabel, type MyKyokuTrack, type ReplayScene } from '@jantama/engine';

import { shantenValueText } from './study/tenpaiText';

/** 図の点と表の 1 行（配牌と、切るたびに 1 つ）。 */
export interface TrackRow {
  /** 自分の巡目（0 は配牌）。 */
  n: number;
  /** 表の「巡目」の欄。例: 配牌・8巡目。 */
  turn: string;
  /** 表の「打牌」の欄。例: 5p・赤5p・東。配牌は null。 */
  discard: string | null;
  /** 場面の向聴数（0 が聴牌）。 */
  shanten: number;
  /** 表の「向聴数」の欄。例: 聴牌・1向聴。 */
  shantenText: string;
  /** 表の「印」の欄に並べる文（無ければ空）。 */
  marks: string[];
  /** 図の吹き出しの値。例: 1向聴・迷い3。聴牌になった打牌は「聴牌になった」。 */
  tip: string;
  /** 図の吹き出しの名前。例: 8巡目 打5p。 */
  name: string;
  /** 聴牌になった打牌か（三角）。 */
  tenpai: boolean;
  /** 迷いの場面か（輪）。 */
  doubt: boolean;
  /** 悪手の場面か（菱形）。 */
  big: boolean;
}

/** 場面 1 つの印の文。例: 迷い3、迷い2・悪手、迷い4（東をポン）。 */
export function sceneMarkText(scene: ReplayScene): string {
  const parts = scene.doubts.map((number) => `迷い${number}`);
  if (scene.mismatch === 'big') parts.push('悪手');
  const { actual } = scene.decision.entry;
  const what = actual.type === 'dahai' ? '' : `（${actionLabel(actual, scene.decision.kind)}）`;
  return `${parts.join('・')}${what}`;
}

/** 巡目の言い方。例: 配牌・8巡目。 */
export function turnText(n: number): string {
  return n === 0 ? '配牌' : `${n}巡目`;
}

/** 1 局の推移を、図と表の行にする（点の順）。 */
export function trackRowsOf(track: MyKyokuTrack<ReplayScene>): TrackRow[] {
  const tenpai = new Map(track.tenpai.map((mark) => [mark.n, mark] as const));
  return track.points.map((point) => {
    const scenes = track.scenes.filter((item) => item.n === point.n);
    const mark = tenpai.get(point.n);
    const sceneMarks = scenes.map((item) => sceneMarkText(item.scene));
    const shantenText = shantenValueText(point.shanten);
    const tenpaiText = mark === undefined ? null : mark.again ? '再び聴牌になった' : '聴牌になった';
    const discard = point.discard === null ? null : tileLabel(point.discard);
    return {
      n: point.n,
      turn: turnText(point.n),
      discard,
      shanten: point.shanten,
      shantenText,
      marks: [...(tenpaiText === null ? [] : [tenpaiText]), ...sceneMarks],
      tip: [tenpaiText ?? shantenText, ...sceneMarks].join('・'),
      name: discard === null ? turnText(point.n) : `${turnText(point.n)} 打${discard}`,
      tenpai: mark !== undefined,
      doubt: scenes.some((item) => item.doubt),
      big: scenes.some((item) => item.big),
    };
  });
}


