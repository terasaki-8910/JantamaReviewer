import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  api,
  errorMessage,
  onInputStatus,
  onSettingsChanged,
  onStateChanged,
} from '../api/tauri';
import type { HelperStatus, InputStatus, Orientation, Settings } from '../api/types';
import { describeTrigger, formatClock } from './format';

const ORIENTATION_CHOICES: ReadonlyArray<{ value: Orientation; label: string }> = [
  { value: 'vertical', label: '縦長' },
  { value: 'horizontal', label: '横長' },
];

const PROBE_IDLE = 'ボタンを押すと、ここに表示されます。迷いマークは記録しません';

/** 修飾キーそのものの `KeyboardEvent.code`（単独では、割り当てにも登録にも使わない）。 */
const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)$|^AltGraph$/;

/** 窓の中のキーとして本体に知らせない `KeyboardEvent.key`（画面の操作に使うキー）。 */
const PASS_THROUGH_KEYS: ReadonlySet<string> = new Set(['Tab', 'Enter', ' ', 'Escape']);

/** 補助プログラムの状態の行に出す文（承認済みの見本に無い部分は、同じ静かな書き方で足している）。 */
function helperStateText(helper: HelperStatus): string {
  switch (helper.busy) {
    case 'installing':
      return '設定しています。Windows の確認が出たら、許可してください';
    case 'removing':
      return '解除しています。Windows の確認が出たら、許可してください';
    case 'starting':
      return '起動しています';
    default:
      return helper.running ? '動いています' : '動いていません（雀魂の上ではボタンが効きません）';
  }
}

/**
 * 設定ページ。変えたらその場で反映して保存する（保存ボタンは無い）。
 * 使えない値（リポジトリの中の保存先）は、理由を出して元のままにする。
 * 迷いマークのボタンは、「ボタンを登録」で、次に押したマウスのボタンかキーをそのまま覚える（W-10）。
 * 押した入力は、本体の側（補助プログラムか本体のフック）が拾うので、ここでは待機の表示と結果だけを持つ。
 */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [input, setInput] = useState<InputStatus | null>(null);
  const [startupNote, setStartupNote] = useState<string | null>(null);
  // 保存先を開けないとき（リポジトリの中を指しているなど）の理由。
  const [storeError, setStoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  // 窓を探す語の編集中の文字（確定するまで設定は変えない）。
  const [keywordsDraft, setKeywordsDraft] = useState<string | null>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const listening = useRef<HTMLParagraphElement>(null);
  const wasRegistering = useRef(false);

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => alive && setSettings(s));
    void api.getStartupNote().then((note) => alive && setStartupNote(note));
    void api.getState().then((s) => alive && setStoreError(s.error));
    void api.getInputStatus().then((s) => alive && setInput(s));
    const disposers: Array<() => void> = [];
    const track = (listening: Promise<() => void>) => {
      void listening.then((fn) => {
        if (alive) disposers.push(fn);
        else fn();
      });
    };
    track(onSettingsChanged((s) => setSettings(s)));
    track(onStateChanged((s) => setStoreError(s.error)));
    track(onInputStatus((s) => setInput(s)));
    // テストの欄を見せている間だけ、割り当てたボタンを押しても記録しない（W-11）。
    // 窓が操作を受けていない間（雀魂を打っている間）は、本体の側が通常の動きに戻す。
    void api.setProbeWanted(true).catch(() => undefined);
    return () => {
      alive = false;
      disposers.forEach((fn) => fn());
      void api.setProbeWanted(false).catch(() => undefined);
    };
  }, []);

  const registering = input?.registering ?? false;

  // 待機に入ったら待機の表示へ、終わったら「ボタンを登録」へ、キーボードの位置を移す。
  useEffect(() => {
    if (registering) listening.current?.focus();
    else if (wasRegistering.current) startButton.current?.focus();
    wasRegistering.current = registering;
  }, [registering]);

  // 待機中に Esc で取りやめる（本体の側のフックも Esc を見るが、窓の中の Esc でも取りやめられるように）。
  useEffect(() => {
    if (!registering) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void api.cancelRegistration().catch(() => undefined);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [registering]);

  // この窓が前面にある間は、本体のキーボードのフックには入力が届かない（Windows の側の事情。フックは外してある）。
  // 窓の中のキーは、ここで拾って本体に知らせる。登録の待機中は登録の候補に、キーを割り当てているときは
  // テストの押下になる（W-10、W-11）。マウスのボタンは、前面が自分の窓でもフックに届くので、ここでは扱わない。
  const keyTrigger = settings?.trigger.kind === 'key';
  useEffect(() => {
    if (!registering && !keyTrigger) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 押しっぱなしの繰り返し・日本語入力の途中・修飾キー単独（組み合わせの途中）は、知らせない。
      if (event.repeat || event.isComposing || MODIFIER_CODE.test(event.code)) return;
      // Tab（移動）・Enter・Space（ボタンの操作）・Esc（上で取りやめる）は、登録にも割り当てにも使わない。
      if (PASS_THROUGH_KEYS.has(event.key)) return;
      // 待機中は、押したキーを窓に渡さない（フォーカスのあるものを動かしてしまわないように）。
      if (registering) event.preventDefault();
      void api
        .reportPageKey({
          code: event.code,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        })
        .catch(() => undefined);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [registering, keyTrigger]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      if (!settings) return;
      try {
        const next = await api.setSettings({ ...settings, ...patch });
        setSettings(next);
        setError(null);
        setSaved('保存しました');
      } catch (e) {
        setError(errorMessage(e));
        setSaved('');
      }
    },
    [settings],
  );

  const pickFolder = useCallback(async () => {
    if (!settings) return;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: settings.data_dir,
        title: 'データの保存先を選ぶ',
      });
      if (typeof picked === 'string') await update({ data_dir: picked });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [settings, update]);

  const run = useCallback((action: () => Promise<void>) => {
    action().then(
      () => setError(null),
      (e: unknown) => setError(errorMessage(e)),
    );
  }, []);

  if (!settings) {
    return (
      <>
        <header className="head">
          <h1 className="title">設定</h1>
        </header>
      </>
    );
  }

  const keywordsText = keywordsDraft ?? settings.capture_keywords.join('\n');
  const probeMs = input?.probe_ms ?? null;
  const helper = input?.helper ?? null;

  const commitKeywords = () => {
    if (keywordsDraft === null) return;
    const words = keywordsDraft
      .split('\n')
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    setKeywordsDraft(null);
    if (words.join('\n') !== settings.capture_keywords.join('\n')) {
      void update({ capture_keywords: words });
    }
  };

  return (
    <>
      <header className="head">
        <h1 className="title">設定</h1>
      </header>
      <div className="page">
        {startupNote && (
          <p className="notice selectable" role="status">
            {startupNote}
          </p>
        )}
        <div className="settings">
          <fieldset className="setting pills-set capture">
            <legend className="lbl">迷いマークのボタン</legend>
            {registering ? (
              <>
                <div className="setting-row">
                  <p
                    className="listening"
                    role="status"
                    tabIndex={-1}
                    ref={listening}
                    aria-describedby="capture-hint"
                  >
                    <span className="dotc" aria-hidden="true" />
                    登録したいボタンを押してください（マウスのボタンでもキーでも）
                  </p>
                  <button type="button" className="btn" onClick={() => run(api.cancelRegistration)}>
                    キャンセル
                  </button>
                </div>
                <p className="quiet" id="capture-hint">
                  Esc でやめます。英字・数字・記号のキーは、Ctrl か Alt と組み合わせて押してください。左右のボタンは登録できません。
                </p>
              </>
            ) : (
              <div className="setting-row">
                <p className="keycap">{describeTrigger(settings.trigger)}</p>
                <button
                  type="button"
                  className="btn"
                  ref={startButton}
                  onClick={() => run(api.startRegistration)}
                >
                  ボタンを登録
                </button>
              </div>
            )}
            {input?.message && (
              <p className="error selectable" role="alert">
                {input.message}
              </p>
            )}
            <div className="probe-box">
              <span className="lbl-sm" id="probe-lbl">
                テスト
              </span>
              <p
                className="probe"
                role="status"
                aria-labelledby="probe-lbl"
                data-got={probeMs !== null}
              >
                {probeMs !== null ? (
                  // 1 つの要素に包む（.probe は flex なので、文字と時刻が別の項目になると、間の空白が消える）。
                  <span>
                    受け取りました <span className="mono">{formatClock(probeMs)}</span>
                  </span>
                ) : (
                  PROBE_IDLE
                )}
              </p>
            </div>
            {helper && <HelperRow helper={helper} run={run} />}
          </fieldset>

          <fieldset className="setting pills-set">
            <legend className="lbl">ウィジェットの形</legend>
            <div className="pills">
              {ORIENTATION_CHOICES.map((choice) => (
                <label className="pill" key={choice.value}>
                  <input
                    type="radio"
                    name="orientation"
                    value={choice.value}
                    checked={settings.orientation === choice.value}
                    onChange={() => void update({ orientation: choice.value })}
                  />
                  <span>{choice.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="setting">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.sound}
                onChange={(e) => void update({ sound: e.target.checked })}
              />
              迷いを記録したら音を鳴らす
            </label>
          </div>

          <div className="setting">
            <span className="lbl field-label" id="data-dir-label">
              データの保存先
            </span>
            <div className="setting-row">
              <p className="path selectable" aria-labelledby="data-dir-label">
                {settings.data_dir}
              </p>
              <button type="button" className="btn" onClick={() => void pickFolder()}>
                フォルダを選ぶ
              </button>
            </div>
            {storeError && (
              <p className="error selectable" role="alert">
                {storeError}
              </p>
            )}
          </div>

          <div className="setting field">
            <label htmlFor="capture-keywords">雀魂の窓を探す語（1行に1つ）</label>
            <textarea
              id="capture-keywords"
              className="input"
              value={keywordsText}
              spellCheck={false}
              aria-describedby="capture-keywords-help"
              onChange={(e) => setKeywordsDraft(e.target.value)}
              onBlur={commitKeywords}
            />
            <p className="quiet" id="capture-keywords-help">
              窓の題名にこの語があれば、その窓を撮ります。見つからないときは画面全体を撮ります。
            </p>
          </div>
        </div>
        {error && (
          <p className="error selectable" role="alert">
            {error}
          </p>
        )}
        <p className="saved" role="status">
          {saved}
        </p>
      </div>
    </>
  );
}

interface HelperRowProps {
  helper: HelperStatus;
  run: (action: () => Promise<void>) => void;
}

/**
 * 管理者の補助プログラムの 1 行（W-9）。雀魂は管理者の権限で動くので、その窓が前面にあるとき、
 * 普通の権限の本体はボタンを拾えない。補助プログラムは、最初の 1 回だけ Windows の確認で設定すれば、
 * 以後は確認なしで、アプリと一緒に起動する。
 */
function HelperRow({ helper, run }: HelperRowProps) {
  const busy = helper.busy !== null;
  const installed = helper.installed === true;
  return (
    <>
      <div className="helper-row">
        <span className="lbl-sm" id="helper-lbl">
          補助プログラム
        </span>
        <p className="quiet helper-state" role="status" aria-labelledby="helper-lbl">
          {helperStateText(helper)}
        </p>
        {!helper.running && helper.installed === false && (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => run(api.setupHelper)}
          >
            管理者の補助プログラムを設定する
          </button>
        )}
        {!helper.running && installed && (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => run(api.startHelper)}
          >
            起動する
          </button>
        )}
        {installed && (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => run(api.removeHelper)}
          >
            設定を解除する
          </button>
        )}
      </div>
      {helper.error && (
        <p className="error selectable" role="alert">
          {helper.error}
        </p>
      )}
    </>
  );
}
