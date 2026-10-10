/**
 * 半荘の一覧の行に出す「卓・段階・Rating」（U-8）を、取り込んだ結果（`report.json`）から作って、半荘ごとに覚えておく。
 *
 * - 作るのはエンジンの `summarizeHanchan`（結果を `parseReportText` で読んだもの）。牌譜の再生（取り込みのときの検査）まではしない
 *   （一覧の行を出すたびに、半荘を再生しないため）
 * - 結果の読み込みは、1 つずつ順番に行い、1 つ終えるたびに画面へ譲る（一覧が多くても、画面が固まらない）。新しい半荘から
 * - 半荘ごとに覚える。一覧が変わったとき（`sync`）に、無くなった半荘・結果の場所が変わった半荘は忘れ、新しく結果ができた半荘だけを読む。
 *   結果は、取り込んだあとは書き換わらない。段階の当てはめが変わったとき（MAKA の評価が増えたとき）は、`invalidate` で作り直す
 */
import { parseReportText, summarizeHanchan, type HanchanSummary } from '@jantama/engine';

import type { SessionRecord } from '../api/types';

export type SummaryState =
  | { status: 'loading' }
  | { status: 'ready'; summary: HanchanSummary }
  | { status: 'unavailable'; reason: string };

/** 半荘の名前 → まとめ。結果を取り込んでいない半荘は、入っていない。 */
export type SummaryMap = ReadonlyMap<string, SummaryState>;

/** 半荘の結果（生の JSON の文字）を返す。無ければ null。 */
export type ReportLoader = (sessionId: string) => Promise<string | null | undefined>;

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 結果の JSON の文字から、半荘のまとめを作る。読めなければ、その理由。 */
export function summarizeReportText(text: unknown): SummaryState {
  if (typeof text !== 'string' || text === '') {
    return { status: 'unavailable', reason: '取り込んだ結果を読み出せませんでした' };
  }
  try {
    const parsed = parseReportText(text);
    if (!parsed.ok) return { status: 'unavailable', reason: parsed.error.message };
    return { status: 'ready', summary: summarizeHanchan(parsed.value) };
  } catch (error) {
    return { status: 'unavailable', reason: messageOf(error) };
  }
}

/** 1 つ終えるたびに、画面（描画・入力）へ譲る。 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Entry {
  /** 半荘の名前と結果の場所。変わったら、作り直す。 */
  key: string;
  /** 読み込みの世代。古い読み込みの答えを捨てるため。 */
  token: number;
  state: SummaryState;
}

type SessionRef = Pick<SessionRecord, 'id' | 'report_path'>;

const keyOf = (session: SessionRef) => `${session.id}\n${session.report_path ?? ''}`;

export class SummaryStore {
  private readonly entries = new Map<string, Entry>();
  private snapshot: SummaryMap = new Map();
  private queue: string[] = [];
  private wanted = new Map<string, string>();
  private pumping = false;
  private tokens = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly load: ReportLoader,
    private readonly pause: () => Promise<void> = yieldToUi,
  ) {}

  /** いまのまとめ（変わるたびに、新しい値になる）。 */
  getSnapshot = (): SummaryMap => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 半荘の一覧が読めた・変わったときに呼ぶ。結果を取り込んだ半荘だけを、覚えておく。 */
  sync(sessions: readonly SessionRef[]): void {
    const wanted = new Map<string, string>();
    for (const session of sessions) {
      if (session.report_path !== null) wanted.set(session.id, keyOf(session));
    }
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (wanted.get(id) !== entry.key) {
        this.entries.delete(id);
        changed = true;
      }
    }
    for (const [id, key] of wanted) {
      if (!this.entries.has(id)) {
        this.start(id, key);
        changed = true;
      }
    }
    this.wanted = wanted;
    if (changed) this.publish();
    void this.pump();
  }

  /** 作り直す（`id` を渡せば、その半荘だけ）。覚えていたまとめは捨てて、もう一度読む。 */
  invalidate(id?: string): void {
    const targets = id === undefined ? [...this.wanted.keys()] : this.wanted.has(id) ? [id] : [];
    for (const target of targets) {
      this.entries.delete(target);
      this.start(target, this.wanted.get(target) as string);
    }
    this.publish();
    void this.pump();
  }

  private start(id: string, key: string): void {
    this.tokens += 1;
    this.entries.set(id, { key, token: this.tokens, state: { status: 'loading' } });
    this.queue.push(id);
  }

  private publish(): void {
    this.snapshot = new Map([...this.entries].map(([id, entry]) => [id, entry.state] as const));
    for (const listener of [...this.listeners]) listener();
  }

  /** 読み込みの順番待ちを、1 つずつ進める。すでに動いていれば、そのまま任せる。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        const entry = this.entries.get(id);
        if (entry === undefined || entry.state.status !== 'loading') continue;
        const { token } = entry;
        let result: SummaryState;
        try {
          result = summarizeReportText(await this.load(id));
        } catch (error) {
          result = { status: 'unavailable', reason: messageOf(error) };
        }
        const current = this.entries.get(id);
        if (current === undefined || current.token !== token) continue;
        current.state = result;
        this.publish();
        await this.pause();
      }
    } finally {
      this.pumping = false;
    }
  }
}
