/**
 * 操作の取り消し（U-11、R8-4）の中心。画面にも Tauri にも依存しない、小さな命令の積み重ね。
 *
 * - `run(命令)`: 命令を実行して、積む。やり直しの積み重ねは捨てる
 * - `undo()`: いちばん新しい命令を取り消す（取り消した命令は、やり直しの積み重ねに移る）
 * - `redo()`: いちばん新しく取り消した命令を、やり直す
 *
 * 命令は、半荘の削除・局の評価の付け直し・迷いマークの結びつけ・MAKA の評価の入力・原因分類などが登録する。
 * 履歴はメモリの中だけで持つ。アプリを閉じたら、なくなる（SPEC 7章）。
 *
 * 実行・取り消し・やり直しは、1 つずつ順番に動く（命令が非同期でも、重ならない）。
 * キーを押しっぱなしにして取り消しが連打されても、同じ命令を 2 回取り消さない。
 * 失敗したとき（例外が出たとき）は、積み重ねを変えない。
 */

/** 命令のあとに出す通知の文。無い項目は、通知を出さない。 */
export interface UndoMessages {
  /** 実行したあと（通知には「元に戻す」が付く）。 */
  run?: string;
  /** 取り消したあと。 */
  undo?: string;
  /** やり直したあと（通知には「元に戻す」が付く）。 */
  redo?: string;
}

export interface UndoCommand {
  /** 短い名前（例: 半荘の削除）。 */
  readonly label: string;
  readonly messages?: UndoMessages;
  /** 操作そのもの。`run` のとき 1 回だけ呼ばれる。 */
  execute(): void | Promise<void>;
  /** 取り消す。 */
  undo(): void | Promise<void>;
  /** やり直す。無ければ `execute` をもう一度呼ぶ。 */
  redo?(): void | Promise<void>;
}

export type UndoAction = 'run' | 'undo' | 'redo';

export type UndoEvent =
  | { type: UndoAction; command: UndoCommand }
  | { type: 'failed'; action: UndoAction; command: UndoCommand; error: unknown };

/** 積み重ねる命令の数の上限。これを超えたら、いちばん古いものから忘れる。 */
export const DEFAULT_UNDO_LIMIT = 200;

export class UndoStack {
  private undoList: UndoCommand[] = [];
  private redoList: UndoCommand[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: UndoEvent) => void>();

  constructor(private readonly limit: number = DEFAULT_UNDO_LIMIT) {}

  /** 取り消せる命令があるか。 */
  get canUndo(): boolean {
    return this.undoList.length > 0;
  }

  /** やり直せる命令があるか。 */
  get canRedo(): boolean {
    return this.redoList.length > 0;
  }

  /** 次に取り消される命令の名前。 */
  get undoLabel(): string | null {
    return this.undoList.at(-1)?.label ?? null;
  }

  /** 次にやり直される命令の名前。 */
  get redoLabel(): string | null {
    return this.redoList.at(-1)?.label ?? null;
  }

  /** 積み重ねが変わるたびに増える数。`useSyncExternalStore` の見張りに使う。 */
  getSnapshot = (): number => this.version;

  /** 積み重ねが変わったときに呼ぶ受け手を足す。戻り値は外す関数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 実行・取り消し・やり直し・失敗の知らせを受ける。戻り値は外す関数。 */
  onEvent = (listener: (event: UndoEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  /** 命令を実行して積む。実行が失敗したら、積まずに、例外をそのまま投げる。 */
  run(command: UndoCommand): Promise<void> {
    return this.enqueue(async () => {
      try {
        await command.execute();
      } catch (error) {
        this.emit({ type: 'failed', action: 'run', command, error });
        throw error;
      }
      this.undoList.push(command);
      if (this.undoList.length > this.limit) this.undoList.splice(0, this.undoList.length - this.limit);
      this.redoList = [];
      this.changed();
      this.emit({ type: 'run', command });
    });
  }

  /** いちばん新しい命令を取り消す。取り消した命令を返す（取り消せるものが無ければ null）。 */
  undo(): Promise<UndoCommand | null> {
    return this.enqueue(async () => {
      const command = this.undoList.at(-1);
      if (command === undefined) return null;
      try {
        await command.undo();
      } catch (error) {
        this.emit({ type: 'failed', action: 'undo', command, error });
        throw error;
      }
      this.undoList.pop();
      this.redoList.push(command);
      this.changed();
      this.emit({ type: 'undo', command });
      return command;
    });
  }

  /** いちばん新しく取り消した命令をやり直す。やり直した命令を返す（無ければ null）。 */
  redo(): Promise<UndoCommand | null> {
    return this.enqueue(async () => {
      const command = this.redoList.at(-1);
      if (command === undefined) return null;
      try {
        await (command.redo ? command.redo() : command.execute());
      } catch (error) {
        this.emit({ type: 'failed', action: 'redo', command, error });
        throw error;
      }
      this.redoList.pop();
      this.undoList.push(command);
      this.changed();
      this.emit({ type: 'redo', command });
      return command;
    });
  }

  /** 履歴をすべて忘れる（保存先を変えたときなど、古い命令がもう使えないとき）。 */
  clear(): void {
    this.undoList = [];
    this.redoList = [];
    this.changed();
  }

  /** 1 つずつ順番に動かす。前の仕事が失敗していても、次の仕事は動く。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  private emit(event: UndoEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }
}
