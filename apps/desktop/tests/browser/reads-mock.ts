/**
 * 読み（F23）のコマンドに答える、ページの中の偽物（試験の道具）。`tauriMockScript` のあとに入れる（`page.addInitScript` を続けて呼ぶ）。
 * `invoke` を包んで、読みのコマンドだけに答え、ほかは元の偽物に任せる。ハーネス（harness.ts）は変えない。
 * - `get_settings`: 元の設定に `reads_visible` を足して返す。`set_reads_visible` で替わる（次の読み込みでも、保存した値）
 * - `read_reads`: `reads`（読みの JSON の文字）。無ければ null
 * - `get_reads_model`: `installed`（既定は入っている）
 * - `compute_reads`: 終わらない（`window.__jrReads.release()` で終わる。進み具合は `window.__jrEmit('reads-progress', …)` で送る）
 * 呼び出しは `window.__jrCalls` に記録する（ほかのコマンドと同じ）。
 */
export interface ReadsMockOptions {
  /** 設定の `reads_visible` の最初の値。 */
  visible: boolean;
  /** `read_reads` の答え（読みの JSON の文字）。無ければ null（計算する）。 */
  reads: string | null;
  /** 読みのモデルが入っているか。 */
  installed?: boolean;
}

export function readsMockScript(options: ReadsMockOptions): string {
  return `(function (options) {
  var base = window.__TAURI_INTERNALS__.invoke;
  var state = { visible: options.visible, reads: options.reads, installed: options.installed !== false, release: null, computed: null };
  window.__jrReads = state;
  var model = function () {
    return {
      installed: state.installed,
      bytes: state.installed ? 4013332 : null,
      sha256: state.installed ? '50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea' : null,
      downloading: false,
      repo: 'hhim8826/mortal3-b40c192',
      revision: '7784a9d',
      file: 'tenpai.onnx',
      license: 'AGPL-3.0',
      origin: 'tenhou houou'
    };
  };
  window.__TAURI_INTERNALS__.invoke = function (cmd, args) {
    switch (cmd) {
      case 'get_settings':
        return base(cmd, args).then(function (settings) { return Object.assign({}, settings, { reads_visible: state.visible }); });
      case 'set_reads_visible':
        window.__jrCalls.push({ cmd: cmd, args: args });
        state.visible = !!args.visible;
        return base('get_settings', {}).then(function (settings) { return Object.assign({}, settings, { reads_visible: state.visible }); });
      case 'read_reads':
        window.__jrCalls.push({ cmd: cmd, args: args });
        return Promise.resolve(state.computed !== null ? state.computed : state.reads);
      case 'get_reads_model':
        window.__jrCalls.push({ cmd: cmd, args: args });
        return Promise.resolve(model());
      case 'compute_reads':
        window.__jrCalls.push({ cmd: cmd, args: args });
        return new Promise(function (resolve) {
          state.release = function (text) { state.computed = text; resolve(text); };
        });
      default:
        return base(cmd, args);
    }
  };
})(${JSON.stringify(options)});`;
}
