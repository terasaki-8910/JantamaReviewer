//! タスクの定義（`task_xml`）を、本物のタスクスケジューラが受け付けて、呼ばれたときだけ動かすことを確かめる（手動の試験）。
//!
//! 管理者の確認（UAC）を出せない環境でも確かめられるよう、実行の権限だけを「普通」に替えて登録する（管理者でない人は、
//! 最上位の権限のタスクを登録できない）。それ以外の定義（ユーザー・ログオンの種類・設定・動かす道筋）は、本物と同じ。
//! 試験用の名前のタスクを一時的に登録し、終わったら必ず消す。`cargo test -p jantama-helper --test task_scheduler -- --ignored`。

#![cfg(windows)]

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use jantama_input::setup::{
    schtasks_create_args, schtasks_delete_args, schtasks_query_args, schtasks_run_args, task_xml,
    TASK_NAME,
};
use jantama_input::user_win::{current_user_sid, is_elevated};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn schtasks(args: &[String]) -> bool {
    let system = std::env::var_os("SystemRoot").expect("SystemRoot がある");
    Command::new(PathBuf::from(system).join("System32").join("schtasks.exe"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|s| s.success())
}

/// 本物の引数の、タスクの名前だけを試験用に替える。
fn renamed(args: Vec<String>, name: &str) -> Vec<String> {
    args.into_iter()
        .map(|a| if a == TASK_NAME { name.to_string() } else { a })
        .collect()
}

/// 試験用のタスクを、終わるときに必ず消す。
struct Cleanup(String);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = schtasks(&renamed(schtasks_delete_args(), &self.0));
    }
}

#[test]
#[ignore = "タスクスケジューラに試験用のタスクを一時的に登録する手動の試験"]
fn w9_manual_task_scheduler_accepts_the_task_definition_and_runs_it_only_on_demand() {
    let name = format!("{TASK_NAME}Test-{}", std::process::id());
    let _cleanup = Cleanup(name.clone());
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran.txt");

    // 本物と同じ定義の、実行の権限と、動かすものだけを替える。
    let system = std::env::var("SystemRoot").unwrap();
    let cmd = format!("{system}\\System32\\cmd.exe");
    let mut xml = task_xml(&current_user_sid().unwrap(), &cmd);
    if !is_elevated() {
        xml = xml.replace("HighestAvailable", "LeastPrivilege");
    }
    xml = xml.replace(
        "<Arguments>run</Arguments>",
        &format!(
            "<Arguments>/c echo started&gt; \"{}\"</Arguments>",
            marker.display()
        ),
    );
    let xml_path = dir.path().join("task.xml");
    let mut bytes = vec![0xFF, 0xFE];
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(&xml_path, bytes).unwrap();

    assert!(
        schtasks(&renamed(
            schtasks_create_args(&xml_path.to_string_lossy()),
            &name
        )),
        "タスクスケジューラが、タスクの定義を受け付ける"
    );
    assert!(
        schtasks(&renamed(schtasks_query_args(), &name)),
        "登録したタスクを、尋ねられる"
    );
    // 起動の条件は付けていないので、呼ばれるまで動かない。
    thread::sleep(Duration::from_millis(500));
    assert!(!marker.exists(), "呼ぶ前に動いていない");

    assert!(schtasks(&renamed(schtasks_run_args(), &name)), "呼べる");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(marker.exists(), "呼ぶと、定義した実行ファイルが動く");

    assert!(schtasks(&renamed(schtasks_delete_args(), &name)), "外せる");
    assert!(
        !schtasks(&renamed(schtasks_query_args(), &name)),
        "外したあとは、見つからない"
    );
}
