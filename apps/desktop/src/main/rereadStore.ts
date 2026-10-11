/**
 * 前の作り方で読んだ半荘の、読み直し（F11、E-27、U-23）の進み具合。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 取り込んだ半荘の画面を開いたとき（`open`）、その半荘の読み取りの写し（ocr.json）が前の作り方で読んだものかを確かめ、そうなら、
 * 保存してあるスクショを、いまの作り方で読み直す（Rust 側。書き換わるのは ocr.json だけで、結びつけ・評価・MAKA は変えない）。
 * 読み直しが済んだら、半荘の一覧を読み直して（`changed`）、画面を新しい読み取りで描き直す（推定は、読み取りから、いつもどおりに出し直す。
 * 推定は保存しない）。
 *
 * - この起動の間、同じ半荘では 1 回だけ。要らなかったときも、失敗したときも、もう一度は確かめない（失敗を繰り返さない）
 * - 読み直している間（`getSnapshot` に半荘の名前が入っている間）、画面は、静かな 1 行を出す。画面を移っても、読み直しは続く
 *   （戻ってきたときにも、読み直している最中だと分かる）。読み直す間も、画面は前の読み取りの値で描いてある
 * - 失敗したときは、前の読み取りのまま。理由は Rust 側が標準エラーに書くので、画面には何も足さない（状態の 1 行を消すだけ）
 */

/** 読み直しが使う、Rust 側のコマンドと、一覧の読み直し（試験では差し替える）。 */
export interface RereadDeps {
  /** 前の作り方で読んだ写しか（読み直しが要るか）。 */
  needed(sessionId: string): Promise<boolean>;
  /** 読み直して、新しい写しを書く。書き直したら true、要らなかったら false。失敗したら投げる。 */
  reread(sessionId: string): Promise<boolean>;
  /** 半荘の一覧を読み直す（新しい読み取りを、画面に反映する）。 */
  changed(): Promise<void>;
}

/** 半荘の画面が使う口。 */
export interface Rereads {
  subscribe(listener: () => void): () => void;
  /** いま読み直している半荘の名前（変わるたびに、新しい値になる）。 */
  getSnapshot(): ReadonlySet<string>;
  /** 半荘の画面を開いた。この起動で、まだ確かめていない半荘だけ、読み直しが要るか確かめて、要れば読み直す。 */
  open(sessionId: string): void;
}

const NOBODY: ReadonlySet<string> = new Set();

/** 何もしない読み直し（渡されなかったときの既定。読み直さず、状態の 1 行も出さない）。 */
export const IDLE_REREADS: Rereads = {
  subscribe: () => () => undefined,
  getSnapshot: () => NOBODY,
  open: () => undefined,
};

export class RereadStore implements Rereads {
  /** この起動で、もう確かめた（読み直した・要らなかった・失敗した）半荘。 */
  private readonly tried = new Set<string>();
  private reading: ReadonlySet<string> = NOBODY;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: RereadDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlySet<string> => this.reading;

  open = (sessionId: string): void => {
    if (this.tried.has(sessionId)) return;
    this.tried.add(sessionId);
    void this.run(sessionId);
  };

  private setReading(sessionId: string, on: boolean): void {
    const next = new Set(this.reading);
    if (on) next.add(sessionId);
    else next.delete(sessionId);
    this.reading = next.size === 0 ? NOBODY : next;
    for (const listener of [...this.listeners]) listener();
  }

  private async run(sessionId: string): Promise<void> {
    let started = false;
    try {
      if ((await this.deps.needed(sessionId)) !== true) return;
      started = true;
      this.setReading(sessionId, true);
      // 読み直せたら、一覧を読み直して、新しい読み取りで描き直す。そのあとで、状態の 1 行を消す（古い値のまま、1 行だけ消えることが無いように）。
      if ((await this.deps.reread(sessionId)) === true) await this.deps.changed();
    } catch {
      // 読み直せなかった（理由は Rust 側が標準エラーに書いた）。前の読み取りのまま。繰り返さない。
    } finally {
      if (started) this.setReading(sessionId, false);
    }
  }
}
