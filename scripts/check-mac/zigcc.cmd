@echo off
rem Use zig cc as the C compiler for macOS targets (for cargo check --target aarch64-apple-darwin).
zig cc -target aarch64-macos %*
