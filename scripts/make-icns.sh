#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
IN_PNG="$ROOT_DIR/build/icon.png"
ICONSET_DIR="$ROOT_DIR/build/AppIcon.iconset"
OUT_ICNS="$ROOT_DIR/build/icon.icns"

if [[ ! -f "$IN_PNG" ]]; then
  echo "Place a 1024x1024 PNG at build/icon.png first." >&2
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

sizes=(
  16 32 64 128 256 512 1024
)

echo "Generating iconset from $IN_PNG ..."
for size in "${sizes[@]}"; do
  if [[ $size -le 512 ]]; then
    sips -z $size $size "$IN_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  fi
  # @2x versions up to 512x512@2x
  if [[ $size -le 512 ]]; then
    doubled=$((size * 2))
    sips -z $doubled $doubled "$IN_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null || true
  fi
done

echo "Converting to .icns ..."
iconutil -c icns "$ICONSET_DIR" -o "$OUT_ICNS"

echo "Created $OUT_ICNS"

