/**
 * 取り込んだ半荘の、再生した盤面つきの結果（`ImportedGame`）を、半荘ごとに作って覚えておく。
 * 出題（今日の出題・解き直し）は、判断ごとの盤面と向聴数が要るので、牌譜を再生した結果を使う（E-1・E-2）。
 *
 * - 結果の読み込み（`api.readReport`）と再生は、半荘ごとに 1 回ずつ、順番に行い、1 つ終えるたびに画面へ譲る（半荘が多くても固まらない）
 * - 一覧が変わったとき（`sync`）に、無くなった半荘・結果の場所が変わった半荘は忘れ、新しく結果ができた半荘だけを読む
 * - 読めない半荘（再生が記録と合わない、など）は、理由を持つだけで、問題を出さない
 * `SummaryStore`（sessionSummaries.ts）と同じ作り。
 */
import { importReportText, type ImportedGame } from '@jantama/engine';

import type { SessionRecord } from '../../api/types';

export type GameState =
  | { status: 'loading' }
  | { status: 'ready'; game: ImportedGame }
  | { status: 'unavailable'; reason: string };

/** 半荘の名前 → 再生した結果。結果を取り込んでいない半荘は、入っていない。 */
export type GameMap = ReadonlyMap<string, GameState>;

/** 半荘の結果（生の JSON の文字）を返す。無ければ null。 */
export type ReportLoader = (sessionId: string) => Promise<string | null | undefined>;

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 結果の JSON の文字から、再生した結果を作る。 */
export function gameFromReportText(text: unknown): GameState {
  if (typeof text !== 'string' || text === '') {
    return { status: 'unavailable', reason: '取り込んだ結果を読み出せませんでした' };
  }
  try {
    const imported = importReportText(text);
    if (!imported.ok) return { status: 'unavailable', reason: imported.error.message };
    return { status: 'ready', game: imported.value };
  } catch (error) {
    return { status: 'unavailable', reason: messageOf(error) };
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Entry {
  key: string;
  token: number;
  state: GameState;
}

type SessionRef = Pick<SessionRecord, 'id' | 'report_path'>;

const keyOf = (session: SessionRef) => `${session.id}\n${session.report_path ?? ''}`;

export class GameStore {
  private readonly entries = new Map<string, Entry>();
  private snapshot: GameMap = new Map();
  private queue: string[] = [];
  private tokens = 0;
  private pumping = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly load: ReportLoader,
    private readonly pause: () => Promise<void> = yieldToUi,
  ) {}

  getSnapshot = (): GameMap => this.snapshot;

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
        this.tokens += 1;
        this.entries.set(id, { key, token: this.tokens, state: { status: 'loading' } });
        this.queue.push(id);
        changed = true;
      }
    }
    if (changed) this.publish();
    void this.pump();
  }

  private publish(): void {
    this.snapshot = new Map([...this.entries].map(([id, entry]) => [id, entry.state] as const));
    for (const listener of [...this.listeners]) listener();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        const entry = this.entries.get(id);
        if (entry === undefined || entry.state.status !== 'loading') continue;
        const { token } = entry;
        let result: GameState;
        try {
          result = gameFromReportText(await this.load(id));
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
