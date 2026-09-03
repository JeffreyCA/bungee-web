#!/usr/bin/env bash
# Builds upstream's native `bungee` CLI at the pinned revision (build/native/bungee)
# for reference renders in bench/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cmake -S "$ROOT/native" -B "$ROOT/build/native" -G Ninja \
  -DFETCHCONTENT_BASE_DIR="$ROOT/build/deps" > /dev/null
cmake --build "$ROOT/build/native" --target bungee_executable
ls -l "$ROOT/build/native/_deps/bungee-build/bungee" 2>/dev/null || find "$ROOT/build/native" -name bungee -type f
