/**
 * Rust 側（src-tauri）とやり取りするデータの型。
 * フィールド名は Rust 側の JSON（snake_case）に合わせている。手で同期する（自動生成はしない）。
 */

/** 局の評価。〇 = good、△ = fair、✕ = bad。 */
export type Rating = 'good' | 'fair' | 'bad';

export type Orientation = 'vertical' | 'horizontal';

/** 迷いマークを付けるボタン。 */
export type Trigger =
  | { kind: 'mouse_x1' }
  | { kind: 'mouse_x2' }
  | { kind: 'mouse_middle' }
  /** `code` は DOM の `KeyboardEvent.code`（例: "F8"）。 */
  | { kind: 'key'; code: string };

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

/** 評価 1 件。`hand` は何局目の評価か（1 から）。 */
export interface RatingEntry {
  id: number;
  t_ms: number;
  rating: Rating;
  hand: number;
}

/** 記録のファイル（events.jsonl）の 1 行。 */
export type StoredEvent = { id: number; t_ms: number } & (
  | { type: 'session_start' }
  | { type: 'mark'; screenshot?: string; capture?: CaptureTarget; capture_error?: string }
  | { type: 'rating'; rating: Rating }
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
