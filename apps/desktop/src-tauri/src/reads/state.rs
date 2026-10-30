//! 読み（F23）の動いている処理の管理: モデルを取っている最中か・半荘ごとの計算が動いているか。
//!
//! - モデルを取る処理は、同時に 1 つだけ（2 つ目を始めようとすると断る）。取り消しの旗は、この処理が持つ。
//! - モデルを選ぶ・消す処理も、取っている間は始められず、同時に 2 つは動かない（置き場を 2 か所から書き換えない）。
//! - 読みの計算は、同じ半荘で同時に 1 つだけ（別々の半荘は、並んでよい）。モデルを置き換える処理の間は、始められない。
//!
//! 処理を始めると「札」（`DownloadTicket` など）が返り、札を手放すと（処理が終わるとき）、次の処理を始められる。

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// 動いているモデルの処理。
enum ModelOp {
    /// 取っている。中身は、取り消しの旗。
    Download(Arc<AtomicBool>),
    /// 選んだファイルを置いている・消している。
    Change,
}

#[derive(Default)]
struct Inner {
    model_op: Mutex<Option<ModelOp>>,
    computing: Mutex<BTreeSet<String>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// アプリの状態に置く、読みの処理の管理。複製しても、同じものを指す。
#[derive(Clone, Default)]
pub struct ReadsState {
    inner: Arc<Inner>,
}

/// モデルを取っている間、持っている札。手放すと、次の処理を始められる。
pub struct DownloadTicket {
    inner: Arc<Inner>,
    cancel: Arc<AtomicBool>,
}

impl DownloadTicket {
    /// 取り消しの旗（立つと、取る処理が止まる）。
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }
}

impl Drop for DownloadTicket {
    fn drop(&mut self) {
        *locked(&self.inner.model_op) = None;
    }
}

/// モデルのファイルを置いている・消している間、持っている札。
pub struct ModelChangeTicket {
    inner: Arc<Inner>,
}

impl Drop for ModelChangeTicket {
    fn drop(&mut self) {
        *locked(&self.inner.model_op) = None;
    }
}

/// 半荘の読みを計算している間、持っている札。
pub struct ComputeTicket {
    inner: Arc<Inner>,
    session_id: String,
}

impl Drop for ComputeTicket {
    fn drop(&mut self) {
        locked(&self.inner.computing).remove(&self.session_id);
    }
}

impl ReadsState {
    /// モデルを取っている最中か。
    pub fn is_downloading(&self) -> bool {
        matches!(*locked(&self.inner.model_op), Some(ModelOp::Download(_)))
    }

    /// モデルを取る処理を始める。すでに動いているモデルの処理があれば、断る。
    pub fn begin_download(&self) -> Result<DownloadTicket, String> {
        let mut op = locked(&self.inner.model_op);
        match *op {
            Some(ModelOp::Download(_)) => Err("すでにモデルを取っています".to_string()),
            Some(ModelOp::Change) => {
                Err("モデルのファイルを置いている途中です。終わるのを待ってください".to_string())
            }
            None => {
                let cancel = Arc::new(AtomicBool::new(false));
                *op = Some(ModelOp::Download(Arc::clone(&cancel)));
                Ok(DownloadTicket {
                    inner: Arc::clone(&self.inner),
                    cancel,
                })
            }
        }
    }

    /// 取っている処理を取り消す（旗を立てる）。取っていなければ何もせず、`false`。
    pub fn cancel_download(&self) -> bool {
        match &*locked(&self.inner.model_op) {
            Some(ModelOp::Download(cancel)) => {
                cancel.store(true, Ordering::SeqCst);
                true
            }
            _ => false,
        }
    }

    /// モデルのファイルを置く・消す処理を始める。取っている間と、読みを計算している間は、断る
    /// （計算の間は、エンジンが、そのファイルを開いている）。
    pub fn begin_model_change(&self) -> Result<ModelChangeTicket, String> {
        let mut op = locked(&self.inner.model_op);
        match *op {
            Some(ModelOp::Download(_)) => {
                return Err(
                    "モデルを取っている途中です。取り消すか、終わるのを待ってください".to_string(),
                )
            }
            Some(ModelOp::Change) => {
                return Err(
                    "モデルのファイルを置いている途中です。終わるのを待ってください".to_string(),
                )
            }
            None => {}
        }
        if !locked(&self.inner.computing).is_empty() {
            return Err(
                "読みを計算している間は、モデルを置き換えられません。終わるのを待ってください"
                    .to_string(),
            );
        }
        *op = Some(ModelOp::Change);
        Ok(ModelChangeTicket {
            inner: Arc::clone(&self.inner),
        })
    }

    /// 半荘の読みの計算を始める。同じ半荘がすでに動いているとき、モデルを取っている・置いている途中のときは、断る。
    pub fn begin_compute(&self, session_id: &str) -> Result<ComputeTicket, String> {
        if locked(&self.inner.model_op).is_some() {
            return Err(
                "モデルを取っている・置いている途中です。終わってから、もう一度試してください"
                    .to_string(),
            );
        }
        let mut computing = locked(&self.inner.computing);
        if !computing.insert(session_id.to_string()) {
            return Err("この半荘の読みを、いま計算しています".to_string());
        }
        Ok(ComputeTicket {
            inner: Arc::clone(&self.inner),
            session_id: session_id.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_download_runs_at_a_time_and_the_next_can_start_after_it_ends() {
        let state = ReadsState::default();
        assert!(!state.is_downloading());
        let first = state.begin_download().unwrap();
        assert!(state.is_downloading());
        // 2 つ目は断る（複製した管理からも同じ）
        let error = state.clone().begin_download().err().unwrap();
        assert_eq!(error, "すでにモデルを取っています");
        drop(first);
        assert!(!state.is_downloading());
        let again = state.begin_download().unwrap();
        assert!(state.is_downloading());
        drop(again);
    }

    #[test]
    fn cancelling_raises_the_flag_of_the_download_that_is_running_only() {
        let state = ReadsState::default();
        // 取っていないときは、何も起きない
        assert!(!state.cancel_download());
        let ticket = state.begin_download().unwrap();
        assert!(!ticket.cancel_flag().load(Ordering::SeqCst));
        assert!(state.cancel_download());
        assert!(ticket.cancel_flag().load(Ordering::SeqCst));
        drop(ticket);
        // 次の処理の旗は、立っていない
        let next = state.begin_download().unwrap();
        assert!(!next.cancel_flag().load(Ordering::SeqCst));
    }

    #[test]
    fn choosing_or_deleting_cannot_overlap_a_download_or_each_other() {
        let state = ReadsState::default();
        let change = state.begin_model_change().unwrap();
        assert!(state.begin_model_change().is_err());
        assert!(state.begin_download().is_err());
        assert!(!state.is_downloading());
        drop(change);
        let download = state.begin_download().unwrap();
        let error = state.begin_model_change().err().unwrap();
        assert!(error.contains("取っている途中"), "{error}");
        // 取っていても、取り消しは効く
        assert!(state.cancel_download());
        drop(download);
        assert!(state.begin_model_change().is_ok());
    }

    #[test]
    fn a_session_is_computed_one_at_a_time_but_different_sessions_may_overlap() {
        let state = ReadsState::default();
        let a = state.begin_compute("20261009-190953").unwrap();
        let b = state.begin_compute("20261010-120000").unwrap();
        let error = state.begin_compute("20261009-190953").err().unwrap();
        assert_eq!(error, "この半荘の読みを、いま計算しています");
        drop(a);
        // 終わったら、同じ半荘を、もう一度計算できる
        let a2 = state.begin_compute("20261009-190953").unwrap();
        drop((a2, b));
        assert!(state.begin_compute("20261009-190953").is_ok());
    }

    #[test]
    fn the_model_cannot_be_replaced_while_a_computation_runs_and_a_computation_waits_for_the_model()
    {
        let state = ReadsState::default();
        let compute = state.begin_compute("20261009-190953").unwrap();
        let error = state.begin_model_change().err().unwrap();
        assert!(error.contains("計算している間"), "{error}");
        // 取ること自体は始められる（まだ入っていないモデルを取る間も、別の半荘は計算できない）
        drop(compute);
        let download = state.begin_download().unwrap();
        assert!(state.begin_compute("20261009-190953").is_err());
        drop(download);
        let change = state.begin_model_change().unwrap();
        assert!(state.begin_compute("20261009-190953").is_err());
        drop(change);
        assert!(state.begin_compute("20261009-190953").is_ok());
    }

    #[test]
    fn a_panic_while_holding_the_lock_does_not_stop_the_state_from_working() {
        let state = ReadsState::default();
        let poisoner = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = locked(&poisoner.inner.model_op);
            panic!("試験のための panic");
        })
        .join();
        assert!(state.begin_download().is_ok());
    }
}
