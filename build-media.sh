#!/usr/bin/env bash
set -euo pipefail

SRC="/Users/logan/Library/Mobile Documents/com~apple~CloudDocs/Music/Screenshots/gutter cleaning media"
OUT="$(cd "$(dirname "$0")" && pwd)/media"
mkdir -p "$OUT"

if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg not found. Install with: brew install ffmpeg" >&2
  exit 1
fi

MAP=(
  "IMG_2069.mov|hero"
  "4 (Changed color).mov|feature"
  "IMG_4895.mov|service-cleaning"
  "IMG_7138.mov|service-downspout"
  "IMG_2595.mov|service-guards"
  "IMG_0856.mov|clip-01"
  "IMG_1361.mov|clip-02"
  "IMG_1362.mov|clip-03"
  "IMG_1435.mov|clip-04"
  "IMG_1486.mov|clip-05"
  "IMG_1491.mov|clip-06"
  "IMG_2592.mov|clip-07"
  "IMG_3671.mov|clip-08"
  "IMG_3770.mov|clip-09"
  "IMG_3933.mov|clip-10"
  "IMG_4769.mov|clip-11"
  "IMG_4808.mov|clip-12"
  "IMG_5015.mov|clip-13"
  "IMG_7136.mov|clip-14"
)

SCALE="scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2"

transcode() {
  local input="$1" base="$2"
  local mp4="$OUT/$base.mp4"
  local jpg="$OUT/$base.jpg"

  if [[ ! -f "$mp4" ]]; then
    echo "  mp4: $base"
    ffmpeg -y -loglevel error -i "$input" \
      -vf "$SCALE" \
      -c:v libx264 -preset medium -crf 26 -pix_fmt yuv420p \
      -c:a aac -b:a 96k \
      -movflags +faststart \
      "$mp4"
  fi

  if [[ ! -f "$jpg" ]]; then
    echo "  jpg: $base"
    if ! ffmpeg -y -loglevel error -ss 1.5 -i "$input" \
      -frames:v 1 -vf "$SCALE" -q:v 3 \
      "$jpg" 2>/dev/null; then
      ffmpeg -y -loglevel error -i "$input" \
        -frames:v 1 -vf "$SCALE" -q:v 3 \
        "$jpg"
    fi
  fi
}

count=0
for entry in "${MAP[@]}"; do
  src="${entry%%|*}"
  dest="${entry##*|}"
  if [[ ! -f "$SRC/$src" ]]; then
    echo "!! missing: $src — skipping"
    continue
  fi
  count=$((count + 1))
  echo "[$count/${#MAP[@]}] $src -> $dest"
  transcode "$SRC/$src" "$dest"
done

echo ""
echo "Output in $OUT:"
ls -1 "$OUT" | sort | awk '{ printf "  %s\n", $0 }'
echo ""
du -sh "$OUT"
