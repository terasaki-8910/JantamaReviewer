//! 保存済みの画像の文字認識（Apple Vision）の雛形。型検査だけ通した。実機では動かしていない。
//!
//! Windows の `ocr/src/winrt.rs`（`OcrEngine`）の「画像を文字認識にかけて、行（上から順）を返す」部分の置き換えにあたる。
//! 切り出し・拡大・コントラスト（`locate`・`resample`・`geometry`）は純粋な計算なので、そのまま使い回す。
//! - 日本語は macOS 13 以降（`VNRecognizeTextRequest` の版 3）。
//! - 入力は PNG のバイト列（切り出した画素を PNG にして渡す。書き出しは `png` クレートで足りる）。
//! - Vision は行の並びを保証しないので、上端の位置（左下が原点）の大きい順に並べ直す。
//! - 対局中に動く部分には入れない（取り込みのときだけ。S-3）。

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

/// 画像（PNG のバイト列）を日本語で読んで、行を上から順に返す。
pub fn recognize_png(png: &[u8]) -> Result<Vec<String>, String> {
    let data = NSData::with_bytes(png);
    let options: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
    // SAFETY: Vision の呼び出し。引数はどれも有効な Objective-C のオブジェクト。
    unsafe {
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        // 言語の補正は切る（数字や「東1局」を、辞書の語に寄せて壊さないため。実機で比べて決める）。
        request.setUsesLanguageCorrection(false);
        request.setRecognitionLanguages(&NSArray::from_retained_slice(&[NSString::from_str(
            "ja-JP",
        )]));
        let as_request: &VNRequest = &request;
        handler
            .performRequests_error(&NSArray::from_slice(&[as_request]))
            .map_err(|e| e.localizedDescription().to_string())?;
        let Some(results) = request.results() else {
            return Ok(Vec::new());
        };
        let mut lines: Vec<(f64, String)> = Vec::new();
        for observation in results.iter() {
            let candidates = observation.topCandidates(1);
            let Some(best) = candidates.firstObject() else {
                continue;
            };
            let top = observation.boundingBox().origin.y + observation.boundingBox().size.height;
            lines.push((top, best.string().to_string()));
        }
        lines.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(lines.into_iter().map(|(_, text)| text).collect())
    }
}
