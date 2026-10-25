/**
 * Rust 側（src-tauri）とやり取りするデータの型。
 * フィールド名は Rust 側の JSON（snake_case）に合わせている。手で同期する（自動生成はしない）。
 */
import type { QuizChoice } from '@jantama/engine';

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

/**
 * 半荘を通して見る画面のキーの割り当て（操作の名前 → キー。割り当て無しは null）。キーは、`KeyboardEvent.code` に、押していた
 * 修飾キーを `Ctrl+` `Alt+` `Shift+` の順に付けた文字（例: `Shift+ArrowUp`・`Comma`）。操作の一覧と既定は `main/replay/keys.ts`。
 */
export type ReplayKeys = Record<string, string | null>;

export interface Settings {
  trigger: Trigger;
  orientation: Orientation;
  widget_position: WidgetPosition | null;
  sound: boolean;
  /**
   * 迷いだけを記録する（既定は入。F0、W-15）。入のとき、ウィジェットは形（`orientation`）によらず 48px 角の「迷い」ボタン 1 つになり、
   * 〇△✕（局の自己評価）と終局直後メモの画面の部品を出さない。記録は消さず、切れば元どおり出る。
   */
  doubt_only: boolean;
  capture_keywords: string[];
  data_dir: string;
  /** 1 日に出す問題の数（今日の出題。1〜50。既定 5）。 */
  daily_count: number;
  /** ドラ表示牌が指す牌の面を黄色にする（既定は切。U-19）。 */
  highlight_dora: boolean;
  /** 半荘を通して見る画面で、AI の1位と違う判断も悪手の段の飛び先に入れる（既定は切。出題は変えない。R10-4、E-26）。 */
  show_all_mismatches: boolean;
  /** 半荘を通して見る画面のキーの割り当て（R10-3、U-21）。 */
  replay_keys: ReplayKeys;
  /**
   * `replay_keys` の表の版（設定ファイルの側が書く。画面は、受け取ったものをそのまま返すだけで、触らない。R11-4）。
   * 試験の設定の見本には無くてよい。
   */
  replay_keys_revision?: number;
}

/** idle =半荘がまだ始まっていない、recording = 記録中、error = 保存先を開けない。 */
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
  /** 「新しい半荘」で閉じた（W-14）。 */
  | { type: 'session_close' }
);

/** 読み直し 1 回分（E-20）。`variant` は、どの画像で読み直したか（コントラストを上げた画像 `contrast1.8`、1.5 倍に広げた画像 `upscale1.5`）。 */
export interface OcrRetry {
  variant: string;
  lines: string[];
}

/**
 * 画像 1 枚の文字認識の結果（行ごとの文字）。読めなかったときは、理由が `error` に入る。
 * `retries` は、同じ画像をコントラストを上げたり広げたりして読み直した結果（順に試す。1 回目の `lines` で読めないときに使う。E-20）。
 */
export interface OcrEntry {
  lines: string[];
  retries?: OcrRetry[];
  error?: string | null;
}

/**
 * 半荘の画像の文字認識の結果の写し（`ocr.json`）。画像の、半荘のフォルダからの相対パス（`MarkRecord.screenshot`・
 * `RatingEntry.screenshot`）ごとに持つ。計算は取り込みのときだけ（SPEC 2章）。
 */
export interface OcrCache {
  /** 切り出しと拡大の決まりの名前。決まりが変わったら、写しは使わずに読み直す。 */
  geometry: string;
  entries: Record<string, OcrEntry>;
}

/**
 * 迷いマーク・評価の結びつけ（`links.json`）。無い項目は「まだ決めていない」。
 * - `marks`: 迷いマークの id（10 進の文字列）→ 結びつけた判断の鍵（エンジンの `DecisionRef.key`）か `"manual"`（局面を手で選ぶ）
 * - `ratings`: 評価の id → 結びつけた局の鍵（`kyokuKey`）。空の文字列は「どの局にも結びつけない」
 * - `ratings_version`: `ratings` を当てはめたときの、当てはめ方の版（エンジンの `RATING_LINK_VERSION`）。無いか、いまの版より小さいときは、
 *   半荘の画面を開いたとき、1 回だけ当てはめ直す（E-31）
 */
export interface Links {
  marks: Record<string, string>;
  ratings: Record<string, string>;
  ratings_version?: number;
}

/**
 * 局の自己評価の上書きの値（`self-ratings.json`）。`none` は「評価なし」: ウィジェットで付けた評価があっても、
 * この局には付けていないものとして見せる。
 */
export type SelfRatingValue = Rating | 'none';

/**
 * 局の自己評価の上書き（`self-ratings.json`）。`kyokus` は局の鍵（`kyokuKey`。`k<局の通し番号>h<本場>`）→ 値。
 * ここに無い局は、ウィジェットで付けた評価（記録と結びつけから決まる）のまま。ウィジェットの記録そのものは書き換えない。
 */
export interface SelfRatings {
  kyokus: Record<string, SelfRatingValue>;
}

/**
 * MAKA の評価（`maka.json`。任意の入力）。段階の名前は S+ から E の 14 段階（エンジンの `Grade`）。
 * `kyokus` は局の鍵 → 段階、`hanchan` は半荘全体の段階（無ければ出てこない）。
 */
export interface MakaGrades {
  kyokus: Record<string, string>;
  hanchan?: string;
}

/**
 * メモ 1 つの文（`memos.json`）。`candidates` は「候補」（短い文。例: `3m・6p`）、`reason` は「理由（1行）」。
 * 保存するときに前後の空白を除く（空のメモは持たない）。
 */
export interface MemoEntry {
  candidates: string;
  reason: string;
}

/**
 * 迷いマークの無い迷いの位置（局・本場・巡目）。結果を取り込む前の半荘では、判断の一覧が無いので、手で選んだ位置で持つ。
 * `kyoku` は局の通し番号（エンジンの `DecisionRef.kyoku` と同じ。東1局が 0、南4局が 7、西1局が 8。0〜15）、
 * `honba` は本場（0〜99）、`junme` は巡目（1〜30）。範囲は Rust 側が確かめる。
 */
export interface MemoPosition {
  kyoku: number;
  honba: number;
  junme: number;
}

/**
 * 迷いマークの無い迷いのメモ。局面は、次のどちらか、または両方で持つ:
 * - `position`: 手で選んだ局・本場・巡目（結果を取り込む前に足したもの）
 * - `decision`: 判断の鍵（エンジンの `DecisionRef.key`。取り込んだあとに、判断を選んだ・位置から自動で結びつけたもの。
 *   結びつけたあとも `position` は残す）
 * 判断の鍵だけを持つ古いファイルも読める。`id` は画面が付ける名前（英数字）。
 */
export interface ExtraMemo extends MemoEntry {
  id: string;
  decision?: string;
  position?: MemoPosition;
}

/** 迷いマークの無い迷いのメモを保存するときの局面（`ExtraMemo` の `decision`・`position`。どちらか、または両方）。 */
export interface ExtraMemoPlace {
  decision?: string;
  position?: MemoPosition;
}

/**
 * 終局直後のメモ（`memos.json`。F4、U-28）。
 * - `marks`: 迷いマークの id（10 進の文字列）→ メモ
 * - `extras`: 迷いマークの無い迷いのメモ（足した順。局面は `ExtraMemo` を見る）
 */
export interface Memos {
  marks: Record<string, MemoEntry>;
  extras: ExtraMemo[];
}

/**
 * 解決した局面（`resolved.json`。F16）。`decisions` は判断の鍵（エンジンの `DecisionRef.key`。例: k1h1e7）→ 解決を入れた時刻（ミリ秒）。
 * 解決を切ると鍵ごと消える（空ならファイルも無く、ここは空の表）。
 */
export interface ResolvedDecisions {
  decisions: Record<string, number>;
}

/**
 * 半荘 1 つ分。取り消された記録は marks / ratings に含まれない。
 * 結果だけの半荘（記録の無いまま取り込んだもの）は、marks・ratings が空で、`report_path` がある。
 */
export interface SessionRecord {
  id: string;
  started_ms: number;
  mark_count: number;
  rating_count: number;
  marks: MarkRecord[];
  ratings: RatingEntry[];
  events: StoredEvent[];
  /** 取り込んだ結果（`report.json`）の絶対パス。まだ取り込んでいなければ null。 */
  report_path: string | null;
  /** 画像の文字認識の結果の写し。まだ読んでいない（または読めない）ときは null。 */
  ocr: OcrCache | null;
  /** 迷いマーク・評価の結びつけ。 */
  links: Links;
  /** 局の自己評価の上書き（局の評価の表で付け直したもの）。 */
  self_ratings: SelfRatings;
  /** MAKA の評価（局の評価の表で入れたもの）。 */
  maka: MakaGrades;
  /** 終局直後のメモ（迷いのカードと、半荘を通して見る画面で書いたもの）。 */
  memos: Memos;
  /** 解決した局面（出題・解き直し・通して見る画面で「解決」を入れたもの。F16）。 */
  resolved: ResolvedDecisions;
}

/** 文字認識の結果の写しを、半荘ごとに返したもの（`ocr_sessions` の返り値）。 */
export interface SessionOcr {
  session_id: string;
  ocr: OcrCache;
}

/** 文字認識の進み具合（`ocr-progress` のイベント）。 */
export interface OcrProgress {
  done: number;
  total: number;
}

/**
 * mjai の窓からの知らせ（`mjai-window` のイベント）。
 * - report_found: 結果のページへ移ろうとした（移動は止めて、窓は閉じた）。`id` が結果の ID
 * - closed: 結果が出る前に、窓が閉じられた
 */
export type MjaiWindowEvent = { kind: 'report_found'; id: string } | { kind: 'closed' };

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

/**
 * 設定ページが拾ったキー入力（`KeyboardEvent` の `code` と、そのとき押していた修飾キー）。
 * 検討画面が前面にある間、本体のキーボードのフックには入力が届かないので、画面から本体へ知らせる（W-10、W-11）。
 */
export interface PageKeyEvent {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
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

// ---- 答え・解き直しの予定・今日の出題（D-3。保存先の study.sqlite。検討画面だけが使う） ----

/** 答えの種類。出題（今日の出題）か、解き直しか。 */
export type AnswerMode = 'quiz' | 'review';

/**
 * 答え合わせをするときに記録する答え（Rust の `NewAnswer`）。
 * `choice` は、選んだ答え（エンジンの `QuizChoice`。打牌なら `{ type: 'dahai', tile }`、ボタンなら `{ type: 'option', id }`）。
 * 日付（`due_date`）は、エンジンの `studyDate`（午前 4 時までを前の日として数える）と `scheduleReview` が決めた値をそのまま渡す。
 */
export interface NewAnswer {
  /** 半荘の名前（フォルダの名前）。 */
  session_id: string;
  /** 判断の鍵（エンジンの `decisionKey`。例: k2h1e14）。 */
  decision_key: string;
  mode: AnswerMode;
  /** 問題を見せた時刻（ミリ秒）。 */
  shown_at: number;
  /** 答え合わせを押した時刻（ミリ秒）。 */
  answered_at: number;
  choice: QuizChoice;
  /** 理由（1 行。必須）。 */
  reason: string;
  /** 答えるまでの時間（ミリ秒）。 */
  duration_ms: number;
  /** 選び直した回数（R8-6）。 */
  reselect_count: number;
  /** 正解か（AI がその行動に付けた確率が基準以上）。 */
  correct: boolean;
  /** 差の原因（エンジンの `CAUSE_CHOICES` の `id` のいくつか）。答え合わせのあとに付ける。 */
  causes?: string[];
  /** 学んだ原則（1 行）。 */
  principle?: string;
  /** MAKA が推した打牌（任意）。 */
  maka_move?: string | null;
  /** この答えのあとの、次の解き直しまでの間隔（日）。 */
  interval_days: number;
  /** 次に解き直す日（YYYY-MM-DD）。 */
  due_date: string;
}

/** 記録した答え（番号が付いたもの）。 */
export interface AnswerRow extends NewAnswer {
  id: number;
  causes: string[];
  principle: string;
  maka_move: string | null;
}

/** 答え合わせのあとに直す欄。3 つとも、いまの値をそのまま渡す（取り消しも、前の値で置き換える）。 */
export interface AnswerNotes {
  causes: string[];
  principle: string;
  maka_move: string | null;
}

/** 問題 1 つ（半荘の名前と判断の鍵）。今日の出題の組の要素。 */
export interface StoredProblemRef {
  session_id: string;
  decision_key: string;
}

/** 半荘ごとの、答えた問題の数。 */
export interface SolvedCount {
  session_id: string;
  solved: number;
}

// ---- 週ごとの成績と来週の重点（U-30、R11-12。保存先の study.sqlite の weeks 表。書き出しの「週の数」はこの形） ----

/**
 * 週の成績（手で入れる数。雀魂の成績の画面から）。入れていない項目は、無い（Rust の `WeekStats`）。
 * 率は %（0 から 100）、平均順位は 1 から 4。
 */
export interface WeekStats {
  /** 4位率（%）。 */
  rank4?: number;
  /** 放銃率（%）。 */
  deal?: number;
  /** 平均順位（1 から 4）。 */
  avg?: number;
  /** 和了率（%）。 */
  win?: number;
  /** 副露率（%）。 */
  call?: number;
  /** 立直率（%）。 */
  riichi?: number;
}

/** 1 週ぶんの、手で入れた成績と来週の重点（Rust の `WeekRecord`）。 */
export interface WeekRecord {
  /** 週の月曜の日付（YYYY-MM-DD）。 */
  week: string;
  stats: WeekStats;
  /** 来週の重点（1 から 3 行。空なら書いていない）。 */
  focus: string;
}

/** 書き出すとしたら何がどれだけ入るか（Rust の `RecordsOverview`。設定の「記録の書き出し」の大きさに使う）。 */
export interface RecordsOverview {
  /** 半荘の数（消した半荘は数えない）。 */
  sessions: number;
  answers: number;
  /** 書き出したときのファイルの大きさ（バイト）。 */
  bytes: number;
}

/** 書き出したファイルの報告（Rust の `ExportReport`）。 */
export interface RecordsExported {
  path: string;
  sessions: number;
  answers: number;
  bytes: number;
}

/**
 * 記録のファイルの中身の数（Rust の `ImportPreview`。確かめただけの結果と、読み込んだ結果の報告で同じ形）。
 * `held` は、ファイルの半荘のうち、この保存先に半荘のフォルダが無いものの数（その記録は、フォルダが現れるまで取っておく）。
 */
export interface RecordsPreview {
  sessions: number;
  answers: number;
  held: number;
}

/** 同期の状態（Rust の `SyncState`）。 */
export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'attention' | 'error';

/**
 * 設定の「同期」の欄に出す、同期の状態（Rust の `SyncStatus`。F15）。
 * トークンは含まない（OS の資格情報の保管庫にだけある。ここには、入っているかどうかだけ）。
 */
export interface SyncStatus {
  /** この端末で、同期を使っているか。 */
  enabled: boolean;
  /** 同期先のホスト名（未設定なら空）。 */
  url_host: string;
  /** トークンが、この PC の資格情報の保管庫に入っているか。 */
  has_token: boolean;
  state: SyncState;
  /** 最後に同期が成功した時刻（ミリ秒）。 */
  last_ok_ms: number | null;
  /** 状態の説明（失敗・つながらない・要確認のとき）。 */
  message: string | null;
  /** 注意（入れられなかった記録など）。 */
  warnings: string[];
  /** 大量の消去を止めているとき true（「削除をそのまま同期する」を出す）。 */
  can_allow_mass_delete: boolean;
  /** この端末の名前（読み物）。 */
  device_id: string;
}

// ---- OS ごとの違い（macOS 対応の段階 2。Rust の `platform::PlatformInfo`） ----

/** 動いている OS の名前。 */
export type Os = 'windows' | 'macos';

/**
 * この OS で使える機能。`false` の機能の行は、画面に出さない（または「まだ使えません」と書く）。
 * macOS の段階 2 は、検討画面だけ（どれも false）。
 */
export interface PlatformFeatures {
  /** ウィジェットの窓と、タスクトレイのアイコン。 */
  widget: boolean;
  /** 迷いマークのボタン（マウスの横ボタン・キー）を拾うこと。 */
  button_hook: boolean;
  /** ボタンを押した瞬間の、画面の撮影。 */
  capture: boolean;
  /** 取り込みのときの文字認識。 */
  ocr: boolean;
  /** 管理者の補助プログラム（Windows だけ）。 */
  helper: boolean;
}

/** 動いている OS の名前と、使える機能（起動のとき 1 回、`get_platform_info` で受け取る）。 */
export interface PlatformInfo {
  os: Os;
  features: PlatformFeatures;
}
