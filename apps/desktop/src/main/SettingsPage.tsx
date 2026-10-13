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
import { platform } from '../shared/platform';
import { describeTrigger, formatClock } from './format';
import { RecordsBlock } from './RecordsBlock';
import { SyncBlock } from './SyncBlock';

const ORIENTATION_CHOICES: ReadonlyArray<{ value: Orientation; label: string }> = [
  { value: 'vertical', label: '縦長' },
  { value: 'horizontal', label: '横長' },
];

/** 出題の設定の範囲（settings.rs と同じ。範囲の外は、保存側が断る）。 */
const DAILY_COUNT_RANGE = { min: 1, max: 50 } as const;
const DISAGREEMENT_RANGE = { min: 1, max: 50 } as const;

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

export interface SettingsPageProps {
  /** 「記録の読み込み」の確認を開いている間は true（呼ぶ側が、裏の画面を `inert` にする）。 */
  onRecordsModal?: (open: boolean) => void;
  /** 記録を置き換えたあとに呼ぶ（呼ぶ側が、画面のデータを読み直す。知らせの文は、読み直したあとの設定ページにも出す）。 */
  onRecordsReplaced?: (message: string) => void;
  /** 読み直したあとに、最初から出しておく「読み込みました…」の知らせ。 */
  recordsNotice?: string | null;
}

/**
 * 設定ページ。変えたらその場で反映して保存する（保存ボタンは無い）。
 * 使えない値（リポジトリの中の保存先）は、理由を出して元のままにする。
 * 迷いマークのボタンは、「ボタンを登録」で、次に押したマウスのボタンかキーをそのまま覚える（W-10）。
 * 押した入力は、本体の側（補助プログラムか本体のフック）が拾うので、ここでは待機の表示と結果だけを持つ。
 */
export function SettingsPage({ onRecordsModal, onRecordsReplaced, recordsNotice = null }: SettingsPageProps = {}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [input, setInput] = useState<InputStatus | null>(null);
  const [startupNote, setStartupNote] = useState<string | null>(null);
  // 保存先を開けないとき（リポジトリの中を指しているなど）の理由。
  const [storeError, setStoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  // 窓を探す語の編集中の文字（確定するまで設定は変えない）。
  const [keywordsDraft, setKeywordsDraft] = useState<string | null>(null);
  // 数の欄の編集中の文字（欄の外へ出る・Enter で確定するまで設定は変えない）。
  const [dailyDraft, setDailyDraft] = useState<string | null>(null);
  const [percentDraft, setPercentDraft] = useState<string | null>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const listening = useRef<HTMLParagraphElement>(null);
  const wasRegistering = useRef(false);
  // この OS で使える機能（macOS の段階 2 では、ウィジェット・ボタンを拾うこと・撮影が無いので、その行を出さない）。
  const features = platform().features;

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

  /** 数の欄を確定する。範囲の外・数でないときは、理由を出して元の値に戻す。 */
  const commitNumber = (
    draft: string | null,
    clear: () => void,
    current: number,
    range: { min: number; max: number },
    name: string,
    unit: string,
    patch: (value: number) => Partial<Settings>,
  ) => {
    if (draft === null) return;
    clear();
    const value = Number(draft.trim());
    if (draft.trim() === '' || !Number.isInteger(value) || value < range.min || value > range.max) {
      setError(`${name}は ${range.min}${unit} から ${range.max}${unit} の間の整数で指定してください`);
      setSaved('');
      return;
    }
    if (value !== current) void update(patch(value));
  };

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
          {features.button_hook ? (
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
              {helper && features.helper && <HelperRow helper={helper} run={run} />}
            </fieldset>
          ) : (
            <fieldset className="setting pills-set">
              <legend className="lbl">迷いマークのボタン</legend>
              <p className="quiet">
                Mac ではまだ使えません。ウィジェット・迷いマークのボタン・画面の撮影は、Mac 版の次の段階で対応します。
              </p>
            </fieldset>
          )}

          {features.widget && (
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
          )}

          {features.widget && (
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
          )}

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

          <RecordsBlock
            onModalChange={onRecordsModal}
            onReplaced={onRecordsReplaced}
            initialNotice={recordsNotice}
          />

          <SyncBlock onModalChange={onRecordsModal} />

          {features.capture && (
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
          )}

          <div className="setting field">
            <label htmlFor="daily-count">1日に出す数</label>
            <input
              id="daily-count"
              className="input num"
              type="number"
              inputMode="numeric"
              min={DAILY_COUNT_RANGE.min}
              max={DAILY_COUNT_RANGE.max}
              step={1}
              value={dailyDraft ?? String(settings.daily_count)}
              aria-describedby="daily-count-help"
              onChange={(e) => setDailyDraft(e.target.value)}
              onBlur={() =>
                commitNumber(dailyDraft, () => setDailyDraft(null), settings.daily_count, DAILY_COUNT_RANGE, '1日に出す数', '', (value) => ({
                  daily_count: value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
            <p className="quiet" id="daily-count-help">
              今日の出題に入れる問題の数です（既定は5）。
            </p>
          </div>

          <div className="setting field">
            <label htmlFor="disagreement-percent">大きな不一致の基準</label>
            <div className="setting-row">
              <input
                id="disagreement-percent"
                className="input num"
                type="number"
                inputMode="numeric"
                min={DISAGREEMENT_RANGE.min}
                max={DISAGREEMENT_RANGE.max}
                step={1}
                value={percentDraft ?? String(settings.disagreement_percent)}
                aria-describedby="disagreement-percent-help"
                onChange={(e) => setPercentDraft(e.target.value)}
                onBlur={() =>
                  commitNumber(
                    percentDraft,
                    () => setPercentDraft(null),
                    settings.disagreement_percent,
                    DISAGREEMENT_RANGE,
                    '大きな不一致の基準',
                    '%',
                    (value) => ({ disagreement_percent: value }),
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <span aria-hidden="true">%</span>
            </div>
            <p className="quiet" id="disagreement-percent-help">
              実戦の行動の確率がこの値より低い判断を、大きな不一致として出題します。答え合わせで正解とする確率の下限にも使います（既定は5%）。
            </p>
          </div>

          <div className="setting">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.show_all_mismatches === true}
                aria-describedby="show-all-mismatches-help"
                onChange={(e) => void update({ show_all_mismatches: e.target.checked })}
              />
              AI の1位と違う判断も、不一致として出す
            </label>
            <p className="quiet" id="show-all-mismatches-help">
              半荘を通して見る画面で、確率が基準以上でも、AI の1位と違う判断を不一致の場面に入れます。出題の基準は変わりません（既定は切）。
            </p>
          </div>

          <div className="setting">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.highlight_dora}
                aria-describedby="highlight-dora-help"
                onChange={(e) => void update({ highlight_dora: e.target.checked })}
              />
              ドラを目立たせる
            </label>
            <p className="quiet" id="highlight-dora-help">
              出題と半荘を通して見る画面で、ドラ表示牌が指す牌の面を黄色にします。赤五は、指される牌でもあるときだけ黄色になります（既定は切）。
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
