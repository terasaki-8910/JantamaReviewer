//! 補助プログラムの設定（管理者の権限が要る、最初の 1 回だけの手続き）の、純粋な部分（W-9）。
//!
//! 流れ: 本体が、補助プログラムを「管理者として実行」（Windows の確認が出る）で `install` を付けて起動する。
//! 補助プログラムは、自分を管理者だけが書き込める場所（Program Files の下）に写し、そこを指すタスクスケジューラの
//! タスク（最上位の権限・確認なし）を登録する。以後、本体は `schtasks /run` でそのタスクを動かすだけで、確認は出ない。
//! 普通に書き換えられる場所の実行ファイルを、確認なしの管理者のタスクに指すと、権限の昇格の穴になる。
//! 写す手順が要るのは、そのため。
//!
//! ここには、引数・タスクの定義・終了コードの意味など、文字列を作って読むだけの部分を置く（実行は `helper` と本体）。

use std::path::{Path, PathBuf};

use crate::xml_ns::TASK_SCHEMA_NAMESPACE;

/// タスクスケジューラのタスクの名前。
pub const TASK_NAME: &str = "JantamaReviewerHelper";
/// 補助プログラムの実行ファイルの名前。
pub const HELPER_EXE_NAME: &str = "jantama-helper.exe";
/// 写し先のフォルダ名（Program Files の下）。
pub const INSTALL_DIR_NAME: &str = "JantamaReviewer";

pub const EXIT_OK: i32 = 0;
/// 理由のはっきりしない失敗。
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_BAD_ARGS: i32 = 2;
/// 管理者として動いていない。
pub const EXIT_NOT_ELEVATED: i32 = 3;
/// 管理者の確認で、本体と別のユーザーの管理者を選んだ（本体のパイプが使えなくなるので、断る）。
pub const EXIT_DIFFERENT_USER: i32 = 4;
/// 実行ファイルを写せなかった。
pub const EXIT_COPY_FAILED: i32 = 5;
/// タスクを登録できなかった。
pub const EXIT_TASK_FAILED: i32 = 6;
/// タスクは外したが、写した実行ファイルを消せなかった。
pub const EXIT_REMOVE_FAILED: i32 = 7;
/// 知らない引数。
pub const EXIT_UNKNOWN_COMMAND: i32 = 64;

/// 設定・解除の終了コードを、画面に出す文にする。
pub fn exit_message(code: u32) -> String {
    match i32::try_from(code).unwrap_or(-1) {
        EXIT_OK => "完了しました".to_string(),
        EXIT_BAD_ARGS => "補助プログラムに渡す引数が合いません".to_string(),
        EXIT_NOT_ELEVATED => "管理者の権限で動いていません".to_string(),
        EXIT_DIFFERENT_USER => {
            "Windows の確認で、いまのユーザーと別の管理者が選ばれました。同じユーザーの管理者で許可してください".to_string()
        }
        EXIT_COPY_FAILED => {
            "補助プログラムを Program Files に写せませんでした".to_string()
        }
        EXIT_TASK_FAILED => "タスクスケジューラに登録できませんでした".to_string(),
        EXIT_REMOVE_FAILED => {
            "起動の登録は外しましたが、Program Files の補助プログラムを消せませんでした".to_string()
        }
        EXIT_UNKNOWN_COMMAND => "補助プログラムが知らない指示です".to_string(),
        other => format!("失敗しました（終了コード {other}）"),
    }
}

/// ユーザーの SID の文字列（S-1-5-21-…）として使える形か。XML や引数に入れるので、文字を厳しく絞る。
pub fn is_valid_sid(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("S-1-") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 120
        && rest
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// XML の文字を置き換える。
pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// タスクスケジューラのタスクの定義（XML）。
/// - 起動の条件（トリガー）は無し。本体が `schtasks /run` で動かすときだけ動く。
/// - 実行するユーザーは、設定したユーザー本人。ログオンしているときだけ、その人のデスクトップで動く（確認は出ない）。
/// - 実行の権限は最上位（`HighestAvailable`）。管理者として動く雀魂の窓の入力も拾うために必要。
/// - バッテリー駆動でも止めず、時間制限も付けない（既定のままだと、ノート PC では起動しない・3 日で止まる）。
pub fn task_xml(user_sid: &str, exe_path: &str) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n",
            "<Task version=\"1.2\" xmlns=\"{ns}\">\n",
            "  <RegistrationInfo>\n",
            "    <Description>JantamaReviewer: 雀魂の上でもマウスのボタンを拾うための補助プログラム（入力を本体に知らせるだけ）</Description>\n",
            "  </RegistrationInfo>\n",
            "  <Principals>\n",
            "    <Principal id=\"Author\">\n",
            "      <UserId>{user}</UserId>\n",
            "      <LogonType>InteractiveToken</LogonType>\n",
            "      <RunLevel>HighestAvailable</RunLevel>\n",
            "    </Principal>\n",
            "  </Principals>\n",
            "  <Settings>\n",
            "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n",
            "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n",
            "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n",
            "    <AllowHardTerminate>true</AllowHardTerminate>\n",
            "    <StartWhenAvailable>false</StartWhenAvailable>\n",
            "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n",
            "    <IdleSettings>\n",
            "      <StopOnIdleEnd>false</StopOnIdleEnd>\n",
            "      <RestartOnIdle>false</RestartOnIdle>\n",
            "    </IdleSettings>\n",
            "    <AllowStartOnDemand>true</AllowStartOnDemand>\n",
            "    <Enabled>true</Enabled>\n",
            "    <Hidden>false</Hidden>\n",
            "    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n",
            "    <WakeToRun>false</WakeToRun>\n",
            "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n",
            "    <Priority>7</Priority>\n",
            "  </Settings>\n",
            "  <Actions Context=\"Author\">\n",
            "    <Exec>\n",
            "      <Command>{exe}</Command>\n",
            "      <Arguments>run</Arguments>\n",
            "    </Exec>\n",
            "  </Actions>\n",
            "</Task>\n"
        ),
        ns = TASK_SCHEMA_NAMESPACE,
        user = xml_escape(user_sid),
        exe = xml_escape(exe_path),
    )
}

/// Windows の実行のとき渡す 1 つの引数の書き方（空・空白・引用符を含むときは引用符で囲む）。
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_string();
    }
    let mut out = String::from('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            c => {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                out.push(c);
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// 引数を 1 本のコマンドラインにする（管理者の確認つきで動かすときの、引数の文字列）。
pub fn join_args(args: &[String]) -> String {
    args.iter()
        .map(|a| quote_arg(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 設定のとき、補助プログラムに渡す引数。ユーザーは SID で渡す（名前の書き方や言語に左右されない）。
pub fn install_args(user_sid: &str) -> Vec<String> {
    vec![
        "install".to_string(),
        "--user-sid".to_string(),
        user_sid.to_string(),
    ]
}

/// 解除のとき、補助プログラムに渡す引数。
pub fn uninstall_args() -> Vec<String> {
    vec!["uninstall".to_string()]
}

/// `install` のあとの引数から、ユーザーの SID を取り出す。形が合わなければ `None`。
pub fn parse_install_args(args: &[String]) -> Option<String> {
    match args {
        [flag, sid] if flag == "--user-sid" && is_valid_sid(sid) => Some(sid.clone()),
        _ => None,
    }
}

/// `schtasks` に渡す引数。
pub fn schtasks_create_args(xml_path: &str) -> Vec<String> {
    ["/create", "/tn", TASK_NAME, "/xml", xml_path, "/f"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub fn schtasks_run_args() -> Vec<String> {
    ["/run", "/tn", TASK_NAME]
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub fn schtasks_query_args() -> Vec<String> {
    ["/query", "/tn", TASK_NAME]
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub fn schtasks_end_args() -> Vec<String> {
    ["/end", "/tn", TASK_NAME]
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub fn schtasks_delete_args() -> Vec<String> {
    ["/delete", "/tn", TASK_NAME, "/f"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// 写し先のフォルダ（Program Files の下）。
pub fn install_dir(program_files: &Path) -> PathBuf {
    program_files.join(INSTALL_DIR_NAME)
}

/// 写した実行ファイルの場所。タスクはここを指す。
pub fn installed_exe(program_files: &Path) -> PathBuf {
    install_dir(program_files).join(HELPER_EXE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-512";

    #[test]
    fn w9_install_and_uninstall_commands_are_built_from_fixed_words_and_the_users_sid() {
        assert_eq!(install_args(SID), vec!["install", "--user-sid", SID]);
        assert_eq!(uninstall_args(), vec!["uninstall"]);
        assert_eq!(
            parse_install_args(&install_args(SID)[1..]),
            Some(SID.to_string())
        );
        // 形の合わない引数は読まない（XML に入れる前に断る）。
        assert_eq!(parse_install_args(&[]), None);
        assert_eq!(parse_install_args(&["--user-sid".to_string()]), None);
        assert_eq!(
            parse_install_args(&["--user-sid".to_string(), "DOMAIN\\user".to_string()]),
            None
        );
        assert_eq!(
            parse_install_args(&["--user".to_string(), SID.to_string()]),
            None
        );
        assert_eq!(
            parse_install_args(&["--user-sid".to_string(), format!("{SID}</UserId>")]),
            None
        );
    }

    #[test]
    fn w9_the_command_line_quotes_arguments_the_way_windows_reads_them() {
        assert_eq!(
            join_args(&install_args(SID)),
            format!("install --user-sid {SID}")
        );
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(
            quote_arg("C:\\Program Files\\x"),
            "\"C:\\Program Files\\x\""
        );
        assert_eq!(
            quote_arg("C:\\dir with space\\"),
            "\"C:\\dir with space\\\\\""
        );
        assert_eq!(
            join_args(&["a".to_string(), "b c".to_string(), "d".to_string()]),
            "a \"b c\" d"
        );
    }

    #[test]
    fn w9_only_well_formed_sids_are_accepted() {
        assert!(is_valid_sid(SID));
        assert!(is_valid_sid("S-1-5-18"));
        for bad in [
            "",
            "S-1-",
            "S-1-5-",
            "S-1-5--1",
            "S-2-5-18",
            "S-1-5-18 ",
            "s-1-5-18",
            "S-1-5-21-a",
            "S-1-5-18<",
            "S-1-5-18&amp;",
            &format!("S-1-{}", "1-".repeat(100)),
        ] {
            assert!(!is_valid_sid(bad), "{bad:?}");
        }
    }

    #[test]
    fn w9_xml_special_characters_are_escaped() {
        assert_eq!(
            xml_escape("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f"
        );
        assert_eq!(xml_escape("C:\\Program Files\\x"), "C:\\Program Files\\x");
    }

    #[test]
    fn w9_the_task_runs_the_installed_copy_with_the_highest_run_level_and_no_trigger() {
        let exe = installed_exe(Path::new("C:\\Program Files"));
        let exe = exe.to_string_lossy();
        // 区切りの `\` は Windows のパスの決まり。補助プログラムは Windows だけなので、ほかの OS では、区切り以外の部分だけを確かめる。
        #[cfg(windows)]
        assert_eq!(
            exe,
            "C:\\Program Files\\JantamaReviewer\\jantama-helper.exe"
        );
        #[cfg(not(windows))]
        assert!(
            exe.starts_with("C:\\Program Files")
                && exe.ends_with("JantamaReviewer/jantama-helper.exe"),
            "{exe}"
        );
        let xml = task_xml(SID, &exe);
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains(&format!("<UserId>{SID}</UserId>")));
        assert!(xml.contains(&format!("<Command>{exe}</Command>")));
        assert!(xml.contains("<Arguments>run</Arguments>"));
        assert!(!xml.contains("<Triggers"), "起動の条件は付けない");
        // ノート PC のバッテリー駆動でも起動し、止められず、時間制限も無い。
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        // 二重に動かさない。
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"));
    }

    #[test]
    fn w9_the_task_definition_cannot_be_broken_out_of_by_a_hostile_path_or_user() {
        let xml = task_xml("S-1-5-18", "C:\\x</Command><Command>evil.exe&");
        assert_eq!(xml.matches("<Command>").count(), 1);
        assert!(xml.contains("&lt;/Command&gt;&lt;Command&gt;evil.exe&amp;"));
    }

    #[test]
    fn w9_schtasks_commands_name_the_one_task() {
        assert_eq!(
            schtasks_create_args("C:\\x\\task.xml"),
            vec![
                "/create",
                "/tn",
                "JantamaReviewerHelper",
                "/xml",
                "C:\\x\\task.xml",
                "/f"
            ]
        );
        assert_eq!(
            schtasks_run_args(),
            vec!["/run", "/tn", "JantamaReviewerHelper"]
        );
        assert_eq!(
            schtasks_query_args(),
            vec!["/query", "/tn", "JantamaReviewerHelper"]
        );
        assert_eq!(
            schtasks_end_args(),
            vec!["/end", "/tn", "JantamaReviewerHelper"]
        );
        assert_eq!(
            schtasks_delete_args(),
            vec!["/delete", "/tn", "JantamaReviewerHelper", "/f"]
        );
    }

    #[test]
    fn w9_every_exit_code_has_a_message_a_person_can_act_on() {
        for code in [
            EXIT_OK,
            EXIT_BAD_ARGS,
            EXIT_NOT_ELEVATED,
            EXIT_DIFFERENT_USER,
            EXIT_COPY_FAILED,
            EXIT_TASK_FAILED,
            EXIT_REMOVE_FAILED,
            EXIT_UNKNOWN_COMMAND,
        ] {
            let message = exit_message(code as u32);
            assert!(!message.contains("終了コード"), "{code}: {message}");
        }
        assert!(exit_message(99).contains("99"));
        assert!(exit_message(u32::MAX).contains("失敗"));
    }
}
