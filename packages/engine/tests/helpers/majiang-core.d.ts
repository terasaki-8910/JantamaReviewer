// @kobalab/majiang-core（MIT。Copyright (c) 2021 Satoshi Kobayashi）は型定義を持たない CommonJS のパッケージ。
// 役の調査の比べる試験（yaku-majiang-core.test.ts）が使う分だけ、型を書く。
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
    fenpei?: number[];
  }
  interface HuleParam {
    rule: Record<string, unknown>;
    zhuangfeng: number;
    menfeng: number;
  }
  interface Shoupai {
    toString(): string;
  }
  const Majiang: {
    rule: (param?: Record<string, unknown>) => Record<string, unknown>;
    Shoupai: { fromString(paistr?: string): Shoupai };
    Util: {
      hule(shoupai: Shoupai, rongpai: string | undefined, param: HuleParam): HuleResult | undefined;
      hule_param(param?: {
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
        fubaopai?: string | string[];
        changbang?: number;
        lizhibang?: number;
      }): HuleParam;
      tingpai(shoupai: Shoupai): string[] | null;
      xiangting(shoupai: Shoupai): number;
    };
  };
  export default Majiang;
}
