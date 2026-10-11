/**
 * Rust 側のコマンドとイベントの窓口。
 * 画面（webview）から通信やファイルには触れず、すべてこのコマンド越しに行う。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  AnswerNotes,
  AnswerRow,
  AppState,
  InputStatus,
  Links,
  MemoEntry,
  MjaiWindowEvent,
  OcrProgress,
  Orientation,
  PageKeyEvent,
  Rating,
  SelfRatingValue,
  SessionOcr,
  SessionRecord,
  Settings,
  NewAnswer,
  SolvedCount,
  StoredProblemRef,
  WeekRecord,
} from './types';

/** 記録の状態が変わったときのイベント名（Rust の `EVENT_STATE_CHANGED`）。 */
export const EVENT_STATE_CHANGED = 'state-changed';
/** 設定が変わったときのイベント名（Rust の `EVENT_SETTINGS_CHANGED`）。 */
export const EVENT_SETTINGS_CHANGED = 'settings-changed';
/** ボタンの登録・テスト・補助プログラムの状態が変わったときのイベント名（Rust の `EVENT_INPUT_STATUS`）。 */
export const EVENT_INPUT_STATUS = 'input-status-changed';
/** mjai の窓からの知らせのイベント名（Rust の `EVENT_MJAI`）。 */
export const EVENT_MJAI_WINDOW = 'mjai-window';
/** 文字認識の進み具合のイベント名（Rust の `EVENT_OCR_PROGRESS`）。 */
export const EVENT_OCR_PROGRESS = 'ocr-progress';
/** 検討画面が前面に来たときのイベント名（Rust の `EVENT_MAIN_FOCUSED`）。 */
export const EVENT_MAIN_FOCUSED = 'main-window-focused';

export const api = {
  getState: () => invoke<AppState>('get_state'),
  /** ウィジェットの「迷い」ボタン。割り当てたボタンと同じ記録をつくる。 */
  addMark: () => invoke<AppState>('add_mark'),
  addRating: (rating: Rating) => invoke<AppState>('add_rating', { rating }),
  undo: () => invoke<AppState>('undo'),
  newSession: () => invoke<AppState>('new_session'),
  getSettings: () => invoke<Settings>('get_settings'),
  setSettings: (settings: Settings) => invoke<Settings>('set_settings', { settings }),
  setOrientation: (orientation: Orientation) =>
    invoke<Settings>('set_orientation', { orientation }),
  openMainWindow: () => invoke<void>('open_main_window'),
  listSessions: () => invoke<SessionRecord[]>('list_sessions'),
  /**
   * 半荘を消す（U-9）。半荘のフォルダを保存先の trash へ移す（一瞬）。一覧には出なくなる。アプリを閉じるとき
   * （落ちたときは次の起動のとき）に、Windows のごみ箱へ送る。それまでは `restoreSessions` で戻せる。
   * ウィジェットが記録中の半荘も消せる（その半荘は閉じる）。
   */
  deleteSessions: (ids: string[]) => invoke<void>('delete_sessions', { ids }),
  /** 消した半荘を戻す（「元に戻す」・Ctrl+Z）。 */
  restoreSessions: (ids: string[]) => invoke<void>('restore_sessions', { ids }),
  getStartupNote: () => invoke<string | null>('get_startup_note'),
  showWidgetMenu: () => invoke<void>('show_widget_menu'),
  /**
   * 最初の絵を描き終えたことを知らせる（N-7）。窓は隠したまま作られ、これを受けた Rust 側が
   * 窓の背景色を `background`（いま描いている背景の色。CSS の色の文字列）にそろえてから見せる。
   */
  windowReady: (background: string) => invoke<void>('window_ready', { background }),
  /** 開発者ツールを開く。`tauri dev` のときだけ開く（N-12）。 */
  openDevtools: () => invoke<void>('open_devtools'),
  /** テーマが変わったときに、窓の背景色を画面の色にそろえさせる（N-7）。 */
  setWindowBackground: (background: string) =>
    invoke<void>('set_window_background', { background }),
  /** ボタンの登録・テスト・補助プログラムの、いまの状態。 */
  getInputStatus: () => invoke<InputStatus>('get_input_status'),
  /** 「ボタンを登録」。次に押された登録できる入力が、割り当てになる（W-10）。 */
  startRegistration: () => invoke<void>('start_registration'),
  /** 登録をやめる（キャンセルのボタン・Esc）。 */
  cancelRegistration: () => invoke<void>('cancel_registration'),
  /**
   * テストの欄を見せているか。見せている間（かつ窓が操作を受けている間）、割り当てたボタンを押しても
   * 記録せず、受け取ったことだけを知らせる（W-11）。
   */
  setProbeWanted: (wanted: boolean) => invoke<void>('set_probe_wanted', { wanted }),
  /**
   * 窓の中で拾ったキー入力を、本体に知らせる。検討画面が前面にある間は、本体のキーボードのフックを外しているので、
   * 登録の待機中は登録の候補に、テストの間は割り当てたキーの押下になる（W-10、W-11）。
   */
  reportPageKey: (key: PageKeyEvent) => invoke<void>('report_page_key', { key }),
  /** 「管理者の補助プログラムを設定する」。Windows の確認が出る（最初の 1 回だけ）。進み具合は状態で知らせる。 */
  setupHelper: () => invoke<void>('setup_helper'),
  /** 補助プログラムの設定を解除する。Windows の確認が出る。 */
  removeHelper: () => invoke<void>('remove_helper'),
  /** 設定済みの補助プログラムを起動する。確認は出ない。 */
  startHelper: () => invoke<void>('start_helper'),

  // ---- 取り込み（F1・F9・F11）。通信・ファイル・文字認識は、すべて Rust 側が行う ----
  /** クリップボードの文字（文字だけ）。文字が無ければ null。牌譜リンクは、画面側（エンジンの `detectPaipuLink`）が探す。 */
  readClipboardText: () => invoke<string | null>('read_clipboard_text'),
  /**
   * mjai の窓を開いて、URL 欄に牌譜リンクを入れる。Submit はユーザーが押す。
   * `background` は、いま描いている背景の色（窓の背景色をそろえる）。
   * `target` は、取り込み先の半荘の呼び名（例: 10月9日 19:09。その半荘のページから取り込むとき。窓の題名に出す。U-14）。
   */
  openMjaiWindow: (link: string, background: string, target?: string) =>
    invoke<void>('open_mjai_window', { link, background, target }),
  /** mjai の窓を閉じる（開いていなければ何もしない）。 */
  closeMjaiWindow: () => invoke<void>('close_mjai_window'),
  /** 貼り付けた文字から、mjai の結果の ID を探す。見つからなければ null。 */
  reportIdFromText: (text: string) => invoke<string | null>('report_id_from_text', { text }),
  /** 結果の JSON を mjai のサイトから取る（アプリが外へ出す通信は、これだけ）。 */
  fetchReport: (id: string) => invoke<string>('fetch_report', { id }),
  /** 結果の JSON ファイルを読む（ファイルを開くダイアログで選んだパス）。 */
  readReportFileText: (path: string) => invoke<string>('read_report_file_text', { path }),
  /** 半荘の迷いマーク・評価の画像を文字認識にかけて、結果の写しを返す（読んだ分は半荘のフォルダに残る）。 */
  ocrSessions: (sessionIds: string[]) =>
    invoke<SessionOcr[]>('ocr_sessions', { sessionIds }),
  /**
   * 半荘の読み取りの写し（`ocr.json`）が、前の作り方で読んだものか（読み直しが要るか。F11、E-27）。
   * 写しの決まりの名前が、いまの作り方と違う（または名前が無い）ときだけ true。写しが無いときは false。
   */
  needsOcrReread: (sessionId: string) => invoke<boolean>('needs_ocr_reread', { sessionId }),
  /**
   * 前の作り方で読んだ半荘の保存済みのスクショを、いまの作り方で読み直して、新しい写しを書く（取り込みの一部。F11、E-27）。
   * 書き換わるのは `ocr.json` だけで、結びつけ（`links.json`）・評価・MAKA・結果には触らない。書き直したら true、
   * 読み直しが要らなかったら false。失敗したら、前の写しを残して、理由を投げる。
   */
  rereadOcr: (sessionId: string) => invoke<boolean>('reread_ocr', { sessionId }),
  /** 取り込んだ結果を保存する。`sessionId` が null なら、記録の無い半荘として新しく作る。半荘の名前を返す。 */
  saveReport: (sessionId: string | null, text: string) =>
    invoke<string>('save_report', { sessionId, text }),
  /** 取り込んだ結果の生の JSON。まだ取り込んでいなければ null。 */
  readReport: (sessionId: string) => invoke<string | null>('read_report', { sessionId }),
  /** 迷いマークを、判断の鍵（または "manual"）に結びつける。選び直しにも使う。 */
  setMarkLink: (sessionId: string, markId: number, decision: string) =>
    invoke<void>('set_mark_link', { sessionId, markId, decision }),
  clearMarkLink: (sessionId: string, markId: number) =>
    invoke<void>('clear_mark_link', { sessionId, markId }),
  /** 評価を、局の鍵に結びつける（空の文字列は「どの局にも結びつけない」）。 */
  setRatingLink: (sessionId: string, ratingId: number, kyoku: string) =>
    invoke<void>('set_rating_link', { sessionId, ratingId, kyoku }),
  clearRatingLink: (sessionId: string, ratingId: number) =>
    invoke<void>('clear_rating_link', { sessionId, ratingId }),
  /** 結びつけをまるごと置き換える（取り込みのときに、自動で決めた結びつけを一度に書く）。 */
  replaceLinks: (sessionId: string, links: Links) =>
    invoke<void>('replace_links', { sessionId, links }),
  /**
   * 評価の結びつけだけをまるごと置き換える（`version` は当てはめ方の版）。前の当てはめ方で当てはめた評価を、半荘の画面を開いたときに
   * 当てはめ直す（E-31）。迷いの結びつけと、局の自己評価・MAKA の評価は変えない。
   */
  replaceRatingLinks: (sessionId: string, ratings: Record<string, string>, version: number) =>
    invoke<void>('replace_rating_links', { sessionId, ratings, version }),

  // ---- 局の評価の表（F10）。ウィジェットの記録（events.jsonl）は書き換えず、別のファイルに保存する ----
  /** 局の自己評価を上書きする（`kyoku` は局の鍵。`none` は「評価なし」）。付け直しにも使う。 */
  setSelfRating: (sessionId: string, kyoku: string, rating: SelfRatingValue) =>
    invoke<void>('set_self_rating', { sessionId, kyoku, rating }),
  /** 局の自己評価の上書きを消す（ウィジェットで付けた評価に戻す。取り消しに使う）。 */
  clearSelfRating: (sessionId: string, kyoku: string) =>
    invoke<void>('clear_self_rating', { sessionId, kyoku }),
  /** 局の MAKA の評価を入れる（S+ から E の 14 段階）。 */
  setMakaGrade: (sessionId: string, kyoku: string, grade: string) =>
    invoke<void>('set_maka_grade', { sessionId, kyoku, grade }),
  /** 局の MAKA の評価を消す。 */
  clearMakaGrade: (sessionId: string, kyoku: string) =>
    invoke<void>('clear_maka_grade', { sessionId, kyoku }),
  /** 半荘全体の MAKA の評価を入れる。 */
  setMakaHanchan: (sessionId: string, grade: string) =>
    invoke<void>('set_maka_hanchan', { sessionId, grade }),
  /** 半荘全体の MAKA の評価を消す。 */
  clearMakaHanchan: (sessionId: string) => invoke<void>('clear_maka_hanchan', { sessionId }),

  // ---- 終局直後のメモ（F4、U-28）。ウィジェットの記録は書き換えず、半荘のフォルダの memos.json に保存する ----
  /** 迷いマークのメモを書く（置き換える）。「候補」も「理由」も空なら、メモを消す。 */
  setMemo: (sessionId: string, markId: number, memo: MemoEntry) =>
    invoke<void>('set_memo', { sessionId, markId, candidates: memo.candidates, reason: memo.reason }),
  /** 迷いマークのメモを消す（取り消しに使う）。 */
  clearMemo: (sessionId: string, markId: number) => invoke<void>('clear_memo', { sessionId, markId }),
  /** 迷いマークの無い迷いのメモを書く（同じ名前があれば置き換え、無ければ足す）。`decision` は判断の鍵。 */
  setExtraMemo: (sessionId: string, id: string, decision: string, memo: MemoEntry) =>
    invoke<void>('set_extra_memo', { sessionId, id, decision, candidates: memo.candidates, reason: memo.reason }),
  /** 迷いマークの無い迷いのメモを消す（取り消しに使う）。 */
  clearExtraMemo: (sessionId: string, id: string) => invoke<void>('clear_extra_memo', { sessionId, id }),

  // ---- 答え・解き直しの予定・今日の出題（D-3。保存先の study.sqlite。検討画面だけが呼ぶ） ----
  /** 答えを記録する（答え合わせを押したとき）。番号を付けた行を返す。 */
  recordAnswer: (answer: NewAnswer) => invoke<AnswerRow>('record_answer', { answer }),
  /** 答え合わせのあとに、差の原因・学んだ原則・MAKA の打牌を置き換える（取り消しは、前の値で置き換える）。 */
  updateAnswerNotes: (id: number, notes: AnswerNotes) =>
    invoke<AnswerRow>('update_answer_notes', { id, notes }),
  /** すべての答え（答えた順）。 */
  listAnswers: () => invoke<AnswerRow[]>('list_answers'),
  /** 日付（YYYY-MM-DD）の今日の出題の組。まだ作っていなければ null。 */
  getDailySet: (date: string) => invoke<StoredProblemRef[] | null>('get_daily_set', { date }),
  /** その日の今日の出題の組を作る。その日の組がすでにあれば、入れ替えずに、あるものを返す（E-24）。 */
  saveDailySet: (date: string, items: StoredProblemRef[]) =>
    invoke<StoredProblemRef[]>('save_daily_set', { date, items }),
  /** 半荘ごとの、答えた問題の数（半荘を消す確認の「解いた問題 N問」に使う）。 */
  countSolved: (sessionIds: string[]) => invoke<SolvedCount[]>('count_solved', { sessionIds }),

  // ---- 週の集計の、手で入れる数（U-30。保存先の study.sqlite。検討画面だけが呼ぶ） ----
  /** すべての週の、手で入れた成績と来週の重点（週の古い順）。 */
  listWeeks: () => invoke<WeekRecord[]>('list_weeks'),
  /**
   * 1 週ぶんの成績と重点を置き換える（値は Rust 側で確かめる。重点は行の前後の空白と空の行を除いて保存する）。
   * 保存した記録を返す。成績も重点も空にしたときは、記録を消して null。
   */
  setWeek: (record: WeekRecord) => invoke<WeekRecord | null>('set_week', { record }),
};

export function onStateChanged(handler: (state: AppState) => void): Promise<UnlistenFn> {
  return listen<AppState>(EVENT_STATE_CHANGED, (event) => handler(event.payload));
}

export function onSettingsChanged(handler: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(EVENT_SETTINGS_CHANGED, (event) => handler(event.payload));
}

export function onInputStatus(handler: (status: InputStatus) => void): Promise<UnlistenFn> {
  return listen<InputStatus>(EVENT_INPUT_STATUS, (event) => handler(event.payload));
}

export function onMjaiWindow(handler: (event: MjaiWindowEvent) => void): Promise<UnlistenFn> {
  return listen<MjaiWindowEvent>(EVENT_MJAI_WINDOW, (event) => handler(event.payload));
}

export function onOcrProgress(handler: (progress: OcrProgress) => void): Promise<UnlistenFn> {
  return listen<OcrProgress>(EVENT_OCR_PROGRESS, (event) => handler(event.payload));
}

/** 検討画面が前面に来たとき（クリップボードの牌譜リンクを探し直す合図）。 */
export function onMainWindowFocused(handler: () => void): Promise<UnlistenFn> {
  return listen<null>(EVENT_MAIN_FOCUSED, () => handler());
}

/** コマンドが返したエラー（Rust の String）を、画面に出す文にする。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
