/**
 * 読み（F23）のコマンドに答える Tauri の偽物（試験の道具）。`installTauriMock({ handlers })` に `handlers` を渡す。
 * 保存してある読み（`read_reads`）・読みのモデルの状態（`get_reads_model`）・計算（`compute_reads`。試験が終わらせる）・
 * 入切の保存（`set_reads_visible`。次に設定を読むときも、保存した値を返す）に答える。
 * 試験のデータで、画面の部品ではない。
 */
import type { Reads, ReadsModelStatus } from '../src/api/reads';
import type { Settings } from '../src/api/types';
import { fx4Reads } from './reads-fixtures';
import { baseSettings } from './tauri-mock';

export interface ReadsBackendOptions {
  /** 設定の `reads_visible` の最初の値。`undefined` なら、設定にこの項目が無い（古い設定。切として扱う）。 */
  visible?: boolean;
  /** 保存してある読み（`read_reads` の答え）。無ければ null。 */
  stored?: Reads | null;
  /** 読みのモデルが入っているか（既定は入っている）。 */
  installed?: boolean;
  /** 設定の他の項目（キーの割り当てなど）。 */
  settings?: Partial<Settings>;
}

export function modelStatus(installed: boolean): ReadsModelStatus {
  return {
    installed,
    bytes: installed ? 4_013_332 : null,
    sha256: installed ? '50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea' : null,
    downloading: false,
    repo: 'hhim8826/mortal3-b40c192',
    revision: '7784a9d',
    file: 'tenpai.onnx',
    license: 'AGPL-3.0',
    origin: '天鳳の鳳凰卓',
  };
}

export function readsBackend(options: ReadsBackendOptions = {}) {
  const state = {
    visible: options.visible,
    stored: options.stored ?? null,
    installed: options.installed ?? true,
    computeCalls: 0,
    computed: null as Reads | null,
    release: null as ((reads?: Reads) => void) | null,
    fail: null as ((reason: string) => void) | null,
  };
  const settings = (): Settings => {
    const value: Settings = { ...baseSettings, ...options.settings };
    if (state.visible !== undefined) value.reads_visible = state.visible;
    return value;
  };
  const handlers: Record<string, (args: unknown) => unknown> = {
    get_settings: () => settings(),
    set_reads_visible: (args) => {
      state.visible = (args as { visible: boolean }).visible;
      return settings();
    },
    read_reads: () => {
      const reads = state.computed ?? state.stored;
      return reads === null ? null : JSON.stringify(reads);
    },
    get_reads_model: () => modelStatus(state.installed),
    compute_reads: () =>
      new Promise<string>((resolve, reject) => {
        state.computeCalls += 1;
        state.release = (reads = fx4Reads()) => {
          state.computed = reads;
          resolve(JSON.stringify(reads));
        };
        state.fail = (reason) => reject(reason);
      }),
  };
  return { state, handlers };
}
