#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Building badhub WebAssembly engine..."
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o "$ROOT_DIR/web/main.wasm" "$ROOT_DIR/cmd/wasm"

WASM_SIZE=$(du -h "$ROOT_DIR/web/main.wasm" | cut -f1)
echo "WebAssembly binary built successfully: web/main.wasm ($WASM_SIZE)"
