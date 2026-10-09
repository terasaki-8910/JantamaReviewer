import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useState } from 'react';

import { api, errorMessage, onSettingsChanged, onStateChanged } from '../api/tauri';
import type { Orientation, Settings, Trigger } from '../api/types';
import { formatKeyCode } from './format';

type TriggerMode = Trigger['kind'];

const TRIGGER_CHOICES: ReadonlyArray<{ mode: TriggerMode; label: string }> = [
  { mode: 'mouse_x1', label: 'マウスの「戻る」ボタン' },
  { mode: 'mouse_x2', label: 'マウスの「進む」ボタン' },
  { mode: 'mouse_middle', label: 'マウスの中ボタン' },
  { mode: 'key', label: 'キーボードのキー' },
];

const ORIENTATION_CHOICES: ReadonlyArray<{ value: Orientation; label: string }> = [
  { value: 'vertical', label: '縦長' },
  { value: 'horizontal', label: '横長' },
];

/**
 * 設定ページ。変えたらその場で反映して保存する（保存ボタンは無い）。
 * 使えない値（リポジトリの中の保存先、割り当てられないキー）は、理由を出して元のままにする。
 */
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [startupNote, setStartupNote] = useState<string | null>(null);
  // 保存先を開けないとき（リポジトリの中を指しているなど）の理由。
  const [storeError, setStoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  // 「キーボードのキー」を選んだが、まだキーを押していない間。
  const [choosingKey, setChoosingKey] = useState(false);
  // 窓を探す語の編集中の文字（確定するまで設定は変えない）。
  const [keywordsDraft, setKeywordsDraft] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => alive && setSettings(s));
    void api.getStartupNote().then((note) => alive && setStartupNote(note));
    void api.getState().then((s) => alive && setStoreError(s.error));
    const disposers: Array<() => void> = [];
    const track = (listening: Promise<() => void>) => {
      void listening.then((fn) => {
        if (alive) disposers.push(fn);
        else fn();
      });
    };
    track(onSettingsChanged((s) => setSettings(s)));
    track(onStateChanged((s) => setStoreError(s.error)));
    return () => {
      alive = false;
      disposers.forEach((fn) => fn());
    };
  }, []);

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

  if (!settings) {
    return (
      <>
        <header className="head">
          <h1 className="title">設定</h1>
        </header>
      </>
    );
  }

  const mode: TriggerMode = choosingKey ? 'key' : settings.trigger.kind;
  const keywordsText = keywordsDraft ?? settings.capture_keywords.join('\n');

  const chooseMode = (next: TriggerMode) => {
    if (next === 'key') {
      // キーを押すまでは、割り当ては変えない。
      setChoosingKey(settings.trigger.kind !== 'key');
      return;
    }
    setChoosingKey(false);
    if (settings.trigger.kind !== next) void update({ trigger: { kind: next } });
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
          <p className="notice" role="status">
            {startupNote}
          </p>
        )}
        <div className="settings">
          <fieldset className="setting pills-set">
            <legend className="lbl">迷いマークを付けるボタン</legend>
            <div className="pills">
              {TRIGGER_CHOICES.map((choice) => (
                <label className="pill" key={choice.mode}>
                  <input
                    type="radio"
                    name="trigger"
                    value={choice.mode}
                    checked={mode === choice.mode}
                    onChange={() => chooseMode(choice.mode)}
                  />
                  <span>{choice.label}</span>
                </label>
              ))}
            </div>
            {mode === 'key' && (
              <KeyPicker
                current={settings.trigger.kind === 'key' ? settings.trigger.code : null}
                onPick={(code) => {
                  setChoosingKey(false);
                  void update({ trigger: { kind: 'key', code } });
                }}
              />
            )}
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
              <p className="path" aria-labelledby="data-dir-label">
                {settings.data_dir}
              </p>
              <button type="button" className="btn" onClick={() => void pickFolder()}>
                フォルダを選ぶ
              </button>
            </div>
            {storeError && (
              <p className="error" role="alert">
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
          <p className="error" role="alert">
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

interface KeyPickerProps {
  /** いま割り当てているキー（無ければ null）。 */
  current: string | null;
  onPick: (code: string) => void;
}

/** 「キーを押して決める」ボタン。押したあと、次に押したキーを割り当てる。Esc でやめる。 */
function KeyPicker({ current, onPick }: KeyPickerProps) {
  const [listening, setListening] = useState(current === null);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setListening(false);
      if (event.code !== 'Escape') onPick(event.code);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening, onPick]);

  return (
    <div className="setting-row">
      <button type="button" className="btn" onClick={() => setListening(true)}>
        {current ? `いまのキー: ${formatKeyCode(current)}（変える）` : 'キーを押して決める'}
      </button>
      <span className="quiet" role="status">
        {listening ? 'キーを押してください（Esc でやめる）' : ''}
      </span>
    </div>
  );
}
