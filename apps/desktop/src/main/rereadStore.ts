/**
 * 前の作り方で読んだ半荘の、読み直し（F11、E-27、U-23）の進み具合。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 取り込んだ半荘の画面を開いたとき（`open`）、その半荘の読み取りの写し（ocr.json）が前の作り方で読んだものかを確かめ、そうなら、
 * 保存してあるスクショを、いまの作り方で読み直す（Rust 側。書き換わるのは ocr.json だけで、結びつけ・評価・MAKA は変えない）。
 * 読み直しが済んだら、半荘の一覧を読み直して（`changed`）、画面を新しい読み取りで描き直す（推定は、読み取りから、いつもどおりに出し直す。
 * 推定は保存しない）。
 *
 * 読み直しのあとに、評価の当てはめを、必要なら当てはめ直す（`relink`。E-31）。評価の当てはめが前の当てはめ方で作ったものなら、1 回だけ当てはめ直して
 * 保存する。読み直しが要る半荘は、読み直しが済んで（最新の読み取りが保存されて）から当てはめる。読み直しに失敗したときは、当てはめ直さない
 * （前の読み取りで当てはめて、版を書いてしまうと、次の起動で最新の読み取りで当てはめ直せないため）。当てはめ直しは静かに進む（状態の 1 行は出さない）。
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
  /**
   * 読み直しのあとに呼ぶ、評価の当てはめ直し（E-31）。当てはめ直して保存したら true、要らなかったら false。失敗したら投げる。
   * 渡さなければ、当てはめ直さない。
   */
  relink?(sessionId: string): Promise<boolean>;
}

/** `open` の指定。 */
export interface OpenOptions {
  /**
   * 前の作り方で読んだ写しかを確かめて、そうなら読み直すか（既定は true）。読み取りの写しが無い半荘は false にして、
   * 評価の当てはめ直しだけを確かめる。
   */
  reread?: boolean;
}

/** 半荘の画面が使う口。 */
export interface Rereads {
  subscribe(listener: () => void): () => void;
  /** いま読み直している半荘の名前（変わるたびに、新しい値になる）。 */
  getSnapshot(): ReadonlySet<string>;
  /** 半荘の画面を開いた。この起動で、まだ確かめていない半荘だけ、読み直しが要るか確かめて、要れば読み直す。そのあと、評価を当てはめ直す。 */
  open(sessionId: string, options?: OpenOptions): void;
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

  open = (sessionId: string, options: OpenOptions = {}): void => {
    if (this.tried.has(sessionId)) return;
    this.tried.add(sessionId);
    void this.run(sessionId, options.reread !== false);
  };

  private setReading(sessionId: string, on: boolean): void {
    const next = new Set(this.reading);
    if (on) next.add(sessionId);
    else next.delete(sessionId);
    this.reading = next.size === 0 ? NOBODY : next;
    for (const listener of [...this.listeners]) listener();
  }

  private async run(sessionId: string, check: boolean): Promise<void> {
    let started = false;
    let rewritten = false;
    try {
      if (check && (await this.deps.needed(sessionId)) === true) {
        started = true;
        this.setReading(sessionId, true);
        rewritten = (await this.deps.reread(sessionId)) === true;
      }
      // 読み直しのあとに、評価を当てはめ直す（読み直しに失敗したときは、ここへ来ない）。失敗しても、読み直しの結果は反映する
      let relinked = false;
      try {
        relinked = this.deps.relink !== undefined && (await this.deps.relink(sessionId)) === true;
      } catch {
        // 当てはめ直せなかった（版を書けていないので、次の起動でもう一度試せる）。繰り返さない。
      }
      // 一覧を読み直して、新しい読み取り・当てはめを、画面に反映する。そのあとで、状態の 1 行を消す（古い値のまま、1 行だけ消えることが無いように）。
      if (rewritten || relinked) await this.deps.changed();
    } catch {
      // 読み直せなかった（理由は Rust 側が標準エラーに書いた）。前の読み取りのまま。繰り返さない。
    } finally {
      if (started) this.setReading(sessionId, false);
    }
  }
}
