#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${1:-8080}"
echo "Starting BadHub local server at http://127.0.0.1:$PORT..."

exec go run -C "$ROOT_DIR" - <<EOF
package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	port := "$PORT"
	fs := http.FileServer(http.Dir("web"))
	http.Handle("/", fs)
	fmt.Printf("BadHub running on http://127.0.0.1:%s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
		os.Exit(1)
	}
}
EOF
