/**
 * Rust 側（src-tauri）とやり取りするデータの型。
 * フィールド名は Rust 側の JSON（snake_case）に合わせている。手で同期する（自動生成はしない）。
 */

/** 局の評価。〇 = good、△ = fair、✕ = bad。 */
export type Rating = 'good' | 'fair' | 'bad';

export type Orientation = 'vertical' | 'horizontal';

/** 迷いマークを付けるボタン。設定の「ボタンを登録」で、押したボタンやキーがそのまま入る（W-10）。 */
export type Trigger =
  | { kind: 'mouse_x1' }
  | { kind: 'mouse_x2' }
  | { kind: 'mouse_middle' }
  /**
   * `code` は DOM の `KeyboardEvent.code`（例: "F13"）。修飾キーは、付いているものだけが入る
   * （昔の設定ファイルには無いので、無いものは付いていない）。
   */
  | { kind: 'key'; code: string; ctrl?: boolean; alt?: boolean; shift?: boolean; win?: boolean };

export interface WidgetPosition {
  x: number;
  y: number;
}

export interface Settings {
  trigger: Trigger;
  orientation: Orientation;
  widget_position: WidgetPosition | null;
  sound: boolean;
  capture_keywords: string[];
  data_dir: string;
}

/** idle = 半荘がまだ始まっていない、recording = 記録中、error = 保存先を開けない。 */
export type Status = 'idle' | 'recording' | 'error';

/** 記録の現在の状態。ウィジェットの表示のもと。 */
export interface AppState {
  status: Status;
  session_id: string | null;
  mark_count: number;
  ratings: Rating[];
  next_hand: number;
  can_undo: boolean;
  error: string | null;
}

export type CaptureTarget = 'window' | 'screen';

/** 迷いマーク 1 件。`screenshot_path` は画像の絶対パス（画像が無いときは null）。 */
export interface MarkRecord {
  id: number;
  t_ms: number;
  screenshot: string | null;
  capture: CaptureTarget | null;
  capture_error: string | null;
  screenshot_path: string | null;
}

/** 評価 1 件。`hand` は何局目の評価か（1 から）。スクリーンショット（W-13）は、昔の記録には無い。 */
export interface RatingEntry {
  id: number;
  t_ms: number;
  rating: Rating;
  hand: number;
  screenshot?: string | null;
  capture?: CaptureTarget | null;
  capture_error?: string | null;
  /** 画像の絶対パス（画像が無いときは null）。 */
  screenshot_path?: string | null;
}

/** 記録のファイル（events.jsonl）の 1 行。 */
export type StoredEvent = { id: number; t_ms: number } & (
  | { type: 'session_start' }
  | { type: 'mark'; screenshot?: string; capture?: CaptureTarget; capture_error?: string }
  | { type: 'rating'; rating: Rating; screenshot?: string; capture?: CaptureTarget; capture_error?: string }
  | { type: 'undo'; target: number }
);

/** 半荘 1 つ分。取り消された記録は marks / ratings に含まれない。 */
export interface SessionRecord {
  id: string;
  started_ms: number;
  mark_count: number;
  rating_count: number;
  marks: MarkRecord[];
  ratings: RatingEntry[];
  events: StoredEvent[];
}

/** どのフックが入力を拾っているか。helper = 管理者の補助プログラム、in_process = 本体のフック、none = 拾う口が無い。 */
export type HookSource = 'helper' | 'in_process' | 'none';

/** 補助プログラムの設定・解除・起動のうち、いま進めているもの。 */
export type HelperOp = 'installing' | 'removing' | 'starting';

/** 管理者の補助プログラムの状態（W-9）。 */
export interface HelperStatus {
  /** 起動の登録（タスク）があるか。まだ確かめていなければ null。 */
  installed: boolean | null;
  /** 動いている（つながって、入力を拾っている）。 */
  running: boolean;
  busy: HelperOp | null;
  /** 直前の設定・解除・起動、またはフックの設定の失敗の理由。 */
  error: string | null;
}

/** ボタンの登録とテスト、補助プログラムの状態（設定ページに出す。W-9、W-10、W-11）。 */
export interface InputStatus {
  /** ボタンの登録の待機中か。 */
  registering: boolean;
  /** テストの欄に出す、最後に受け取った時刻（ミリ秒）。まだ受け取っていなければ null。 */
  probe_ms: number | null;
  hook: HookSource;
  helper: HelperStatus;
  /** 登録の開始・保存の失敗など、伝えたいこと。 */
  message: string | null;
}
