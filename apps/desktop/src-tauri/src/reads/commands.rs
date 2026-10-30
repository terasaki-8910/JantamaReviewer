//! 読み（F23）と解析のモデル（F24）の Tauri コマンド（`apps/desktop/src/api/reads.ts` の窓口と、名前・引数・返り値・知らせを合わせる）。
//!
//! 呼べるのは検討画面だけ（ウィジェットの窓から呼ばれたら断る。ウィジェットには、読みにもモデルにも触れる理由が無い）。
//! 実際の処理は、`model`（置き場）・`download`（取る。通信はここだけ）・`engine_runner`（エンジンを呼ぶ）・`reads_file`（写しの確かめ）に
//! 任せ、ここは薄い層にとどめる。待ちのある処理（ファイルの読み書き・通信・エンジン）は、`spawn_blocking` で別のスレッドに回す。
//! モデルは、ユーザーが「Hugging Face から取る」を押したときだけ取る。読みの計算は、画面が `compute_reads` を呼んだときだけ動く。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::catalog::{models_dir, READS_MODEL};
use super::download::{
    download_model, DownloadError, DownloadLimits, ModelProgress, UreqTransport,
};
use super::engine_runner::{
    compute_reads_file, locate_engine, EngineError, EngineRun, ENGINE_TIMEOUT,
};
use super::model::{choose_file, delete_model, is_installed, status, ReadsModelStatus};
use super::reads_file::read_valid;
use super::state::ReadsState;
use crate::commands::{set_settings_now, SharedCore};
use crate::settings::Settings;
use crate::store::REPORT_FILE;
use crate::widget_window::MAIN_LABEL;

/// モデルを取っている間の進み具合を知らせるイベントの名前。
pub const EVENT_READS_MODEL_PROGRESS: &str = "reads-model-progress";
/// 半荘の読みを計算している間の進み具合（場面の数で数える）を知らせるイベントの名前。
pub const EVENT_READS_PROGRESS: &str = "reads-progress";

/// 読みの計算の進み具合（画面の `reads-progress` の知らせ）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadsProgress {
    pub session_id: String,
    pub done: usize,
    pub total: usize,
}

/// 検討画面の窓から呼ばれたか。
fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err("読みと解析のモデルは、検討画面からだけ扱えます".to_string())
    }
}

/// 設定のフォルダ（環境変数 `JANTAMA_CONFIG_DIR` は、起動のときに反映済み）。
fn config_dir(app: &AppHandle) -> PathBuf {
    app.state::<SharedCore>().lock().config_dir().to_path_buf()
}

/// 半荘のフォルダ。名前の形が正しくない・フォルダが無いときは断る。記録の錠は、ここだけで短く取る。
fn session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let shared = app.state::<SharedCore>();
    let core = shared.lock();
    let dir = core
        .store()?
        .session_folder(session_id)
        .filter(|dir| dir.is_dir());
    dir.ok_or_else(|| format!("半荘が見つかりません: {session_id}"))
}

/// 待ちのある処理を、別のスレッドで動かして、結果を待つ（画面を止めない）。
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("読みの処理が止まりました: {e}"))
}

fn emit_model_progress(app: &AppHandle, progress: ModelProgress) {
    let _ = app.emit_to(MAIN_LABEL, EVENT_READS_MODEL_PROGRESS, progress);
}

fn emit_reads_progress(app: &AppHandle, session_id: &str, done: usize, total: usize) {
    let progress = ReadsProgress {
        session_id: session_id.to_string(),
        done,
        total,
    };
    let _ = app.emit_to(MAIN_LABEL, EVENT_READS_PROGRESS, progress);
}

/// 読みのモデルの状態（入っているか・取っている最中か・出どころ）。通信しない。
#[tauri::command]
pub async fn get_reads_model(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ReadsModelStatus, String> {
    ensure_main(&window)?;
    let dir = models_dir(&config_dir(&app));
    let downloading = app.state::<ReadsState>().is_downloading();
    blocking(move || status(&READS_MODEL, &dir, downloading)).await
}

/// 決まった版を、Hugging Face から取る。押したときだけ呼ばれる。進み具合は `reads-model-progress` で知らせる。
/// SHA-256 が合わなければ捨てて、理由を返す。取り消したときは、エラーにせず、いまの状態（入っていない）を返す。
#[tauri::command]
pub async fn download_reads_model(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ReadsModelStatus, String> {
    ensure_main(&window)?;
    let dir = models_dir(&config_dir(&app));
    let ticket = app.state::<ReadsState>().begin_download()?;
    blocking(move || {
        let outcome = download_model(
            &READS_MODEL,
            &UreqTransport::new(),
            &dir,
            &DownloadLimits::default(),
            ticket.cancel_flag(),
            &mut |progress| emit_model_progress(&app, progress),
        );
        // 取り終えた（札を手放した）あとの状態を返す
        drop(ticket);
        match outcome {
            Ok(()) | Err(DownloadError::Cancelled) => Ok(status(&READS_MODEL, &dir, false)),
            Err(e) => Err(e.to_string()),
        }
    })
    .await?
}

/// 取っている途中なら止める（途中のファイルは消える）。取っていなければ、何もしない。
#[tauri::command]
pub async fn cancel_reads_model_download(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    ensure_main(&window)?;
    app.state::<ReadsState>().cancel_download();
    Ok(())
}

/// 自分で取ったファイルを使う。決まった版（SHA-256）でなければ、理由を返す。
#[tauri::command]
pub async fn choose_reads_model_file(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<ReadsModelStatus, String> {
    ensure_main(&window)?;
    let dir = models_dir(&config_dir(&app));
    let ticket = app.state::<ReadsState>().begin_model_change()?;
    blocking(move || {
        let _ticket = ticket;
        choose_file(&READS_MODEL, &dir, &PathBuf::from(path)).map_err(|e| e.to_string())?;
        Ok(status(&READS_MODEL, &dir, false))
    })
    .await?
}

/// 入っているモデルを消す。
#[tauri::command]
pub async fn delete_reads_model(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ReadsModelStatus, String> {
    ensure_main(&window)?;
    let dir = models_dir(&config_dir(&app));
    let ticket = app.state::<ReadsState>().begin_model_change()?;
    blocking(move || {
        let _ticket = ticket;
        delete_model(&READS_MODEL, &dir).map_err(|e| e.to_string())?;
        Ok(status(&READS_MODEL, &dir, false))
    })
    .await?
}

/// 半荘の `reads.json`。使えるとき（形が合い、いま入っているモデルで計算したもの）だけ文字を返し、
/// 無い・形が違う・別のモデルのものなら `null`（画面が、計算し直す）。
#[tauri::command]
pub async fn read_reads(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<Option<String>, String> {
    ensure_main(&window)?;
    let dir = session_dir(&app, &session_id)?;
    let models = models_dir(&config_dir(&app));
    blocking(move || {
        // モデルの中身を確かめる（読む）のは、使える写しがあるときだけ
        read_valid(&dir, READS_MODEL.sha256, || {
            is_installed(&READS_MODEL, &models)
        })
    })
    .await
}

/// 半荘の読みを、解析エンジンで計算して `reads.json` に置き、その文字を返す。進み具合は `reads-progress` で知らせる。
/// モデルが入っていない・結果を取り込んでいない・エンジンが失敗したときは、その理由を返す。
#[tauri::command]
pub async fn compute_reads(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<String, String> {
    ensure_main(&window)?;
    let dir = session_dir(&app, &session_id)?;
    let models = models_dir(&config_dir(&app));
    let ticket = app.state::<ReadsState>().begin_compute(&session_id)?;
    blocking(move || {
        let _ticket = ticket;
        compute(&app, &session_id, &dir, &models)
    })
    .await?
}

/// 計算の本体: モデルが入っているか → 結果があるか → エンジンの場所 → エンジンを動かす。
fn compute(
    app: &AppHandle,
    session_id: &str,
    dir: &std::path::Path,
    models: &std::path::Path,
) -> Result<String, String> {
    if !is_installed(&READS_MODEL, models) {
        return Err("読みのモデルが入っていません".to_string());
    }
    if !dir.join(REPORT_FILE).is_file() {
        return Err(EngineError::NoReport.to_string());
    }
    let engine = locate_engine().map_err(|e| e.to_string())?;
    let model = READS_MODEL.target_in(models);
    let run = EngineRun {
        engine: &engine,
        session_dir: dir,
        model: &model,
        model_sha256: READS_MODEL.sha256,
        timeout: ENGINE_TIMEOUT,
    };
    compute_reads_file(&run, &mut |done, total| {
        emit_reads_progress(app, session_id, done, total)
    })
    .map_err(|e| e.to_string())
}

/// 「読み」の入切を設定（settings.json の `reads_visible`）に覚える。この PC だけの値で、同期にも書き出しにも入れない。
/// 設定が変わったことは、全部の窓に知らせる（設定のページが、古い値で上書きしないため）。
#[tauri::command]
pub async fn set_reads_visible(
    app: AppHandle,
    window: WebviewWindow,
    visible: bool,
) -> Result<Settings, String> {
    ensure_main(&window)?;
    let current = app.state::<SharedCore>().lock().settings().clone();
    set_settings_now(&app, settings_with_reads_visible(&current, visible))
}

/// 「読み」の入切を替えたあとの設定。ほかの設定は、そのまま。
fn settings_with_reads_visible(current: &Settings, visible: bool) -> Settings {
    Settings {
        reads_visible: visible,
        ..current.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f23_switching_reads_keeps_every_other_setting() {
        let current = Settings {
            sound: false,
            daily_count: 8,
            skipped_update_version: Some("0.2.0".to_string()),
            ..Settings::default()
        };
        let on = settings_with_reads_visible(&current, true);
        assert!(on.reads_visible);
        assert!(!on.sound);
        assert_eq!(on.daily_count, 8);
        assert_eq!(on.skipped_update_version.as_deref(), Some("0.2.0"));
        assert_eq!(on.data_dir, current.data_dir);
        // 切にすると、元の設定に戻る
        assert_eq!(settings_with_reads_visible(&on, false), current);
    }

    #[test]
    fn f23_a_reads_switch_survives_a_restart() {
        use crate::settings::settings_path;
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path());
        let next = settings_with_reads_visible(&Settings::default(), true);
        next.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert!(loaded.reads_visible);
        assert_eq!(loaded, next);
    }

    #[test]
    fn f23_the_reads_switch_is_not_synced_and_not_exported_and_an_import_keeps_it() {
        use crate::study::records::PortableSettings;
        use crate::sync::local::SETTING_NAMES;

        // 同期する設定の名前に無い（データの保存先・飛ばした更新の版と同じ。この PC だけの値）
        assert!(!SETTING_NAMES.contains(&"reads_visible"));
        // 書き出す設定の形に無い
        let settings = settings_with_reads_visible(&Settings::default(), true);
        let exported = serde_json::to_string(&PortableSettings::from_settings(&settings)).unwrap();
        assert!(!exported.contains("reads_visible"), "{exported}");
        // 読み込むと、いまの入切のまま（書き出したファイルの値で、変わらない）
        let from_file = PortableSettings::from_settings(&Settings::default());
        assert!(from_file.applied_to(&settings).reads_visible);
        let off = Settings::default();
        let from_on = PortableSettings::from_settings(&settings);
        assert!(!from_on.applied_to(&off).reads_visible);
    }

    #[test]
    fn the_events_carry_the_names_and_shapes_the_screen_listens_for() {
        // 画面（`src/api/reads.ts`）が読む名前と形。変えるときは、画面と一緒に変える。
        assert_eq!(EVENT_READS_MODEL_PROGRESS, "reads-model-progress");
        assert_eq!(EVENT_READS_PROGRESS, "reads-progress");
        assert_eq!(
            serde_json::to_value(ModelProgress {
                done: 1_200_000,
                total: Some(4_013_332)
            })
            .unwrap(),
            serde_json::json!({"done": 1_200_000, "total": 4_013_332})
        );
        assert_eq!(
            serde_json::to_value(ModelProgress {
                done: 5,
                total: None
            })
            .unwrap(),
            serde_json::json!({"done": 5, "total": null})
        );
        assert_eq!(
            serde_json::to_value(ReadsProgress {
                session_id: "20261009-190953".to_string(),
                done: 3,
                total: 126
            })
            .unwrap(),
            serde_json::json!({"session_id": "20261009-190953", "done": 3, "total": 126})
        );
    }
}
