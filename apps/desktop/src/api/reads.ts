/**
 * 読み（F23）と解析のモデル（F24）の、Rust 側のコマンドの窓口と、やり取りするデータの型。
 * 画面（webview）から通信やエンジンには触れず、すべてこのコマンド越しに行う。呼べるのは検討画面だけ（ウィジェットは呼ばない）。
 * 型のフィールド名は Rust 側の JSON（snake_case）と、解析エンジンの `reads.json`（`jantama-reads/1`。
 * `src-tauri/engine/README.md`）に合わせている。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { Settings } from './types';

/** 読みのモデル（`tenpai.onnx`）を取っている間の進み具合。`total` は、配布先が大きさを告げないときは null。 */
export const EVENT_READS_MODEL_PROGRESS = 'reads-model-progress';
/** 半荘の読みを計算している間の進み具合（場面の数で数える）。 */
export const EVENT_READS_PROGRESS = 'reads-progress';

/** 読みのモデルの状態と、出どころ。決まった版（コミットと sha256）だけを使う。 */
export interface ReadsModelStatus {
  /** 設定のフォルダの `models/` に、決まった版のファイルが入っているか（sha256 まで確かめる）。 */
  installed: boolean;
  /** 入っているファイルの大きさ（バイト）。入っていなければ null。 */
  bytes: number | null;
  /** 入っているファイルの sha256。入っていなければ null。 */
  sha256: string | null;
  /** Hugging Face から取っている最中か。 */
  downloading: boolean;
  /** 出どころ（例 `hhim8826/mortal3-b40c192`）・コミット・ファイル名・ライセンス・学習のデータの説明。 */
  repo: string;
  revision: string;
  file: string;
  license: string;
  origin: string;
}

export interface ReadsModelProgress {
  done: number;
  total: number | null;
}

export interface ReadsProgress {
  session_id: string;
  done: number;
  total: number;
}

/** `reads.json`（`jantama-reads/1`）。自分の手番の場面ごとの、他家 3 人の読み。 */
export interface Reads {
  format: 'jantama-reads/1';
  model: { file: string; sha256: string };
  player_id: number;
  moments: ReadsMoment[];
}

/** 1 つの場面（自分のツモの直後か、自分のチー・ポンの直後）。`event_index` は `report.json` の `mjai_log` の添字。 */
export interface ReadsMoment {
  event_index: number;
  /** 何局目か（0 から。`review.kyokus` の添字と同じ順）。 */
  kyoku_index: number;
  bakaze: string;
  /** mjai の局（1 から）。 */
  kyoku: number;
  honba: number;
  /** この局での自分のツモの回数（1 から）。 */
  junme: number;
  /** 自分の手牌の牌の種類（重なりなし、34 種の順。赤牌は元の種類）。 */
  hand: string[];
  /** 34 種の牌ごとの、だれか（3 人のどれか）がその牌を待っている確率。 */
  any_wait: number[];
  /** 他家 3 人。`step` 1・2・3 が下家・対面・上家。 */
  opponents: OpponentReads[];
}

export interface OpponentReads {
  /** 席（0〜3、絶対）。 */
  seat: number;
  step: 1 | 2 | 3;
  riichi: boolean;
  /** 聴牌の確率。 */
  tenpai: number;
  furiten: number;
  /** 34 種の牌ごとの、この人がその牌を待っている確率。 */
  waits: number[];
  /** 待っている確率の高い順の 5 牌。 */
  top_waits: { tile: string; p: number }[];
  /** 牌譜の全員の手牌から数えた、実際の待ち（聴牌でなければ空）。 */
  actual_waits: string[];
  /** 効いた捨て牌（手牌の牌 → 2 つまで）。読み直した他家（リーチか聴牌の確率 50% 以上）だけ。 */
  reasons: Record<string, ReadsReason[]>;
}

/** 「この捨て牌が無ければ、この牌の確率は `without` だった」。`turn` は、その人のこの局の何枚目の捨て牌か（1 から）。 */
export interface ReadsReason {
  turn: number;
  event_index: number;
  pai: string;
  without: number;
}

export const readsApi = {
  /** 読みのモデルの状態。通信しない（設定の「解析のモデル」の欄と、「読み」を入にしたときに読む）。 */
  getModel: () => invoke<ReadsModelStatus>('get_reads_model'),
  /** 決まった版を Hugging Face から取る（押したときだけ）。sha256 が合わなければ捨てて、理由を投げる。 */
  downloadModel: () => invoke<ReadsModelStatus>('download_reads_model'),
  /** 取っている途中なら止める（途中のファイルは消す）。 */
  cancelModelDownload: () => invoke<void>('cancel_reads_model_download'),
  /** 自分で落としたファイルを使う。決まった版（sha256）でなければ、理由を投げる。 */
  chooseModelFile: (path: string) => invoke<ReadsModelStatus>('choose_reads_model_file', { path }),
  /** 入っているモデルを消す。 */
  deleteModel: () => invoke<ReadsModelStatus>('delete_reads_model'),
  /** 半荘の `reads.json`。まだ無い・形が違う・今のモデルで計算したものでないときは null（計算し直す）。 */
  readReads: async (sessionId: string): Promise<Reads | null> => {
    const text = await invoke<string | null>('read_reads', { sessionId });
    return text === null || text === undefined ? null : (JSON.parse(text) as Reads);
  },
  /** 半荘の読みを、解析エンジンで計算して `reads.json` に置き、返す。失敗は、理由を投げる。 */
  computeReads: async (sessionId: string): Promise<Reads> =>
    JSON.parse(await invoke<string>('compute_reads', { sessionId })) as Reads,
  /** 「読み」の入切を覚える（この端末だけ。同期・書き出しに入れない）。変わった設定を返す。 */
  setReadsVisible: (visible: boolean) => invoke<Settings>('set_reads_visible', { visible }),
};

export function onReadsModelProgress(handler: (progress: ReadsModelProgress) => void): Promise<UnlistenFn> {
  return listen<ReadsModelProgress>(EVENT_READS_MODEL_PROGRESS, (event) => handler(event.payload));
}

export function onReadsProgress(handler: (progress: ReadsProgress) => void): Promise<UnlistenFn> {
  return listen<ReadsProgress>(EVENT_READS_PROGRESS, (event) => handler(event.payload));
}
