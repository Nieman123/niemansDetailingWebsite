#!/usr/bin/env bash
# Optimize images by converting jpg/jpeg/png to WebP.
# Requires cwebp and ImageMagick (magick or convert).

set -euo pipefail

command -v cwebp >/dev/null 2>&1 || echo "warning: cwebp not found; please install libwebp" >&2

if command -v magick >/dev/null 2>&1; then
  CONVERT=magick
elif command -v convert >/dev/null 2>&1; then
  CONVERT=convert
else
  echo "warning: ImageMagick not found; please install imagemagick" >&2
  CONVERT=""
fi

total_orig=0
total_new=0

process_file() {
  local file="$1"
  local ext="${file##*.}"
  local base="${file%.*}"
  local webp="${base}.webp"
  [ -f "$webp" ] && return 0

  local tmp="$file"
  if [ -n "$CONVERT" ] && [[ "$ext" =~ jpe?g|png ]]; then
    local width=$($CONVERT identify -format %w "$file" 2>/dev/null || echo 0)
    if [ "$width" -gt 2200 ]; then
      tmp=$(mktemp --suffix=.${ext})
      $CONVERT "$file" -resize 2200x2200\> "$tmp" || return 0
    fi
  fi

  local quality=82
  [ "$ext" = "png" ] && quality=80

  local orig_size=$(stat -c%s "$file" 2>/dev/null || echo 0)
  total_orig=$((total_orig + orig_size))

  if cwebp -q $quality -m 6 -metadata none "$tmp" -o "$webp" >/dev/null 2>&1; then
    local new_size=$(stat -c%s "$webp" 2>/dev/null || echo 0)
    total_new=$((total_new + new_size))
    local saved=$((orig_size - new_size))
    echo "Converted $file -> $webp (saved $saved bytes)"
  else
    echo "failed to convert $file" >&2
    rm -f "$webp"
  fi

  [ "$tmp" != "$file" ] && rm -f "$tmp"
}

export -f process_file CONVERT total_orig total_new

find public/images public/images/carpics -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | while read -r img; do
  process_file "$img"
done

if [ $total_orig -gt 0 ]; then
  saved=$((total_orig - total_new))
  echo "Total saved: $saved bytes"
fi

exit 0

