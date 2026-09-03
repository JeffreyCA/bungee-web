#!/usr/bin/env bash
# Builds dist/bungee.wasm (SIMD) and, with --all, build/scalar/bungee.wasm for benchmarks.
# Requires emcc (brew install emscripten), cmake >= 3.30, ninja.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/build/deps"

build() {
  local name="$1" simd="$2"
  emcmake cmake -S "$ROOT/native" -B "$ROOT/build/$name" -G Ninja \
    -DBUNGEE_WEB_SIMD="$simd" -DFETCHCONTENT_BASE_DIR="$DEPS" > /dev/null
  cmake --build "$ROOT/build/$name" --target bungee_web
}

build simd ON
mkdir -p "$ROOT/dist"
cp "$ROOT/build/simd/bungee.wasm" "$ROOT/dist/bungee.wasm"
ls -l "$ROOT/dist/bungee.wasm"

if [[ "${1:-}" == "--all" ]]; then
  build scalar OFF
  ls -l "$ROOT/build/scalar/bungee.wasm"
fi
