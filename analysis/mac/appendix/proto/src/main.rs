//! macOS 版の調べで作った、型検査だけ通した確かめ用のプログラム（実機では未実行）。製品のコードではない。
//!
//! Mac で `cargo run -- <サブコマンド>` として動かして、作る前に分かっておきたいことを確かめる:
//!
//! - `perm`: 3 つの許可（アクセシビリティ・入力の監視・画面収録）の状態を出す。
//! - `windows [語]...`: 画面に出ている窓（手前から順）と、題名に語を含むものを出す。題名が空なら画面収録の許可が無い。
//! - `tap [秒] [--swallow 番号]`: マウスのボタン番号とキーコードを、指定の秒数（既定 20）だけ出す。
//!   `--swallow 3` で、そのボタンを横取りする（ブラウザで「戻る」が働かなくなるかを確かめる）。
//! - `shot <語> <出力.png>`: 題名に語を含む窓の長方形を 1 枚だけ撮って PNG に書く。撮影にかかった時間と画像の大きさを出す。
//! - `ocr <画像.png>`: Vision で日本語を読み、行を上から順に出す。かかった時間も出す。
//!
//! ターミナルから動かすので、許可は「ターミナル」（Terminal・iTerm・VS Code など）に付ける。対局中には動かさない。

#[cfg(target_os = "macos")]
mod capture_mac;
#[cfg(target_os = "macos")]
mod hook_mac;
#[cfg(target_os = "macos")]
mod ocr_mac;

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS 専用の確かめ用プログラムです。");
}

#[cfg(target_os = "macos")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("perm") => perm(),
        Some("windows") => windows(&args[1..]),
        Some("tap") => tap(&args[1..]),
        Some("shot") => shot(&args[1..]),
        Some("ocr") => ocr(&args[1..]),
        _ => eprintln!("使い方: perm | windows [語]... | tap [秒] [--swallow 番号] | shot <語> <出力.png> | ocr <画像.png>"),
    }
}

#[cfg(target_os = "macos")]
fn perm() {
    println!(
        "アクセシビリティ（横取りに要る）: {}",
        hook_mac::accessibility_granted()
    );
    println!(
        "入力の監視（聞くだけなら要る）  : {}",
        hook_mac::listen_access_granted()
    );
    println!(
        "画面収録（撮影と窓の題名に要る）: {}",
        capture_mac::screen_capture_granted()
    );
}

#[cfg(target_os = "macos")]
fn windows(words: &[String]) {
    let list = capture_mac::list_windows(std::process::id() as i64);
    let lowered: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    let mut titled = 0;
    for (index, w) in list.iter().enumerate() {
        if !w.title.is_empty() {
            titled += 1;
        }
        let hit = !lowered.is_empty()
            && lowered
                .iter()
                .any(|word| w.title.to_lowercase().contains(word));
        println!(
            "{index:3} {} 層={} pid={} 位置=({:.0},{:.0}) 大きさ={:.0}x{:.0} 題名={:?}",
            if hit { "*" } else { " " },
            w.layer,
            w.owner_pid,
            w.bounds.0,
            w.bounds.1,
            w.bounds.2,
            w.bounds.3,
            w.title
        );
    }
    println!("窓 {} 件、題名のあるもの {titled} 件", list.len());
    if titled == 0 {
        println!("題名が 1 つも読めません。画面収録の許可が無いと、ほかのアプリの窓の題名は空になります。");
    }
}

#[cfg(target_os = "macos")]
fn tap(args: &[String]) {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let seconds = args
        .first()
        .and_then(|a| a.parse::<u64>().ok())
        .unwrap_or(20);
    let swallow = args
        .iter()
        .position(|a| a == "--swallow")
        .and_then(|i| args.get(i + 1))
        .and_then(|n| n.parse::<i64>().ok());
    let (tx, rx) = mpsc::channel();
    let decide = move |heard: &hook_mac::Heard| match (heard, swallow) {
        (hook_mac::Heard::MouseDown(b) | hook_mac::Heard::MouseUp(b), Some(n)) => b.number() == n,
        _ => false,
    };
    if let Err(e) = hook_mac::start(tx, decide) {
        eprintln!("タップを作れません: {e}");
        return;
    }
    println!("{seconds} 秒間、聞きます。マウスの横のボタン・中ボタン・キーを押してください。");
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(seconds) {
        if let Ok(heard) = rx.recv_timeout(Duration::from_millis(200)) {
            println!("{:6} ms  {heard:?}", started.elapsed().as_millis());
        }
    }
}

#[cfg(target_os = "macos")]
fn shot(args: &[String]) {
    use std::time::Instant;

    let (Some(word), Some(out)) = (args.first(), args.get(1)) else {
        eprintln!("使い方: shot <語> <出力.png>");
        return;
    };
    let list = capture_mac::list_windows(std::process::id() as i64);
    let word = word.to_lowercase();
    let Some(window) = list
        .iter()
        .find(|w| w.layer == 0 && w.title.to_lowercase().contains(&word))
    else {
        eprintln!("題名に「{word}」を含む窓が見つかりません（画面収録の許可を確かめてください）");
        return;
    };
    println!("撮る窓: {:?} {:?}", window.title, window.bounds);
    let started = Instant::now();
    let image = match capture_mac::capture_rect(window.bounds) {
        Ok(image) => image,
        Err(e) => {
            eprintln!("撮れませんでした: {e}");
            return;
        }
    };
    let took = started.elapsed();
    let (width, height, bgra) = match capture_mac::bgra_pixels(&image) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    println!("撮影 {} ms、画像 {width}x{height} 画素", took.as_millis());
    let rgb: Vec<u8> = bgra
        .chunks_exact(4)
        .flat_map(|p| [p[2], p[1], p[0]])
        .collect();
    let started = Instant::now();
    let file = std::fs::File::create(out).expect("出力先を開けない");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder
        .write_header()
        .and_then(|mut w| w.write_image_data(&rgb))
        .expect("PNG を書けない");
    println!(
        "PNG の書き出し {} ms → {out}",
        started.elapsed().as_millis()
    );
}

#[cfg(target_os = "macos")]
fn ocr(args: &[String]) {
    use std::time::Instant;

    let Some(path) = args.first() else {
        eprintln!("使い方: ocr <画像.png>");
        return;
    };
    let bytes = std::fs::read(path).expect("画像を読めない");
    let started = Instant::now();
    match ocr_mac::recognize_png(&bytes) {
        Ok(lines) => {
            println!("{} ms", started.elapsed().as_millis());
            for line in lines {
                println!("{line}");
            }
        }
        Err(e) => eprintln!("読めませんでした: {e}"),
    }
}
