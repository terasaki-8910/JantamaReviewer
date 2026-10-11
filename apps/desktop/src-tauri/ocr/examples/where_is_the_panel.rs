//! 板の文字の位置の探し方を、画像ごとに確かめる道具（手元で動かす。製品には入らない。文字認識は使わないので、どの OS でも動く）:
//! 半荘のフォルダ（`marks/`・`ratings/` の PNG が入っている）か PNG のファイルを引数に取り、画像ごとに、見つけた水色の文字の
//! まとまり（左・上・右・下・水色の画素の数・つながりの数）と、切り出しの長方形を、1 行 1 件の JSON で標準出力に書く。
//! 見つからなければ `"block":null`。画像は読むだけで、書き換えない。保存先のパスは、ここには書かない（引数で渡す）。
//!
//! 使い方（リポジトリの `apps/desktop/src-tauri` から）:
//!
//!     cargo run --release -p jantama-ocr --example where_is_the_panel -- <半荘のフォルダ または PNG>...

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use jantama_ocr::locate::locate;

/// PNG（8 ビットの RGB・RGBA）を、行を詰めた BGRA の並びで読む。
fn load_bgra(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut reader = png::Decoder::new(BufReader::new(file))
        .read_info()
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; reader.output_buffer_size().ok_or("大きすぎる")?];
    let info = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    let channels = match (info.color_type, info.bit_depth) {
        (png::ColorType::Rgb, png::BitDepth::Eight) => 3,
        (png::ColorType::Rgba, png::BitDepth::Eight) => 4,
        other => return Err(format!("想定外の形式: {other:?}")),
    };
    let count = (info.width * info.height) as usize;
    let mut pixels = Vec::with_capacity(count * 4);
    for chunk in buffer[..count * channels].chunks_exact(channels) {
        pixels.extend_from_slice(&[chunk[2], chunk[1], chunk[0], 255]);
    }
    Ok((pixels, info.width, info.height))
}

fn collect(arg: &Path) -> Vec<(String, String, PathBuf)> {
    if arg.is_file() {
        let name = arg
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        return vec![(String::new(), name, arg.to_path_buf())];
    }
    let folder = arg
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut found = Vec::new();
    for kind in ["marks", "ratings"] {
        let Ok(entries) = std::fs::read_dir(arg.join(kind)) else {
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
            found.push((folder.clone(), format!("{kind}/{name}"), path));
        }
    }
    found
}

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.is_empty() {
        eprintln!("使い方: where_is_the_panel <半荘のフォルダ または PNG>...");
        std::process::exit(1);
    }
    for arg in &args {
        for (folder, file, path) in collect(arg) {
            match load_bgra(&path) {
                Ok((pixels, width, height)) => {
                    let started = std::time::Instant::now();
                    let found = locate(&pixels, width, height);
                    let ms = started.elapsed().as_millis();
                    let block = match found {
                        Some(p) => format!(
                            "[{},{},{},{}],\"cyan\":{},\"components\":{},\"crop\":[{},{},{},{}]",
                            p.block.x0,
                            p.block.y0,
                            p.block.x1,
                            p.block.y1,
                            p.block.cyan,
                            p.block.components,
                            p.crop.x,
                            p.crop.y,
                            p.crop.width,
                            p.crop.height
                        ),
                        None => "null".to_string(),
                    };
                    println!(
                        "{{\"folder\":\"{folder}\",\"file\":\"{file}\",\"width\":{width},\"height\":{height},\"ms\":{ms},\"block\":{block}}}"
                    );
                }
                Err(e) => {
                    println!("{{\"folder\":\"{folder}\",\"file\":\"{file}\",\"error\":\"{e}\"}}")
                }
            }
        }
    }
}
