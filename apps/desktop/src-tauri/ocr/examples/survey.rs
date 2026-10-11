//! 読み取りを比べる道具（手元で動かす。製品には入らない）: 半荘のフォルダ（`marks/`・`ratings/` の PNG が入っている）を引数に取り、
//! 画像ごとに、割合の箱で読んだ結果（E-32 より前の読み方）と、水色の文字の位置から切り出して読んだ結果（いまの読み方）の
//! 行（1 回目と読み直し）を、1 行 1 件の JSON で標準出力に書く。局・残り枚数・点数の取り出し（E-16）は、エンジン（TypeScript）の
//! `parseCenterText` が行うので、ここでは行までを出す。画像は読むだけで、書き換えない。
//!
//! 使い方（リポジトリの `apps/desktop/src-tauri` から。Windows の日本語の文字認識が要る）:
//!
//!     cargo run --release -p jantama-ocr --example survey -- <半荘のフォルダ>...
//!
//! フォルダの代わりに PNG のファイルも渡せる。保存先のパスはここには書かない（引数で渡す）。

#[cfg(windows)]
mod tool {
    use std::fmt::Write as _;
    use std::fs;
    use std::path::{Path, PathBuf};

    use jantama_ocr::{OcrWorker, Reading};

    /// PNG の先頭（IHDR）から、画像の大きさ（幅, 高さ）を読む。
    fn png_size(path: &Path) -> Option<(u32, u32)> {
        let bytes = fs::read(path).ok()?;
        if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            return None;
        }
        let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
        Some((word(16), word(20)))
    }

    fn json_string(text: &str) -> String {
        let mut out = String::from("\"");
        for c in text.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    let _ = write!(out, "\\u{:04x}", c as u32);
                }
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    fn json_lines(lines: &[String]) -> String {
        let items: Vec<String> = lines.iter().map(|line| json_string(line)).collect();
        format!("[{}]", items.join(","))
    }

    fn json_readings(readings: &[Reading]) -> String {
        let items: Vec<String> = readings
            .iter()
            .map(|r| {
                format!(
                    "{{\"variant\":{},\"lines\":{}}}",
                    json_string(r.variant.name()),
                    json_lines(&r.lines)
                )
            })
            .collect();
        format!("[{}]", items.join(","))
    }

    /// 引数 1 つから、読む画像（フォルダ名・種類・ファイル名・パス）を集める。
    fn collect(arg: &Path) -> Vec<(String, String, String, PathBuf)> {
        if arg.is_file() {
            let name = arg
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            return vec![(String::new(), String::new(), name, arg.to_path_buf())];
        }
        let folder = arg
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut found = Vec::new();
        for kind in ["marks", "ratings"] {
            let Ok(entries) = fs::read_dir(arg.join(kind)) else {
                continue;
            };
            let mut files: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
                .collect();
            files.sort();
            for path in files {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                found.push((folder.clone(), kind.to_string(), name, path));
            }
        }
        found
    }

    pub fn run() -> Result<(), String> {
        let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
        if args.is_empty() {
            return Err("使い方: survey <半荘のフォルダ または PNG>...".to_string());
        }
        let worker = OcrWorker::start().map_err(|e| e.to_string())?;
        for arg in &args {
            for (folder, kind, name, path) in collect(arg) {
                let (width, height) = png_size(&path).unwrap_or((0, 0));
                let legacy = worker.read_center_variants_in_the_box(&path);
                let tight = worker.read_center_outcome(&path);
                let mut line = format!(
                    "{{\"folder\":{},\"kind\":{},\"file\":{},\"width\":{width},\"height\":{height}",
                    json_string(&folder),
                    json_string(&kind),
                    json_string(&name)
                );
                match legacy {
                    Ok(readings) => {
                        let _ = write!(line, ",\"box\":{}", json_readings(&readings));
                    }
                    Err(e) => {
                        let _ = write!(line, ",\"box_error\":{}", json_string(&e.to_string()));
                    }
                }
                match tight {
                    Ok(outcome) => {
                        let located = match outcome.located {
                            Some(c) => format!("[{},{},{},{}]", c.x, c.y, c.width, c.height),
                            None => "null".to_string(),
                        };
                        let _ = write!(
                            line,
                            ",\"located\":{located},\"tight\":{}",
                            json_readings(&outcome.readings)
                        );
                    }
                    Err(e) => {
                        let _ = write!(line, ",\"tight_error\":{}", json_string(&e.to_string()));
                    }
                }
                line.push('}');
                println!("{line}");
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    if let Err(message) = tool::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows の日本語の文字認識が要るので、Windows でだけ動く。");
}
