// @kobalab/majiang-core（MIT。Copyright (c) 2021 Satoshi Kobayashi）は型定義を持たない CommonJS のパッケージ。
// 使う分だけ、型を書く。このパッケージを読み込んでよいのは、エンジンの中で majiang-adapter.ts だけ（purity.test.ts の例外）。
// 試験の部品（tests/helpers/majiang-evaluate.ts）も、同じ型を使う。
declare module '@kobalab/majiang-core' {
  interface HupaiItem {
    name: string;
    /** 飜数。役満は '*'（ダブル役満は '**'）。 */
    fanshu: number | string;
    baojia?: string;
  }
  interface HuleResult {
    hupai?: HupaiItem[];
    fu?: number;
    fanshu?: number;
    damanguan?: number;
    defen: number;
    /** 4 人の点数の増減（親からの相対席）。本場・供託を含む。 */
    fenpei?: number[];
  }
  interface HuleParam {
    rule: Record<string, unknown>;
    zhuangfeng: number;
    menfeng: number;
  }
  interface HuleParamInput {
    rule?: Record<string, unknown>;
    zhuangfeng?: number;
    menfeng?: number;
    lizhi?: number;
    yifa?: boolean;
    qianggang?: boolean;
    lingshang?: boolean;
    haidi?: number;
    tianhu?: number;
    baopai?: string | string[];
    fubaopai?: string | string[] | null;
    changbang?: number;
    lizhibang?: number;
  }
  interface Shoupai {
    toString(): string;
  }
  const Majiang: {
    rule: (param?: Record<string, unknown>) => Record<string, unknown>;
    Shoupai: { fromString(paistr?: string): Shoupai };
    Util: {
      hule(shoupai: Shoupai, rongpai: string | undefined, param: HuleParam): HuleResult | undefined;
      hule_param(param?: HuleParamInput): HuleParam;
      /** 和了形の面子の分解（和了牌に `!` が付く）。和了形でなければ空。 */
      hule_mianzi(shoupai: Shoupai, rongpai?: string): string[][];
      /** 待ち牌。向聴数が減る牌（聴牌でない手では、受け入れ）を返す。ツモ牌があるときは null。 */
      tingpai(shoupai: Shoupai): string[] | null;
      xiangting(shoupai: Shoupai): number;
    };
  };
  export default Majiang;
}
