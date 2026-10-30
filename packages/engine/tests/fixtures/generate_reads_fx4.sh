#!/bin/sh
# reads-fx4.json: FX-4（reports/5b821c8a048ff791.json）の読みの本物の出力。解析エンジン jantama-engine（コミット 0099bbf）と tenpai.onnx（sha256 50893ddc…）で作った。
# 作り直し（リポジトリのルートから）: JANTAMA_MODEL_DIR=<tenpai.onnx のあるフォルダ> sh packages/engine/tests/fixtures/generate_reads_fx4.sh
set -eu
(cd apps/desktop/src-tauri/engine && cargo build --release)
apps/desktop/src-tauri/engine/target/release/jantama-engine read \
  --report packages/engine/tests/fixtures/reports/5b821c8a048ff791.json \
  --model "$JANTAMA_MODEL_DIR/tenpai.onnx" \
  --out packages/engine/tests/fixtures/reads-fx4.json
